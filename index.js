import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, MessageFlags } from 'discord.js';
import { CONFIG, AVAILABLE_MODELS, CURRENT_MODEL, setCurrentModel, SYSTEM_PROMPT, saveConfig, setSystemPrompt, getChannelPrompt, setChannelPrompt, clearChannelPrompt, listChannelPrompts } from './lib/config.js';
import { loadBlacklist, isUserBlacklisted, addBlacklist, removeBlacklist, listBlacklist } from './lib/blacklist.js';
import { buildChannelContext } from './lib/context.js';
import { generateAnswer } from './lib/ai.js';
import { withTyping, sendAIResponse, sendAIError, buildAIEmbeds } from './lib/respond.js';
import { registerSlashCommands } from './commands.js';
import fs from 'node:fs';
import path from 'node:path';

// --- Préparation config / migrations ---
const CONFIG_DIR = path.join(process.cwd(), 'config');
const CONFIG_FILE_PATH = path.join(CONFIG_DIR, 'config.json');
try { if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR); } catch {}
try {
  const legacy = path.join(process.cwd(), 'config.json');
  if (fs.existsSync(legacy) && !fs.existsSync(CONFIG_FILE_PATH)) {
    fs.renameSync(legacy, CONFIG_FILE_PATH);
    console.log('[migration] config.json déplacé vers config/config.json');
  }
} catch (e) { console.warn('Migration config.json impossible', e); }

// --- Variables runtime dérivées de CONFIG ---
let ADMIN_USER_IDS = (Array.isArray(CONFIG.whitelistAdminUserIds) ? CONFIG.whitelistAdminUserIds : []).map(s => String(s).trim()).filter(Boolean);
const ADMIN_ROLE_IDS = (Array.isArray(CONFIG.whitelistAdminRoleIds) ? CONFIG.whitelistAdminRoleIds : []).map(s => String(s).trim()).filter(Boolean);
let WHITELIST = (Array.isArray(CONFIG.whitelistChannelIds) ? CONFIG.whitelistChannelIds : (process.env.WHITELIST_CHANNEL_IDS || '').split(',')).map(s => String(s).trim()).filter(Boolean);

let MAX_ANSWER_CHARS = (()=>{ const raw=CONFIG.maxAnswerCharsPerMessage; return (typeof raw==='number')? Math.max(500,Math.min(4000,raw)) : 4000; })();
if (MAX_ANSWER_CHARS !== CONFIG.maxAnswerCharsPerMessage) { CONFIG.maxAnswerCharsPerMessage = MAX_ANSWER_CHARS; saveConfig(); }
let ENABLE_CHANNEL_CONTEXT = typeof CONFIG.enableChannelContext === 'boolean' ? CONFIG.enableChannelContext : true;
let CHANNEL_CONTEXT_LIMIT = (typeof CONFIG.channelContextMessageLimit === 'number' && CONFIG.channelContextMessageLimit > 0) ? Math.min(25, CONFIG.channelContextMessageLimit) : 6;
if (CHANNEL_CONTEXT_LIMIT !== CONFIG.channelContextMessageLimit) { CONFIG.channelContextMessageLimit = CHANNEL_CONTEXT_LIMIT; saveConfig(); }
let CHANNEL_CONTEXT_THREAD_LIMIT = (typeof CONFIG.channelContextThreadMessageLimit === 'number' && CONFIG.channelContextThreadMessageLimit > 0) ? Math.min(100, CONFIG.channelContextThreadMessageLimit) : 30;
if (CHANNEL_CONTEXT_THREAD_LIMIT !== CONFIG.channelContextThreadMessageLimit) { CONFIG.channelContextThreadMessageLimit = CHANNEL_CONTEXT_THREAD_LIMIT; saveConfig(); }
let DEBUG_MODE = !!CONFIG.debug;
let CHANNEL_CONTEXT_MAX_OVERRIDE = (typeof CONFIG.channelContextMaxOverride === 'number' && CONFIG.channelContextMaxOverride > 0) ? Math.min(50, CONFIG.channelContextMaxOverride) : 20;
if (CHANNEL_CONTEXT_MAX_OVERRIDE !== CONFIG.channelContextMaxOverride) { CONFIG.channelContextMaxOverride = CHANNEL_CONTEXT_MAX_OVERRIDE; saveConfig(); }
let CHANNEL_CONTEXT_AUTO_FORGET_MS = (typeof CONFIG.channelContextAutoForgetSeconds === 'number' && CONFIG.channelContextAutoForgetSeconds > 0)
  ? Math.min(24*3600, CONFIG.channelContextAutoForgetSeconds) * 1000 : 0;
