import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, MessageFlags, EmbedBuilder } from 'discord.js';
import { CONFIG, AVAILABLE_MODELS, CURRENT_MODEL, setCurrentModel, SYSTEM_PROMPT, saveConfig, setSystemPrompt } from './lib/config.js';
import { loadBlacklist, isUserBlacklisted, addBlacklist, removeBlacklist, listBlacklist } from './lib/blacklist.js';
import { buildChannelContext } from './lib/context.js';
import { generateAnswer, testGemini } from './lib/ai.js';
import { registerSlashCommands } from './commands.js';
import fs from 'node:fs';
import path from 'node:path';

// --- Config ---
// Fallback modèle si config vide (ensuite géré via config.json)
const ENV_FALLBACK_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-pro';
const DEFAULT_LOCALE = process.env.DEFAULT_LOCALE || 'fr'; // réservé usage futur
// Chargement config depuis ./config/config.json (migration depuis racine si besoin)
const CONFIG_DIR = path.join(process.cwd(), 'config');
const CONFIG_FILE_PATH = path.join(CONFIG_DIR, 'config.json');
try { if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR); } catch {}
// Migration: si ancien config.json à la racine et pas encore dans config/
try {
  const legacy = path.join(process.cwd(), 'config.json');
  if (fs.existsSync(legacy) && !fs.existsSync(CONFIG_FILE_PATH)) {
    fs.renameSync(legacy, CONFIG_FILE_PATH);
    console.log('[migration] config.json déplacé vers config/config.json');
  }
} catch (e) { console.warn('Migration config.json impossible', e); }
// Chargement config déjà effectué dans module config.js

// --- Initialisation modèles IA ---
// (Gestion modèles & prompt fournie par config.js)

// Admins: uniquement via whitelistAdminUserIds / whitelistAdminRoleIds (liste mutable pour /op)
let ADMIN_USER_IDS = (Array.isArray(CONFIG.whitelistAdminUserIds) ? CONFIG.whitelistAdminUserIds : [])
  .map(s => String(s).trim())
  .filter(Boolean);
const ADMIN_ROLE_IDS = (Array.isArray(CONFIG.whitelistAdminRoleIds) ? CONFIG.whitelistAdminRoleIds : [])
  .map(s => String(s).trim())
  .filter(Boolean);
// Whitelist des salons texte (héritage pour les threads)
let WHITELIST = (Array.isArray(CONFIG.whitelistChannelIds) ? CONFIG.whitelistChannelIds : (process.env.WHITELIST_CHANNEL_IDS || '').split(','))
  .map(s => String(s).trim())
  .filter(Boolean);
const CFG_GUILD_ID = CONFIG.guildId || process.env.GUILD_ID;
// enableThreadTransform supprimé
// Activation/désactivation de la commande /prompt via config.json { "enablePromptCommand": true/false } (géré dans commands.js)
// Cooldown (en secondes) entre deux transformations en thread par le même utilisateur
// transformThreadCooldownSeconds supprimé
// Âge max (en minutes) d'un message bot pouvant être transformé en thread (0 ou valeur <=0 = illimité)
// transformThreadMaxMessageAgeMinutes supprimé

// Durée d'auto-archivage configurable (Discord supporte: 60, 1440, 4320, 10080 minutes => 1h, 24h, 3d, 7d)
// Valeurs admises dans config: "1h", "24h", "3d", "1w" (week=7d)
// thread auto-archive (supprimé)

// Limite configurable pour tronquer/splitter les réponses IA en plusieurs messages
// Discord limite à 4000 chars dans un embed description (et 6000 total). On autorise 500-4000.
let MAX_ANSWER_CHARS = (()=>{ const raw=CONFIG.maxAnswerCharsPerMessage; return (typeof raw==='number')? Math.max(500,Math.min(4000,raw)) : 4000; })();
if (MAX_ANSWER_CHARS !== CONFIG.maxAnswerCharsPerMessage) { CONFIG.maxAnswerCharsPerMessage = MAX_ANSWER_CHARS; saveConfig(); }

