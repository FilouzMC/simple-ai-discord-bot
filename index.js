import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, MessageFlags } from 'discord.js';
import { CONFIG, AVAILABLE_MODELS, CURRENT_MODEL, setCurrentModel, SYSTEM_PROMPT, saveConfig, setSystemPrompt } from './lib/config.js';
import { loadBlacklist, isUserBlacklisted, addBlacklist, removeBlacklist, listBlacklist } from './lib/blacklist.js';
import { buildChannelContext } from './lib/context.js';
import { generateAnswer } from './lib/ai.js';
import { withTyping, sendAIResponse, sendAIError } from './lib/respond.js';
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
let DEBUG_MODE = !!CONFIG.debug;
let CHANNEL_CONTEXT_MAX_OVERRIDE = (typeof CONFIG.channelContextMaxOverride === 'number' && CONFIG.channelContextMaxOverride > 0) ? Math.min(50, CONFIG.channelContextMaxOverride) : 20;
if (CHANNEL_CONTEXT_MAX_OVERRIDE !== CONFIG.channelContextMaxOverride) { CONFIG.channelContextMaxOverride = CHANNEL_CONTEXT_MAX_OVERRIDE; saveConfig(); }
let CHANNEL_CONTEXT_AUTO_FORGET_MS = (typeof CONFIG.channelContextAutoForgetSeconds === 'number' && CONFIG.channelContextAutoForgetSeconds > 0)
  ? Math.min(24*3600, CONFIG.channelContextAutoForgetSeconds) * 1000 : 0;
if ((CHANNEL_CONTEXT_AUTO_FORGET_MS/1000) !== CONFIG.channelContextAutoForgetSeconds) { CONFIG.channelContextAutoForgetSeconds = CHANNEL_CONTEXT_AUTO_FORGET_MS/1000; saveConfig(); }
let ENABLE_AUTO_RESPONSE = !!CONFIG.enableAutoResponse;
let AUTO_RESPONSE_MIN_INTERVAL = (typeof CONFIG.autoResponseMinIntervalSeconds === 'number' && CONFIG.autoResponseMinIntervalSeconds >= 30)
  ? Math.min(3600, CONFIG.autoResponseMinIntervalSeconds) : 180;
if (AUTO_RESPONSE_MIN_INTERVAL !== CONFIG.autoResponseMinIntervalSeconds) { CONFIG.autoResponseMinIntervalSeconds = AUTO_RESPONSE_MIN_INTERVAL; saveConfig(); }
let AUTO_RESPONSE_PROB = (typeof CONFIG.autoResponseProbability === 'number') ? Math.min(1, Math.max(0, CONFIG.autoResponseProbability)) : 0.25;
if (AUTO_RESPONSE_PROB !== CONFIG.autoResponseProbability) { CONFIG.autoResponseProbability = AUTO_RESPONSE_PROB; saveConfig(); }