if ((CHANNEL_CONTEXT_AUTO_FORGET_MS/1000) !== CONFIG.channelContextAutoForgetSeconds) { CONFIG.channelContextAutoForgetSeconds = CHANNEL_CONTEXT_AUTO_FORGET_MS/1000; saveConfig(); }
let CHANNEL_CONTEXT_MESSAGE_MAX_AGE_MS = (typeof CONFIG.channelContextMessageMaxAgeSeconds === 'number' && CONFIG.channelContextMessageMaxAgeSeconds >= 60)
  ? Math.min(86400, CONFIG.channelContextMessageMaxAgeSeconds) * 1000 : 3600*1000;
if ((CHANNEL_CONTEXT_MESSAGE_MAX_AGE_MS/1000) !== CONFIG.channelContextMessageMaxAgeSeconds) { CONFIG.channelContextMessageMaxAgeSeconds = CHANNEL_CONTEXT_MESSAGE_MAX_AGE_MS/1000; saveConfig(); }
let REQUIRE_MENTION_OR_REPLY = typeof CONFIG.requireMentionOrReply === 'boolean' ? CONFIG.requireMentionOrReply : true;
if (REQUIRE_MENTION_OR_REPLY !== CONFIG.requireMentionOrReply) { CONFIG.requireMentionOrReply = REQUIRE_MENTION_OR_REPLY; saveConfig(); }

// --- Etats mémoire ---
const channelLastContextUsage = new Map();

// --- Helpers ---
function isAdmin(userId, member) {
  if (ADMIN_USER_IDS.includes(userId)) return true;
  try { if (member && member.roles && member.roles.cache) { if (ADMIN_ROLE_IDS.some(r => member.roles.cache.has(r))) return true; } } catch {}
  return false;
}

// --- Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, async () => {
  console.log(`[ready] Connecté en tant que ${client.user.tag}`);
  try { await registerSlashCommands(client); } catch (e) { console.error('Erreur registerSlashCommands', e); }
  try { loadBlacklist(); } catch (e) { console.error('Erreur chargement blacklist', e); }
});