// Contexte canal (hors thread) : inclusion des derniers messages récents non-bot
let ENABLE_CHANNEL_CONTEXT = typeof CONFIG.enableChannelContext === 'boolean' ? CONFIG.enableChannelContext : true;
let CHANNEL_CONTEXT_LIMIT = (typeof CONFIG.channelContextMessageLimit === 'number' && CONFIG.channelContextMessageLimit > 0) ? Math.min(25, CONFIG.channelContextMessageLimit) : 6;
if (CHANNEL_CONTEXT_LIMIT !== CONFIG.channelContextMessageLimit) { CONFIG.channelContextMessageLimit = CHANNEL_CONTEXT_LIMIT; saveConfig(); }

// Debug prompts (journalisation complète du prompt envoyé à l'API)
let DEBUG_LOG_PROMPTS = !!CONFIG.debugLogPrompts;
let CHANNEL_CONTEXT_MAX_OVERRIDE = (typeof CONFIG.channelContextMaxOverride === 'number' && CONFIG.channelContextMaxOverride > 0) ? Math.min(50, CONFIG.channelContextMaxOverride) : 20;
if (CHANNEL_CONTEXT_MAX_OVERRIDE !== CONFIG.channelContextMaxOverride) { CONFIG.channelContextMaxOverride = CHANNEL_CONTEXT_MAX_OVERRIDE; saveConfig(); }
let CHANNEL_CONTEXT_AUTO_FORGET_MS = (typeof CONFIG.channelContextAutoForgetSeconds === 'number' && CONFIG.channelContextAutoForgetSeconds > 0)
  ? Math.min(24*3600, CONFIG.channelContextAutoForgetSeconds) * 1000
  : 0; // 0 = jamais auto-forget
if ((CHANNEL_CONTEXT_AUTO_FORGET_MS/1000) !== CONFIG.channelContextAutoForgetSeconds) { CONFIG.channelContextAutoForgetSeconds = CHANNEL_CONTEXT_AUTO_FORGET_MS/1000; saveConfig(); }
// Dernier usage par salon (timestamp ms)
const channelLastContextUsage = new Map();

// buildChannelContext déplacé dans lib/context.js

function isChannelAllowed(channel) {
  if (!WHITELIST.length) return true; // pas de restriction
  if (channel.isThread?.()) {
    return WHITELIST.includes(channel.parentId);
  }
  return WHITELIST.includes(channel.id);
}

// Blacklist gérée via ./lib/blacklist.js (migration aussi effectuée là-bas)

function isAdmin(userId, member) {
  if (!ADMIN_USER_IDS.length && !ADMIN_ROLE_IDS.length) return false;
  if (ADMIN_USER_IDS.includes(String(userId))) return true;
  if (member && ADMIN_ROLE_IDS.length) {
    const roles = member.roles?.cache;
    if (roles) for (const rid of ADMIN_ROLE_IDS) if (roles.has(rid)) return true;
  }
  return false;
}

// (SQLite/thread memory supprimé)
// Fonctions IA, commandes et blacklist gérées par modules dédiés

// --- Discord Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message]
});

// Boutons liés aux threads supprimés

// ensureDb supprimé

function isBotMentioned(message) { return message.mentions.has(client.user) || message.mentions.users.some(u => u.id === client.user?.id); }