// --- Etats mémoire ---
const channelLastContextUsage = new Map();
const lastAutoResponsePerChannel = new Map();

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
    let replyToBot = false;
    if (message.reference?.messageId) {
      try { const ref = await message.fetchReference(); replyToBot = ref.author?.id === botId; } catch {}
    }

    // AUTO RESPONSE si pas mention / reply direct
    if (!mentioned && !replyToBot) {
      if (ENABLE_AUTO_RESPONSE) {
        try {
          const raw = (message.content || '').trim();
          if (DEBUG_MODE) console.log('[debug][autoResponse][incoming]', { len: raw.length, channel: message.channel.id, sample: raw.slice(0,80) });
          if (raw.length >= 25 && /[a-zA-ZÀ-ÖØ-öø-ÿ!?]/.test(raw)) {
            const now = Date.now();
            const last = lastAutoResponsePerChannel.get(message.channel.id) || 0;
            const elapsed = now - last;
            if (elapsed >= AUTO_RESPONSE_MIN_INTERVAL * 1000) {
              if (Math.random() <= AUTO_RESPONSE_PROB) {
                const answerResult = await withTyping(message.channel, async () => {
                  let miniCtx = '';
                  try { miniCtx = await buildChannelContext({ channel: message.channel, uptoMessageId: message.id, overrideLimit: null, limit: Math.min(4, CHANNEL_CONTEXT_LIMIT), maxOverride: CHANNEL_CONTEXT_MAX_OVERRIDE, botId }); } catch {}
                  const guidanceQuestion = `Analyse ce court échange et propose, si pertinent, un conseil ou clarification utile en UNE ou DEUX phrases maximum. Ne réponds que si tu peux réellement aider sans répéter obvious. Message le plus récent: "${raw.slice(0,280)}"`;
                  return generateAnswer({ userQuestion: guidanceQuestion, channelContext: miniCtx, debug: DEBUG_MODE });
                });
                if (answerResult.ok) {
                  const txt = answerResult.text.trim();
                  if (txt && txt.length <= 350 && !/je suis un modèle|assistant ia/i.test(txt)) {
                    await sendAIResponse({ type: 'suggestion', channel: message.channel, text: txt, ms: answerResult.ms, model: CURRENT_MODEL, maxChars: MAX_ANSWER_CHARS, debug: DEBUG_MODE });
                    lastAutoResponsePerChannel.set(message.channel.id, now);
                  } else if (DEBUG_MODE) { console.log('[debug][autoResponse][filtered]', { ok: answerResult.ok, txtLen: txt.length }); }
                } else if (DEBUG_MODE) { console.log('[debug][autoResponse][genfail]', { error: answerResult.error }); }
              } else if (DEBUG_MODE) { console.log('[debug][autoResponse][skip] probability gate'); }
            } else if (DEBUG_MODE) { console.log('[debug][autoResponse][skip] interval', { elapsedMs: elapsed }); }
          } else if (DEBUG_MODE) { console.log('[debug][autoResponse][skip] heuristique longueur/charset'); }
        } catch {}
      }
      return;
    }

    // Question utilisateur (strip mention)
    let userQuestion = (message.content || '').replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
    if (!userQuestion) userQuestion = '(Message vide)';

    if (DEBUG_MODE) {
      console.log('[debug][trigger]', {
        user: `${message.author.tag} (${message.author.id})`,
        channel: message.channel.id,
        length: userQuestion.length,
        contextEnabled: ENABLE_CHANNEL_CONTEXT,
        autoResponseEnabled: ENABLE_AUTO_RESPONSE
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
            maxOverride: CHANNEL_CONTEXT_MAX_OVERRIDE,
            botId
          });
          channelLastContextUsage.set(message.channel.id, Date.now());
        } catch (e) { if (DEBUG_MODE) console.log('[debug][context][error]', e); }
      }
      return generateAnswer({ userQuestion, channelContext, debug: DEBUG_MODE });
    });

    if (!answerResult.ok) {
      await sendAIError({ channel: message.channel, error: answerResult.error, ms: answerResult.ms, model: CURRENT_MODEL });
      return;
    }
    await sendAIResponse({ type: 'answer', channel: message.channel, text: answerResult.text, ms: answerResult.ms, model: CURRENT_MODEL, maxChars: MAX_ANSWER_CHARS, debug: DEBUG_MODE });

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
      if (interaction.commandName === 'options') {
        if (!isAdmin(interaction.user.id, interaction.member)) {
          await interaction.reply({ content: 'Non autorisé.', flags: MessageFlags.Ephemeral });
          return;
        }
  // options thread supprimées
        const newMaxChars = interaction.options.getInteger('maxanswerchars');
        const newModel = interaction.options.getString('model');
  const newEnableChanCtx = interaction.options.getBoolean('enablechannelcontext');
  const newChanCtxLimit = interaction.options.getInteger('channelcontextlimit');
  const newDebugLog = interaction.options.getBoolean('debug');
        const newChanCtxMaxOverride = interaction.options.getInteger('channelcontextmaxoverride');
        const newChanCtxAutoForget = interaction.options.getInteger('channelcontextautoforget');
        const newEnableAuto = interaction.options.getBoolean('enableautoresponse');
        const newAutoInterval = interaction.options.getInteger('autoresponseinterval');
        const newAutoProb = interaction.options.getNumber('autoresponseprobability');
  if (newMaxChars === null && !newModel && newEnableChanCtx === null && newChanCtxLimit === null && newDebugLog === null && newChanCtxMaxOverride === null && newChanCtxAutoForget === null && newEnableAuto === null && newAutoInterval === null && newAutoProb === null) {
          await interaction.reply({ content: `Valeurs actuelles:\n- maxAnswerCharsPerMessage: ${MAX_ANSWER_CHARS}\n- enableChannelContext: ${ENABLE_CHANNEL_CONTEXT}\n- channelContextMessageLimit: ${CHANNEL_CONTEXT_LIMIT}\n- channelContextMaxOverride: ${CHANNEL_CONTEXT_MAX_OVERRIDE}\n- channelContextAutoForgetSeconds: ${CHANNEL_CONTEXT_AUTO_FORGET_MS/1000}\n- debug: ${DEBUG_MODE}\n- enableAutoResponse: ${ENABLE_AUTO_RESPONSE}\n- autoResponseMinIntervalSeconds: ${AUTO_RESPONSE_MIN_INTERVAL}\n- autoResponseProbability: ${AUTO_RESPONSE_PROB}\n- currentModel: ${CURRENT_MODEL}\n- availableModels: ${AVAILABLE_MODELS.join(', ')}` , flags: MessageFlags.Ephemeral });
          return;
        }
        const summary = [];
        if (newEnableChanCtx !== null) {
          ENABLE_CHANNEL_CONTEXT = newEnableChanCtx;
          CONFIG.enableChannelContext = newEnableChanCtx;
          summary.push(`enableChannelContext => ${newEnableChanCtx}`);
        }
        if (newEnableAuto !== null) {
          ENABLE_AUTO_RESPONSE = newEnableAuto;
          CONFIG.enableAutoResponse = newEnableAuto;
          summary.push(`enableAutoResponse => ${newEnableAuto}`);
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
        if (typeof newAutoInterval === 'number') {
          const safe = Math.max(30, Math.min(3600, newAutoInterval));
          AUTO_RESPONSE_MIN_INTERVAL = safe;
          CONFIG.autoResponseMinIntervalSeconds = safe;
          summary.push(`autoResponseMinIntervalSeconds => ${safe}` + (safe !== newAutoInterval ? ' (ajusté)' : ''));
        }
        if (typeof newAutoProb === 'number') {
          const safe = Math.min(1, Math.max(0, newAutoProb));
          AUTO_RESPONSE_PROB = safe;
          CONFIG.autoResponseProbability = safe;
          summary.push(`autoResponseProbability => ${safe}` + (safe !== newAutoProb ? ' (ajusté)' : ''));
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
          cleared = channelLastContextUsage.size + lastAutoResponsePerChannel.size;
          channelLastContextUsage.clear();
          lastAutoResponsePerChannel.clear();
        } else {
          if (channelLastContextUsage.delete(interaction.channelId)) cleared++;
          if (lastAutoResponsePerChannel.delete(interaction.channelId)) cleared++;
        }
        await interaction.reply({ content: `Contexte réinitialisé (${all?'global':'salon'}) – entrées effacées: ${cleared}.`, flags: MessageFlags.Ephemeral });
        return;
      }
      return; // autre commande ignorée
    }

  if (!interaction.isButton()) return; // aucun bouton restant

    // Bloquer les utilisateurs blacklist sur les boutons aussi
    if (isUserBlacklisted(interaction.user.id)) {
      if (!interaction.replied && !interaction.deferred) {
        try { await interaction.reply({ content: 'Tu es blacklisté.', flags: MessageFlags.Ephemeral }); } catch {}
      }
      return;
    }

  // Plus aucun bouton géré
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