// --- MessageCreate ---
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild) return; // ignore DM
    if (message.author?.bot || message.system) return;
    if (isUserBlacklisted(message.author.id)) return;
    if (WHITELIST.length && !WHITELIST.includes(message.channel.id)) return;

    const botId = client.user.id;
    const mentioned = message.mentions.has(botId);
  // Nouvelle logique: si option active on exige la mention explicite uniquement (les replies seules ne déclenchent plus)
  if (REQUIRE_MENTION_OR_REPLY && !mentioned) return;

    // Question utilisateur (strip mention)
    let userQuestion = (message.content || '').replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
    if (!userQuestion) userQuestion = '(Message vide)';

    if (DEBUG_MODE) {
      console.log('[debug][trigger]', {
        user: `${message.author.tag} (${message.author.id})`,
        channel: message.channel.id,
        length: userQuestion.length,
        contextEnabled: ENABLE_CHANNEL_CONTEXT,
  requireMentionOrReply: REQUIRE_MENTION_OR_REPLY
      });
    }

    const answerResult = await withTyping(message.channel, async () => {
      // Contexte
      let channelContext = '';
      let allowContext = true;
      if (CHANNEL_CONTEXT_AUTO_FORGET_MS > 0) {
        const lastTs = channelLastContextUsage.get(message.channel.id) || 0;
        if (Date.now() - lastTs > CHANNEL_CONTEXT_AUTO_FORGET_MS) allowContext = false;
      }
      if (allowContext && ENABLE_CHANNEL_CONTEXT) {
        try {
          channelContext = await buildChannelContext({
            channel: message.channel,
            uptoMessageId: message.id,
            overrideLimit: null,
            limit: CHANNEL_CONTEXT_LIMIT,
            threadLimit: CHANNEL_CONTEXT_THREAD_LIMIT,
            maxOverride: CHANNEL_CONTEXT_MAX_OVERRIDE,
            botId,
            maxAgeMs: CHANNEL_CONTEXT_MESSAGE_MAX_AGE_MS
          });
          channelLastContextUsage.set(message.channel.id, Date.now());
        } catch (e) { if (DEBUG_MODE) console.log('[debug][context][error]', e); }
      }
  const channelPrompt = getChannelPrompt(message.channel.id);
  return generateAnswer({ userQuestion, channelContext, debug: DEBUG_MODE, systemPromptOverride: channelPrompt });
    });

    if (!answerResult.ok) {
      await sendAIError({ channel: message.channel, error: answerResult.error, ms: answerResult.ms, model: CURRENT_MODEL });
      return;
    }
  await sendAIResponse({ channel: message.channel, text: answerResult.text, ms: answerResult.ms, model: CURRENT_MODEL, maxChars: MAX_ANSWER_CHARS, debug: DEBUG_MODE });

  } catch (err) {
    console.error('Erreur messageCreate', err);
    try { await message.reply({ content: 'Erreur interne.', allowedMentions: { repliedUser: false } }); } catch {}
  }
});