client.once(Events.ClientReady, () => {
  console.log(`[bot] Connecté en tant que ${client.user.tag}`);
  loadBlacklist();
  registerSlashCommands(client);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
  if (isUserBlacklisted(message.author.id)) return; // utilisateur bloqué
  if (!isChannelAllowed(message.channel)) return; // Hors whitelist

    const botId = client.user?.id;
    const mentioned = botId && message.mentions.users.has(botId);

    // Détection si reply à un message + capture du contenu référencé
    let replyToBot = false;
    let referencedMessage = null;
    if (message.reference?.messageId) {
      try {
        referencedMessage = await message.fetchReference();
        replyToBot = referencedMessage?.author?.id === botId;
      } catch {}
    }

  // Règle: mentionner le bot ou répondre à lui
  if (!mentioned && !replyToBot) return;

    // Commande diagnostic: mention + !diag (DB retirée)
    if (mentioned && message.content.includes('!diag')) {
      const gemStatus = await testGemini();
      const details = [
        `Gemini: ${gemStatus.ok ? 'OK' : 'ERREUR'}${gemStatus.error ? ` (${gemStatus.error})` : gemStatus.sample ? ` (extrait: ${gemStatus.sample})` : ''}`,
        `Node: ${process.version}`,
        `Model: ${CURRENT_MODEL}`
      ].join('\n');
      await message.reply({ content: 'Diagnostic:\n' + details, allowedMentions: { repliedUser: false } });
      return;
    }

    // Texte question en retirant la mention
    let content = message.content;
    if (mentioned) {
      const mentionSyntax = new RegExp(`<@!?${botId}>`,'g');
      content = content.replace(mentionSyntax, '').trim();
    }
    // Extraction éventuelle d'un nombre de surcharge de contexte juste après mention
    let overrideContextCount = null;
    if (mentioned) {
      // Tolérer espaces multiples puis un nombre
      const match = content.match(/^(?:\s*)(\d{1,3})\b/);
      if (match) {
        const n = parseInt(match[1],10);
        if (!isNaN(n) && n > 0) {
          overrideContextCount = Math.min(CHANNEL_CONTEXT_MAX_OVERRIDE, n);
          content = content.slice(match[0].length).trimStart();
        }
      }
    }
    // Si on répond à quelqu'un d'autre que le bot, injecter le message cité comme contexte
    if (referencedMessage && referencedMessage.author?.id !== botId) {
      const original = (referencedMessage.content || '').trim();
      if (original) {
        // On insère un bloc de contexte clair pour le modèle
        content = `Contexte du message cité:\n"""${original}"""\nQuestion: ${content}`;
      }
    }
    if (!content) {
      if (overrideContextCount) {
        content = 'Analyse et synthèse du contexte récent, puis prête une réponse utile.';
      } else {
        return; // aucun texte ni override => on sort
      }
    }

    // Log début interaction IA
    try {
  console.log(`[ai] question user=${message.author.tag} (${message.author.id}) channel=${message.channel.id} len=${content.length}${overrideContextCount?` overrideCtx=${overrideContextCount}`:''}`);
    } catch {}

    let active = true;
    const typingLoop = (async () => {
      while (active) {
        try { await message.channel.sendTyping(); } catch {}
        await new Promise(r => setTimeout(r, 7000));
      }
    })();
    // Contexte channel
    let channelContext = '';
    let allowContext = true;
    if (CHANNEL_CONTEXT_AUTO_FORGET_MS > 0) {
      const lastTs = channelLastContextUsage.get(message.channel.id) || 0;
      const elapsed = Date.now() - lastTs;
      if (elapsed > CHANNEL_CONTEXT_AUTO_FORGET_MS && !overrideContextCount) {
        allowContext = false; // oublié automatiquement
      }
    }
    if (allowContext) {
  try { channelContext = await buildChannelContext({ channel: message.channel, uptoMessageId: message.id, overrideLimit: overrideContextCount, limit: CHANNEL_CONTEXT_LIMIT, maxOverride: CHANNEL_CONTEXT_MAX_OVERRIDE, botId }); } catch {}
      channelLastContextUsage.set(message.channel.id, Date.now());
    }
  const answerResult = await generateAnswer({ userQuestion: content, channelContext, debug: DEBUG_LOG_PROMPTS });
    active = false; await typingLoop.catch(()=>{});

  if (answerResult.ok) { try { console.log(`[ai] answer user=${message.author.id} len=${answerResult.text.length}`); } catch {} } else { try { console.log(`[ai] error user=${message.author.id} err=${answerResult.error}`); } catch {} }

  const components = []; // plus de bouton thread
    try {
      // Découpage si au-delà limite configurée
      if (!answerResult.ok) {
        const embed = new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle('Erreur génération IA')
          .addFields(
            { name: 'Message', value: answerResult.error.slice(0, 1024) },
            { name: 'Durée ms', value: String(answerResult.ms), inline: true },
            { name: 'Modèle', value: CURRENT_MODEL, inline: true }
          )
          .setFooter({ text: 'Réessaie plus tard ou modifie ta requête.' })
          .setTimestamp(new Date());
        await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
        return;
      }

      const answer = answerResult.text;
      const chunks = [];
      if (answer.length <= MAX_ANSWER_CHARS) {
        chunks.push(answer);
      } else {
        let remaining = answer;
        while (remaining.length) {
          let slice = remaining.slice(0, MAX_ANSWER_CHARS);
          if (remaining.length > MAX_ANSWER_CHARS) {
            const lastBreak = slice.lastIndexOf('\n');
            const lastDot = slice.lastIndexOf('. ');
            const candidate = Math.max(lastBreak, lastDot);
            if (candidate > MAX_ANSWER_CHARS * 0.5) slice = slice.slice(0, candidate + 1);
          }
          chunks.push(slice);
          remaining = remaining.slice(slice.length).trimStart();
        }
      }
      let firstReplyMessage = null;
      for (let i = 0; i < chunks.length; i++) {
        const part = chunks[i];
        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setAuthor({ name: 'Réponse IA' + (chunks.length > 1 ? ` (partie ${i+1}/${chunks.length})` : ''), iconURL: client.user.displayAvatarURL?.() })
          .setDescription(part)
          .addFields({ name: 'Durée ms', value: String(answerResult.ms), inline: true })
          .setFooter({ text: `Modèle: ${CURRENT_MODEL} • Mentionne de nouveau pour continuer` })
          .setTimestamp(new Date());
        const comps = (i === 0) ? components : [];
        if (i === 0) {
          firstReplyMessage = await message.reply({ embeds: [embed], components: comps, allowedMentions: { repliedUser: false } });
        } else {
          await message.channel.send({ embeds: [embed], components: comps, reply: { messageReference: firstReplyMessage.id }, allowedMentions: { repliedUser: false } });
        }
      }
    } catch (e) { console.error('Erreur envoi réponse', e); }

  } catch (err) {
    console.error('Erreur messageCreate', err);
    try {
      await message.reply({ content: 'Une erreur interne est survenue.', allowedMentions: { repliedUser: false } });
    } catch {}
  }
});

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
        const newDebugLog = interaction.options.getBoolean('debuglogprompts');
        const newChanCtxMaxOverride = interaction.options.getInteger('channelcontextmaxoverride');
        const newChanCtxAutoForget = interaction.options.getInteger('channelcontextautoforget');
        if (newMaxChars === null && !newModel && newEnableChanCtx === null && newChanCtxLimit === null && newDebugLog === null && newChanCtxMaxOverride === null && newChanCtxAutoForget === null) {
          await interaction.reply({ content: `Valeurs actuelles:\n- maxAnswerCharsPerMessage: ${MAX_ANSWER_CHARS}\n- enableChannelContext: ${ENABLE_CHANNEL_CONTEXT}\n- channelContextMessageLimit: ${CHANNEL_CONTEXT_LIMIT}\n- channelContextMaxOverride: ${CHANNEL_CONTEXT_MAX_OVERRIDE}\n- channelContextAutoForgetSeconds: ${CHANNEL_CONTEXT_AUTO_FORGET_MS/1000}\n- debugLogPrompts: ${DEBUG_LOG_PROMPTS}\n- currentModel: ${CURRENT_MODEL}\n- availableModels: ${AVAILABLE_MODELS.join(', ')}` , flags: MessageFlags.Ephemeral });
          return;
        }
        const summary = [];
        if (newEnableChanCtx !== null) {
          ENABLE_CHANNEL_CONTEXT = newEnableChanCtx;
          CONFIG.enableChannelContext = newEnableChanCtx;
          summary.push(`enableChannelContext => ${newEnableChanCtx}`);
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
        if (newModel) {
          if (setCurrentModel(newModel)) {
            summary.push(`model => ${CURRENT_MODEL}`);
          } else {
            summary.push(`model => valeur inconnue (${newModel}) ignorée`);
          }
        }
        if (newDebugLog !== null) {
          DEBUG_LOG_PROMPTS = newDebugLog;
          CONFIG.debugLogPrompts = newDebugLog;
          summary.push(`debugLogPrompts => ${newDebugLog}`);
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