// --- InteractionCreate (slash commands) ---
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Slash command blacklist
    if (interaction.isChatInputCommand()) {
  // Log exécution commande (avant permission pour audit)
  let subName = ''; try { subName = interaction.options.getSubcommand(); } catch {}
  try { console.log(`[slash] cmd=/${interaction.commandName}${subName?` sub=${subName}`:''} user=${interaction.user.tag} (${interaction.user.id})`); } catch {}
    if (interaction.commandName === 'ask') {
      const question = interaction.options.getString('texte', true).trim();
      const modelOpt = interaction.options.getString('model');
      const publicFlag = interaction.options.getBoolean('public') || false;
      const useContext = interaction.options.getBoolean('usecontext') || false;
  // Cohérence contexte: on réutilise exactement buildChannelContext avec mêmes limites
  // que pour un ping (CHANNEL_CONTEXT_LIMIT, CHANNEL_CONTEXT_MAX_OVERRIDE).
  // Pour une interaction slash, pas de message déclencheur -> uptoMessageId:null.
      let chosenModel = CURRENT_MODEL;
      if (modelOpt && AVAILABLE_MODELS.includes(modelOpt)) chosenModel = modelOpt;
      await interaction.deferReply({ ephemeral: !publicFlag });
      try {
        const answerResult = await withTyping(interaction.channel, async () => {
          let channelContext = '';
          if (useContext && ENABLE_CHANNEL_CONTEXT) {
            try {
              channelContext = await buildChannelContext({
                channel: interaction.channel,
                uptoMessageId: null, // interaction pas liée à message spécifique
                overrideLimit: null,
                limit: CHANNEL_CONTEXT_LIMIT,
                threadLimit: CHANNEL_CONTEXT_THREAD_LIMIT,
                maxOverride: CHANNEL_CONTEXT_MAX_OVERRIDE,
                botId: interaction.client.user.id,
                maxAgeMs: CHANNEL_CONTEXT_MESSAGE_MAX_AGE_MS
              });
            } catch (e) { if (DEBUG_MODE) console.log('[debug][ask][context][error]', e); }
          }
          const channelPrompt = getChannelPrompt(interaction.channel.id);
          return generateAnswer({ userQuestion: question, channelContext, debug: DEBUG_MODE, modelOverride: chosenModel, systemPromptOverride: channelPrompt });
        });
        if (!answerResult.ok) {
          await interaction.editReply({ content: `Erreur: ${answerResult.error}` });
        } else {
          const embeds = buildAIEmbeds({ client: interaction.client, text: answerResult.text, model: chosenModel, maxChars: MAX_ANSWER_CHARS, debug: DEBUG_MODE, ms: answerResult.ms });
          await interaction.editReply({ embeds });
        }
      } catch (e) {
        await interaction.editReply({ content: 'Erreur interne.' });
      }
      return;
    }
    if (interaction.commandName === 'blacklist') {
  if (!isAdmin(interaction.user.id, interaction.member)) {
          await interaction.reply({ content: 'Non autorisé.', flags: MessageFlags.Ephemeral });
          return;
        }
        const sub = interaction.options.getSubcommand();
        if (sub === 'add') {
          const user = interaction.options.getUser('utilisateur', true);
          if (isUserBlacklisted(user.id)) {
            await interaction.reply({ content: `${user} est déjà blacklist.`, flags: MessageFlags.Ephemeral });
            return;
          }
      addBlacklist(user.id);
      await interaction.reply({ content: `${user} ajouté à la blacklist.`, flags: MessageFlags.Ephemeral });
      return;
        } else if (sub === 'remove') {
          const user = interaction.options.getUser('utilisateur', true);
          if (!isUserBlacklisted(user.id)) {
            await interaction.reply({ content: `${user} n'est pas blacklist.`, flags: MessageFlags.Ephemeral });
            return;
          }
      removeBlacklist(user.id);
      await interaction.reply({ content: `${user} retiré de la blacklist.`, flags: MessageFlags.Ephemeral });
      return;
        } else if (sub === 'list') {
      const users = listBlacklist();
          const display = users.length ? users.map(id => `<@${id}>`).join(', ') : 'Aucun';
          await interaction.reply({ content: `Blacklist (${users.length}): ${display}`, flags: MessageFlags.Ephemeral });
          return;
        }
      }
      if (interaction.commandName === 'prompt') {
        if (!CONFIG.enablePromptCommand) {
          await interaction.reply({ content: 'La commande /prompt est désactivée.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (!isAdmin(interaction.user.id, interaction.member)) {
          await interaction.reply({ content: 'Non autorisé.', flags: MessageFlags.Ephemeral });
          return;
        }
        let sub;
        try { sub = interaction.options.getSubcommand(); } catch {}
        if (sub === 'show') {
          const display = SYSTEM_PROMPT.length > 1800 ? SYSTEM_PROMPT.slice(0, 1800) + '…' : SYSTEM_PROMPT;
          await interaction.reply({ content: `Prompt actuel (${SYSTEM_PROMPT.length} chars):\n${display}`, flags: MessageFlags.Ephemeral });
          return;
        }
        if (sub === 'set') {
          const texte = interaction.options.getString('texte', true).trim();
          if (!texte) { await interaction.reply({ content: 'Prompt vide.', flags: MessageFlags.Ephemeral }); return; }
          setSystemPrompt(texte);
          await interaction.reply({ content: 'Prompt système mis à jour.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({ content: 'Sous-commande inconnue.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.commandName === 'channelprompt') {
        if (!isAdmin(interaction.user.id, interaction.member)) {
          await interaction.reply({ content: 'Non autorisé.', flags: MessageFlags.Ephemeral });
          return;
        }
        let sub = '';
        try { sub = interaction.options.getSubcommand(); } catch {}
        if (sub === 'show') {
          const cp = getChannelPrompt(interaction.channel.id);
          if (!cp) { await interaction.reply({ content: 'Aucun prompt défini pour ce salon.', flags: MessageFlags.Ephemeral }); return; }
          const display = cp.length > 1800 ? cp.slice(0,1800) + '…' : cp;
          await interaction.reply({ content: `Prompt salon (${cp.length} chars):\n${display}`, flags: MessageFlags.Ephemeral });
          return;
        }
        if (sub === 'set') {
          const texte = interaction.options.getString('texte', true).trim();
          if (!texte) { await interaction.reply({ content: 'Prompt vide.', flags: MessageFlags.Ephemeral }); return; }
          setChannelPrompt(interaction.channel.id, texte);
          await interaction.reply({ content: 'Prompt salon enregistré.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (sub === 'clear') {
          if (clearChannelPrompt(interaction.channel.id)) {
            await interaction.reply({ content: 'Prompt salon supprimé.', flags: MessageFlags.Ephemeral });
          } else {
            await interaction.reply({ content: 'Aucun prompt à supprimer.', flags: MessageFlags.Ephemeral });
          }
          return;
        }
        if (sub === 'list') {
          const list = listChannelPrompts();
          if (!list.length) { await interaction.reply({ content: 'Aucun salon avec prompt.', flags: MessageFlags.Ephemeral }); return; }
            const lines = list.slice(0,50).map(e=>`<#${e.channelId}> (${e.channelId}) : ${e.length} chars`);
            await interaction.reply({ content: `Prompts salons (${list.length}):\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.reply({ content: 'Sous-commande inconnue.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.commandName === 'options') {
        if (!isAdmin(interaction.user.id, interaction.member)) {
          await interaction.reply({ content: 'Non autorisé.', flags: MessageFlags.Ephemeral });
          return;
        }
  // options legacy supprimées
  const newMaxChars = interaction.options.getInteger('maxanswerchars');
        const newModel = interaction.options.getString('model');
  const newEnableChanCtx = interaction.options.getBoolean('enablechannelcontext');
  const newChanCtxLimit = interaction.options.getInteger('channelcontextlimit');
  const newChanCtxThreadLimit = interaction.options.getInteger('channelcontextthreadlimit');
  const newDebugLog = interaction.options.getBoolean('debug');
        const newChanCtxMaxOverride = interaction.options.getInteger('channelcontextmaxoverride');
        const newChanCtxAutoForget = interaction.options.getInteger('channelcontextautoforget');
  const newRequireMention = interaction.options.getBoolean('requiremention');
  const newChanCtxMaxAge = interaction.options.getInteger('channelcontextmaxage');
  if (newMaxChars === null && !newModel && newEnableChanCtx === null && newChanCtxLimit === null && newChanCtxThreadLimit === null && newDebugLog === null && newChanCtxMaxOverride === null && newChanCtxAutoForget === null && newRequireMention === null && newChanCtxMaxAge === null) {
          await interaction.reply({ content: `Valeurs actuelles:\n- maxAnswerCharsPerMessage: ${MAX_ANSWER_CHARS}\n- enableChannelContext: ${ENABLE_CHANNEL_CONTEXT}\n- channelContextMessageLimit: ${CHANNEL_CONTEXT_LIMIT}\n- channelContextMaxOverride: ${CHANNEL_CONTEXT_MAX_OVERRIDE}\n- channelContextAutoForgetSeconds: ${CHANNEL_CONTEXT_AUTO_FORGET_MS/1000}\n- channelContextMessageMaxAgeSeconds: ${CHANNEL_CONTEXT_MESSAGE_MAX_AGE_MS/1000}\n- requireMentionOrReply: ${REQUIRE_MENTION_OR_REPLY}\n- debug: ${DEBUG_MODE}\n- currentModel: ${CURRENT_MODEL}\n- availableModels: ${AVAILABLE_MODELS.join(', ')}` , flags: MessageFlags.Ephemeral });
          return;
        }
        const summary = [];
        if (newEnableChanCtx !== null) {
          ENABLE_CHANNEL_CONTEXT = newEnableChanCtx;
          CONFIG.enableChannelContext = newEnableChanCtx;
          summary.push(`enableChannelContext => ${newEnableChanCtx}`);
        }
        if (newRequireMention !== null) {
          REQUIRE_MENTION_OR_REPLY = newRequireMention;
          CONFIG.requireMentionOrReply = newRequireMention;
          summary.push(`requireMentionOrReply => ${newRequireMention}`);
        }
        if (typeof newMaxChars === 'number') {
          const clamped = Math.max(500, Math.min(4000, newMaxChars));
          MAX_ANSWER_CHARS = clamped;
          CONFIG.maxAnswerCharsPerMessage = clamped;
          summary.push(`maxAnswerCharsPerMessage => ${clamped}` + (clamped !== newMaxChars ? ' (ajusté)' : ''));
        }
        if (typeof newChanCtxLimit === 'number') {
          const safe = Math.max(1, Math.min(25, newChanCtxLimit));
          CHANNEL_CONTEXT_LIMIT = safe;
          CONFIG.channelContextMessageLimit = safe;
          summary.push(`channelContextMessageLimit => ${safe}` + (safe !== newChanCtxLimit ? ' (ajusté)' : ''));
        }
        if (typeof newChanCtxThreadLimit === 'number') {
          const safe = Math.max(1, Math.min(100, newChanCtxThreadLimit));
          CHANNEL_CONTEXT_THREAD_LIMIT = safe;
          CONFIG.channelContextThreadMessageLimit = safe;
          summary.push(`channelContextThreadMessageLimit => ${safe}` + (safe !== newChanCtxThreadLimit ? ' (ajusté)' : ''));
        }
        if (typeof newChanCtxMaxOverride === 'number') {
          const safe = Math.max(1, Math.min(50, newChanCtxMaxOverride));
          CHANNEL_CONTEXT_MAX_OVERRIDE = safe;
          CONFIG.channelContextMaxOverride = safe;
          summary.push(`channelContextMaxOverride => ${safe}` + (safe !== newChanCtxMaxOverride ? ' (ajusté)' : ''));
        }
        if (typeof newChanCtxAutoForget === 'number') {
          const safeSec = Math.max(0, Math.min(86400, newChanCtxAutoForget));
          CHANNEL_CONTEXT_AUTO_FORGET_MS = safeSec * 1000;
          CONFIG.channelContextAutoForgetSeconds = safeSec;
          summary.push(`channelContextAutoForgetSeconds => ${safeSec}` + (safeSec !== newChanCtxAutoForget ? ' (ajusté)' : ''));
        }
        if (typeof newChanCtxMaxAge === 'number') {
          const safeSec = Math.max(60, Math.min(86400, newChanCtxMaxAge));
          CHANNEL_CONTEXT_MESSAGE_MAX_AGE_MS = safeSec * 1000;
          CONFIG.channelContextMessageMaxAgeSeconds = safeSec;
          summary.push(`channelContextMessageMaxAgeSeconds => ${safeSec}` + (safeSec !== newChanCtxMaxAge ? ' (ajusté)' : ''));
        }
        if (newModel) {
          if (setCurrentModel(newModel)) {
            summary.push(`model => ${CURRENT_MODEL}`);
          } else {
            summary.push(`model => valeur inconnue (${newModel}) ignorée`);
          }
        }
        if (newDebugLog !== null) {
          DEBUG_MODE = newDebugLog;
          CONFIG.debug = newDebugLog;
          summary.push(`debug => ${newDebugLog}`);
        }
        saveConfig();
        await interaction.reply({ content: `Options mises à jour:\n${summary.join('\n')}`, flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.commandName === 'op') {
        if (!isAdmin(interaction.user.id, interaction.member)) {
          await interaction.reply({ content: 'Non autorisé.', flags: MessageFlags.Ephemeral });
          return;
        }
  const sub = interaction.options.getSubcommand();
        if (sub === 'add') {
          const user = interaction.options.getUser('utilisateur', true);
          const uid = String(user.id);
          if (ADMIN_USER_IDS.includes(uid)) {
            await interaction.reply({ content: `${user} est déjà admin.`, flags: MessageFlags.Ephemeral });
            return;
          }
          ADMIN_USER_IDS.push(uid);
          CONFIG.whitelistAdminUserIds = Array.from(new Set(ADMIN_USER_IDS));
          saveConfig();
          await interaction.reply({ content: `${user} ajouté aux admins.`, flags: MessageFlags.Ephemeral });
          return;
        } else if (sub === 'remove') {
          const user = interaction.options.getUser('utilisateur', true);
            const uid = String(user.id);
            if (!ADMIN_USER_IDS.includes(uid)) {
              await interaction.reply({ content: `${user} n'est pas admin.`, flags: MessageFlags.Ephemeral });
              return;
            }
            ADMIN_USER_IDS = ADMIN_USER_IDS.filter(id => id !== uid);
            CONFIG.whitelistAdminUserIds = ADMIN_USER_IDS;
            saveConfig();
            await interaction.reply({ content: `${user} retiré des admins.`, flags: MessageFlags.Ephemeral });
            return;
        } else if (sub === 'list') {
          const list = ADMIN_USER_IDS.length ? ADMIN_USER_IDS.map(id => `<@${id}>`).join(', ') : 'Aucun';
          await interaction.reply({ content: `Admins utilisateurs (${ADMIN_USER_IDS.length}): ${list}`, flags: MessageFlags.Ephemeral });
          return;
        }
      }
      if (interaction.commandName === 'whitelistchannels') {
        if (!isAdmin(interaction.user.id, interaction.member)) {
          await interaction.reply({ content: 'Non autorisé.', flags: MessageFlags.Ephemeral });
          return;
        }
        const sub = interaction.options.getSubcommand();
        if (sub === 'add') {
          const ch = interaction.options.getChannel('salon', true);
          const id = ch.id;
          if (WHITELIST.includes(id)) {
            await interaction.reply({ content: `${ch} déjà dans la whitelist.`, flags: MessageFlags.Ephemeral });
            return;
          }
          WHITELIST.push(id);
          CONFIG.whitelistChannelIds = WHITELIST;
          saveConfig();
          await interaction.reply({ content: `${ch} ajouté à la whitelist.`, flags: MessageFlags.Ephemeral });
          return;
        } else if (sub === 'remove') {
          const ch = interaction.options.getChannel('salon', true);
          const id = ch.id;
            if (!WHITELIST.includes(id)) {
              await interaction.reply({ content: `${ch} n'est pas dans la whitelist.`, flags: MessageFlags.Ephemeral });
              return;
            }
            WHITELIST = WHITELIST.filter(c => c !== id);
            CONFIG.whitelistChannelIds = WHITELIST;
            saveConfig();
            await interaction.reply({ content: `${ch} retiré de la whitelist.`, flags: MessageFlags.Ephemeral });
            return;
        } else if (sub === 'list') {
          if (!WHITELIST.length) {
            await interaction.reply({ content: 'Whitelist vide (tous les salons autorisés).', flags: MessageFlags.Ephemeral });
            return;
          }
          const display = WHITELIST.map(id => `<#${id}>`).join(', ');
          await interaction.reply({ content: `Salons whitelists (${WHITELIST.length}): ${display}`, flags: MessageFlags.Ephemeral });
          return;
        }
      }
      if (interaction.commandName === 'resetcontext') {
        if (!isAdmin(interaction.user.id, interaction.member)) {
          await interaction.reply({ content: 'Non autorisé.', flags: MessageFlags.Ephemeral });
          return;
        }
        const all = interaction.options.getBoolean('all') || false;
        let cleared = 0;
        if (all) {
          cleared = channelLastContextUsage.size;
          channelLastContextUsage.clear();
        } else {
          if (channelLastContextUsage.delete(interaction.channelId)) cleared++;
        }
        await interaction.reply({ content: `Contexte réinitialisé (${all?'global':'salon'}) – entrées effacées: ${cleared}.`, flags: MessageFlags.Ephemeral });
        return;
      }
      return; // autre commande ignorée
    }

  // Aucun bouton géré désormais
  if (!interaction.isButton()) return;
  return;
  } catch (e) {
    console.error('Erreur InteractionCreate', e);
    try {
      if (interaction.isRepliable() && !interaction.replied) {
        await interaction.editReply('Erreur interne pendant le traitement du bouton.');
      }
    } catch {}
  }
});

// Lancement
if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN manquant. Configure .env');
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY manquant. Configure .env');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);

// Handlers globaux pour éviter crash
process.on('unhandledRejection', (reason) => {
  console.error('UnhandledRejection', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UncaughtException', err);
});
