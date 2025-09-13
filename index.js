import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, ThreadAutoArchiveDuration, MessageFlags, EmbedBuilder, PermissionsBitField, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import sqlite3 from 'sqlite3';
import path from 'node:path';
import fs from 'node:fs';

// --- Config ---
const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-pro';
const DEFAULT_LOCALE = process.env.DEFAULT_LOCALE || 'fr';
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
let CONFIG = {};
const DEFAULT_CONFIG = {
  guildId: '',
  whitelistChannelIds: [],
  whitelistAdminUserIds: [],
  whitelistAdminRoleIds: [],
  enableThreadTransform: true,
  transformThreadCooldownSeconds: 60,
  transformThreadMaxMessageAgeMinutes: 30,
  enablePromptCommand: true,
  systemPrompt: '',
  threadAutoArchiveDuration: '24h'
};
let configNeedsWrite = false;
try {
  const cfgRaw = fs.readFileSync(CONFIG_FILE_PATH, 'utf8');
  CONFIG = JSON.parse(cfgRaw);
  // Compléter les clés manquantes
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (CONFIG[k] === undefined) { CONFIG[k] = DEFAULT_CONFIG[k]; configNeedsWrite = true; }
  }
} catch (e) {
  console.warn('[config] config/config.json introuvable ou invalide, création fichier défaut.');
  CONFIG = { ...DEFAULT_CONFIG };
  configNeedsWrite = true;
}
if (configNeedsWrite) {
  try { fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(CONFIG, null, 2), 'utf8'); console.log('[config] Fichier généré/mis à jour.'); } catch (e) { console.error('Impossible d\'écrire config par défaut', e); }
}

let SYSTEM_PROMPT = (
  CONFIG.systemPrompt ||
  process.env.GEMINI_SYSTEM_PROMPT ||
  `Tu es un assistant IA utile et concis sur un serveur Discord francophone.\n- Si la question est ambiguë, demande une clarification courte.\n- Ne révèle pas de clés ou secrets.\n- Réponses en Markdown léger.`
).trim();
function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify({
      ...CONFIG,
      systemPrompt: SYSTEM_PROMPT
    }, null, 2), 'utf8');
  } catch (e) { console.error('Erreur saveConfig', e); }
}

// Admins: uniquement via whitelistAdminUserIds / whitelistAdminRoleIds (liste mutable pour /op)
let ADMIN_USER_IDS = (Array.isArray(CONFIG.whitelistAdminUserIds) ? CONFIG.whitelistAdminUserIds : [])
  .map(s => String(s).trim())
  .filter(Boolean);
const ADMIN_ROLE_IDS = (Array.isArray(CONFIG.whitelistAdminRoleIds) ? CONFIG.whitelistAdminRoleIds : [])
  .map(s => String(s).trim())
  .filter(Boolean);
// Whitelist des salons texte (héritage pour les threads)
const WHITELIST = (Array.isArray(CONFIG.whitelistChannelIds) ? CONFIG.whitelistChannelIds : (process.env.WHITELIST_CHANNEL_IDS || '').split(','))
  .map(s => String(s).trim())
  .filter(Boolean);
const CFG_GUILD_ID = CONFIG.guildId || process.env.GUILD_ID;
let ENABLE_THREAD_TRANSFORM = (typeof CONFIG.enableThreadTransform === 'boolean') ? CONFIG.enableThreadTransform : true;
// Activation/désactivation de la commande /prompt via config.json { "enablePromptCommand": true/false }
const ENABLE_PROMPT_COMMAND = (typeof CONFIG.enablePromptCommand === 'boolean') ? CONFIG.enablePromptCommand : true;
// Cooldown (en secondes) entre deux transformations en thread par le même utilisateur
let TRANSFORM_THREAD_COOLDOWN_MS = (
  typeof CONFIG.transformThreadCooldownSeconds === 'number' && CONFIG.transformThreadCooldownSeconds >= 0
    ? CONFIG.transformThreadCooldownSeconds
    : 60 // défaut 60s
) * 1000;
// Âge max (en minutes) d'un message bot pouvant être transformé en thread (0 ou valeur <=0 = illimité)
let TRANSFORM_THREAD_MAX_MESSAGE_AGE_MS = (
  typeof CONFIG.transformThreadMaxMessageAgeMinutes === 'number' && CONFIG.transformThreadMaxMessageAgeMinutes > 0
    ? CONFIG.transformThreadMaxMessageAgeMinutes
    : 30 // défaut 30 minutes
) * 60 * 1000;

// Durée d'auto-archivage configurable (Discord supporte: 60, 1440, 4320, 10080 minutes => 1h, 24h, 3d, 7d)
// Valeurs admises dans config: "1h", "24h", "3d", "1w" (week=7d)
let THREAD_AUTO_ARCHIVE_DURATION = ThreadAutoArchiveDuration.OneDay;
const THREAD_AUTO_ARCHIVE_MAP = {
  '1h': ThreadAutoArchiveDuration.OneHour,
  '24h': ThreadAutoArchiveDuration.OneDay,
  '3d': ThreadAutoArchiveDuration.ThreeDays,
  '1w': ThreadAutoArchiveDuration.OneWeek
};
function setThreadAutoArchiveFromKey(key) {
  const k = String(key || '').trim().toLowerCase();
  if (THREAD_AUTO_ARCHIVE_MAP[k] !== undefined) {
    THREAD_AUTO_ARCHIVE_DURATION = THREAD_AUTO_ARCHIVE_MAP[k];
    CONFIG.threadAutoArchiveDuration = k; // persiste dans config lors de saveConfig
    return true;
  }
  return false;
}
try { setThreadAutoArchiveFromKey(CONFIG.threadAutoArchiveDuration || '24h'); } catch (e) { console.warn('threadAutoArchiveDuration invalide, utilisation défaut 24h'); }

function isChannelAllowed(channel) {
  if (!WHITELIST.length) return true; // pas de restriction
  if (channel.isThread?.()) {
    return WHITELIST.includes(channel.parentId);
  }
  return WHITELIST.includes(channel.id);
}

// --- Blacklist JSON ---
// Blacklist désormais dans config/blacklist.json (migration depuis racine)
const BLACKLIST_PATH = path.join(CONFIG_DIR, 'blacklist.json');
try {
  const legacyBl = path.join(process.cwd(), 'blacklist.json');
  if (fs.existsSync(legacyBl) && !fs.existsSync(BLACKLIST_PATH)) {
    fs.renameSync(legacyBl, BLACKLIST_PATH);
    console.log('[migration] blacklist.json déplacé vers config/blacklist.json');
  }
} catch (e) { console.warn('Migration blacklist.json impossible', e); }
let blacklistCache = new Set();

function loadBlacklist() {
  try {
    if (!fs.existsSync(BLACKLIST_PATH)) {
      fs.writeFileSync(BLACKLIST_PATH, JSON.stringify({ users: [] }, null, 2), 'utf8');
    }
    const raw = fs.readFileSync(BLACKLIST_PATH, 'utf8');
    const data = JSON.parse(raw);
    blacklistCache = new Set((data.users || []).map(String));
  } catch (e) {
    console.error('Erreur chargement blacklist', e);
    blacklistCache = new Set();
  }
}

function saveBlacklist() {
  try {
    const data = { users: Array.from(blacklistCache) };
    fs.writeFileSync(BLACKLIST_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Erreur sauvegarde blacklist', e);
  }
}

function isUserBlacklisted(userId) {
  return blacklistCache.has(String(userId));
}

function isAdmin(userId, member) {
  if (!ADMIN_USER_IDS.length && !ADMIN_ROLE_IDS.length) return false;
  if (ADMIN_USER_IDS.includes(String(userId))) return true;
  if (member && ADMIN_ROLE_IDS.length) {
    const roles = member.roles?.cache;
    if (roles) for (const rid of ADMIN_ROLE_IDS) if (roles.has(rid)) return true;
  }
  return false;
}

async function registerSlashCommands() {
  // Construction des commandes (ajouter ici pour centraliser)
  const commands = [];
  const blacklistCmd = new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('Gérer la blacklist IA')
    .addSubcommand(sc => sc.setName('add').setDescription('Ajouter un utilisateur').addUserOption(o => o.setName('utilisateur').setDescription('Utilisateur').setRequired(true)))
    .addSubcommand(sc => sc.setName('remove').setDescription('Retirer un utilisateur').addUserOption(o => o.setName('utilisateur').setDescription('Utilisateur').setRequired(true)))
    .addSubcommand(sc => sc.setName('list').setDescription('Lister les utilisateurs blacklists'));
  commands.push(blacklistCmd);
  if (ENABLE_PROMPT_COMMAND) {
    const promptCmd = new SlashCommandBuilder()
      .setName('prompt')
      .setDescription('Gérer le system prompt')
      .addSubcommand(sc => sc.setName('show').setDescription('Afficher le prompt système actuel'))
      .addSubcommand(sc => sc.setName('set').setDescription('Définir un nouveau prompt système').addStringOption(o => o.setName('texte').setDescription('Nouveau prompt système').setRequired(true).setMaxLength(1800)));
    commands.push(promptCmd);
  } else {
    console.log('[slash] /prompt désactivé par configuration (enablePromptCommand=false)');
  }
  // Commande options (admin) pour basculer des flags et valeurs numériques
  const optionsCmd = new SlashCommandBuilder()
    .setName('options')
    .setDescription('Met à jour des options IA (admin)')
    .addBooleanOption(o => o.setName('enablethreadtransform').setDescription('Activer le bouton Transformer en thread'))
    .addIntegerOption(o => o.setName('transformthreadcooldownseconds').setDescription('Cooldown global utilisateur (secondes, 0=off, >=0)').setMinValue(0).setMaxValue(86400))
    .addStringOption(o => o
      .setName('threadautoarchiveduration')
      .setDescription('Durée auto-archivage threads (1h,24h,3d,1w)')
      .addChoices(
        { name: '1h', value: '1h' },
        { name: '24h', value: '24h' },
        { name: '3d', value: '3d' },
        { name: '1w', value: '1w' }
      )
    );
  commands.push(optionsCmd);
  // Commande /op pour gérer les admins utilisateurs
  const opCmd = new SlashCommandBuilder()
    .setName('op')
    .setDescription('Gérer la liste des admins utilisateurs')
    .addSubcommand(sc => sc.setName('add').setDescription('Ajouter un utilisateur admin').addUserOption(o => o.setName('utilisateur').setDescription('Utilisateur').setRequired(true)))
    .addSubcommand(sc => sc.setName('remove').setDescription('Retirer un utilisateur admin').addUserOption(o => o.setName('utilisateur').setDescription('Utilisateur').setRequired(true)))
    .addSubcommand(sc => sc.setName('list').setDescription('Lister les utilisateurs admin')); 
  commands.push(opCmd);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const scope = CFG_GUILD_ID ? `guild:${CFG_GUILD_ID}` : 'global';
  const names = commands.map(c => `/${c.name}`).join(', ');
  const started = Date.now();
  console.log(`[slash] Début enregistrement scope=${scope} total=${commands.length} -> ${names}`);
  try {
    const route = CFG_GUILD_ID ? Routes.applicationGuildCommands(client.user.id, CFG_GUILD_ID) : Routes.applicationCommands(client.user.id);
    const body = commands.map(c => c.toJSON());
    const data = await rest.put(route, { body });
    const ms = Date.now() - started;
    if (Array.isArray(data)) {
      // Log détaillé (nom + id Discord renvoyé)
      data.forEach(d => {
        if (d?.name && d?.id) console.log(`[slash] ✔ ${d.name} id=${d.id}`);
      });
    }
    console.log(`[slash] Enregistrement terminé (${scope}) en ${ms}ms` + (scope === 'global' ? ' (propagation globale ~1h possible)' : ''));
  } catch (e) {
    console.error(`[slash] Échec enregistrement scope=${scope}`, e);
  }
}

// --- SQLite Setup ---
// Base SQLite aussi déplacée dans config/
const DB_PATH = path.join(CONFIG_DIR, 'memory.db');
try {
  const legacyDb = path.join(process.cwd(), 'memory.db');
  if (fs.existsSync(legacyDb) && !fs.existsSync(DB_PATH)) {
    fs.renameSync(legacyDb, DB_PATH);
    console.log('[migration] memory.db déplacé vers config/memory.db');
  }
} catch (e) { console.warn('Migration memory.db impossible', e); }
let db;
function initDb() {
  return new Promise((resolve, reject) => {
    const sqlite = sqlite3.verbose();
    db = new sqlite.Database(DB_PATH, (err) => {
      if (err) return reject(err);
      db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS memory (\n          thread_id TEXT NOT NULL,\n          role TEXT NOT NULL,\n            content TEXT NOT NULL,\n            ts INTEGER NOT NULL\n        );`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memory_thread_ts ON memory(thread_id, ts);`);
  db.run(`CREATE TABLE IF NOT EXISTS thread_meta (\n          thread_id TEXT PRIMARY KEY,\n          owner_id TEXT NOT NULL,\n          locked INTEGER DEFAULT 0,\n          created_ts INTEGER NOT NULL\n        );`);
  db.run(`CREATE TABLE IF NOT EXISTS thread_transform_log (\n          message_id TEXT NOT NULL,\n          user_id TEXT NOT NULL,\n          thread_id TEXT NOT NULL,\n          ts INTEGER NOT NULL,\n          PRIMARY KEY(message_id, user_id)\n        );`);
        resolve();});
    });
  });
}

function addMessage(threadId, role, content) {
  return new Promise((resolve, reject) => {
    db.run(`INSERT INTO memory (thread_id, role, content, ts) VALUES (?, ?, ?, ?)`, [threadId, role, content, Date.now()], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function getThreadMemory(threadId, limit = 15) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT role, content FROM memory WHERE thread_id = ? ORDER BY ts DESC LIMIT ?`, [threadId, limit], (err, rows) => {
      if (err) return reject(err);
      resolve(rows.reverse());
    });
  });
}

// --- Thread Meta Helpers ---
function setThreadOwner(threadId, ownerId) {
  return new Promise((resolve, reject) => {
    db.run(`INSERT INTO thread_meta(thread_id, owner_id, locked, created_ts) VALUES(?,?,0,?)\n      ON CONFLICT(thread_id) DO UPDATE SET owner_id=excluded.owner_id`, [threadId, ownerId, Date.now()], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function getThreadMeta(threadId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT thread_id, owner_id, locked FROM thread_meta WHERE thread_id = ?`, [threadId], (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function lockThreadMeta(threadId) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE thread_meta SET locked = 1 WHERE thread_id = ?`, [threadId], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function setThreadUnlocked(threadId) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE thread_meta SET locked = 0 WHERE thread_id = ?`, [threadId], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function recordTransform(messageId, userId, threadId) {
  return new Promise((resolve, reject) => {
    db.run(`INSERT OR IGNORE INTO thread_transform_log(message_id,user_id,thread_id,ts) VALUES(?,?,?,?)`, [messageId, userId, threadId, Date.now()], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function hasUserTransformed(messageId, userId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT thread_id FROM thread_transform_log WHERE message_id = ? AND user_id = ?`, [messageId, userId], (err, row) => {
      if (err) return reject(err);
      resolve(!!row);
    });
  });
}

function getLastTransformTs(userId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT ts FROM thread_transform_log WHERE user_id = ? ORDER BY ts DESC LIMIT 1`, [userId], (err, row) => {
      if (err) return reject(err);
      resolve(row ? row.ts : null);
    });
  });
}

async function syncThreadLock(thread) {
  try {
    if (!thread?.isThread?.()) return;
    await ensureDb();
    const meta = await getThreadMeta(thread.id);
    const discordLocked = thread.locked || thread.archived;
    if (discordLocked && meta && !meta.locked) {
      await lockThreadMeta(thread.id);
    } else if (!discordLocked && meta?.locked) {
      await setThreadUnlocked(thread.id);
    }
  } catch (e) {
    console.error('syncThreadLock error', e);
  }
}

// --- Gemini Setup ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

async function generateAnswer({ threadId, userQuestion }) {
  try {
    const history = threadId ? await getThreadMemory(threadId) : [];
  const prior = history.map(h => `${h.role.toUpperCase()}: ${h.content}`).join('\n');
  const prompt = [SYSTEM_PROMPT, prior ? prior : '', `UTILISATEUR: ${userQuestion}`, 'ASSISTANT:'].filter(Boolean).join('\n\n');
    const model = genAI.getGenerativeModel({ model: MODEL });

    const result = await withTimeout(model.generateContent(prompt), 25000, 'Délai de génération dépassé');
    const response = result.response.text();
    return (response || '').trim() || 'Réponse vide reçue.';
  } catch (e) {
    console.error('Erreur generateAnswer', e);
    return 'Une erreur est survenue lors de la génération de la réponse.';
  }
}

async function generateThreadTitle({ question, answer }) {
  try {
    const model = genAI.getGenerativeModel({ model: MODEL });
    const prompt = `Génère un titre très court (5-7 mots max) en français, descriptif et neutre pour une discussion sur Discord basée sur la question et la réponse suivantes.\n- Pas d'émojis.\n- Pas de guillemets.\n- Pas de ponctuation finale.\nQuestion: ${question}\nRéponse: ${answer}\nTitre:`;
    const res = await withTimeout(model.generateContent(prompt), 15000, 'Timeout titre');
    let title = res.response.text().split('\n')[0].trim();
    if (!title) title = question.slice(0, 60);
    title = title.replace(/["'`\n]/g, ' ').replace(/\s+/g, ' ').trim();
    if (title.length > 72) title = title.slice(0, 72).trim();
    return `[IA] ${title}`;
  } catch (e) {
    console.error('Erreur génération titre thread', e);
    return '[IA] Discussion';
  }
}

function withTimeout(promise, ms, label = 'Timeout') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout
  ]);
}

async function testGemini() {
  try {
    if (!process.env.GEMINI_API_KEY) return { ok: false, error: 'CLE API GEMINI absente' };
    const model = genAI.getGenerativeModel({ model: MODEL });
    const r = await model.generateContent('ping');
    const text = r.response.text().slice(0, 40);
    return { ok: true, sample: text };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function testDb() {
  try {
    await ensureDb();
    await addMessage('_probe', 'system', 'probe');
    return new Promise((resolve) => {
      db.get('SELECT 1 as ok FROM memory WHERE thread_id = ? ORDER BY ts DESC LIMIT 1', ['_probe'], (err, row) => {
        if (err) return resolve({ ok: false, error: err.message });
        resolve({ ok: true });
      });
    });
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

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

function buildThreadButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('make-thread')
      .setLabel('Transformer en thread')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildThreadControlButtons(opts = {}) {
  const { locked = false } = opts;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('lock-thread')
      .setLabel(locked ? 'Verrouillé' : 'Verrouiller')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(locked),
    new ButtonBuilder()
      .setCustomId('close-thread')
      .setLabel('Fermer le fil')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(false),
    new ButtonBuilder()
      .setCustomId('delete-thread')
      .setLabel('Supprimer')
      .setStyle(ButtonStyle.Danger)
  );
}

function buildConfirmRow(action) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm-${action}`)
      .setLabel('Confirmer')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('cancel-action')
      .setLabel('Annuler')
      .setStyle(ButtonStyle.Secondary)
  );
}

async function ensureDb() {
  if (!db) await initDb();
}

function isBotMentioned(message) {
  return message.mentions.has(client.user) || message.mentions.users.some(u => u.id === client.user?.id);
}

client.once(Events.ClientReady, () => {
  console.log(`[bot] Connecté en tant que ${client.user.tag}`);
  loadBlacklist();
  registerSlashCommands();
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

    // Contexte thread
    const inThread = !!message.thread || message.channel.isThread?.();
    const threadChannel = inThread ? (message.thread || message.channel) : null;

    // Nouvelle règle: il faut soit mentionner le bot, soit répondre à un de ses messages
    if (!mentioned && !replyToBot) return;

    // Détermination threadId pour mémoire (si thread) sinon null
    const threadId = threadChannel?.id || null;

    // Commande diagnostic: mention + !diag
    if (mentioned && message.content.includes('!diag')) {
      const [dbStatus, gemStatus] = await Promise.all([testDb(), testGemini()]);
      const details = [
        `DB: ${dbStatus.ok ? 'OK' : 'ERREUR'}${dbStatus.error ? ` (${dbStatus.error})` : ''}`,
        `Gemini: ${gemStatus.ok ? 'OK' : 'ERREUR'}${gemStatus.error ? ` (${gemStatus.error})` : gemStatus.sample ? ` (extrait: ${gemStatus.sample})` : ''}`,
        `Node: ${process.version}`,
        `Model: ${MODEL}`
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
    // Si on répond à quelqu'un d'autre que le bot, injecter le message cité comme contexte
    if (referencedMessage && referencedMessage.author?.id !== botId) {
      const original = (referencedMessage.content || '').trim();
      if (original) {
        // On insère un bloc de contexte clair pour le modèle
        content = `Contexte du message cité:\n"""${original}"""\nQuestion: ${content}`;
      }
    }
    if (!content) return; // Rien à répondre

    await ensureDb();

    // Log début interaction IA
    try {
      console.log(`[ai] question user=${message.author.tag} (${message.author.id}) channel=${message.channel.id}${threadId ? ` thread=${threadId}` : ''} len=${content.length}`);
    } catch {}

    let active = true;
    const typingLoop = (async () => {
      while (active) {
        try { await message.channel.sendTyping(); } catch {}
        await new Promise(r => setTimeout(r, 7000));
      }
    })();
    const answer = await generateAnswer({ threadId, userQuestion: content });
    active = false; await typingLoop.catch(()=>{});

  try { console.log(`[ai] answer user=${message.author.id} len=${answer.length}`); } catch {}

    // Sauvegarde mémoire si thread
    if (threadId) {
      try { await addMessage(threadId, 'user', content); } catch (e) { console.error('Erreur save user msg', e); }
      try { await addMessage(threadId, 'assistant', answer); } catch (e) { console.error('Erreur save assistant msg', e); }
    }

  const components = (inThread || !ENABLE_THREAD_TRANSFORM) ? [] : [buildThreadButton()];
    try {
      await message.reply({ content: answer, components, allowedMentions: { repliedUser: false } });
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
            blacklistCache.add(String(user.id));
            saveBlacklist();
            await interaction.reply({ content: `${user} ajouté à la blacklist.`, flags: MessageFlags.Ephemeral });
            return;
        } else if (sub === 'remove') {
          const user = interaction.options.getUser('utilisateur', true);
          if (!isUserBlacklisted(user.id)) {
            await interaction.reply({ content: `${user} n'est pas blacklist.`, flags: MessageFlags.Ephemeral });
            return;
          }
          blacklistCache.delete(String(user.id));
          saveBlacklist();
          await interaction.reply({ content: `${user} retiré de la blacklist.`, flags: MessageFlags.Ephemeral });
          return;
        } else if (sub === 'list') {
          const users = Array.from(blacklistCache);
          const display = users.length ? users.map(id => `<@${id}>`).join(', ') : 'Aucun';
          await interaction.reply({ content: `Blacklist (${users.length}): ${display}`, flags: MessageFlags.Ephemeral });
          return;
        }
      }
      if (interaction.commandName === 'prompt') {
        if (!ENABLE_PROMPT_COMMAND) {
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
          if (!texte) {
            await interaction.reply({ content: 'Prompt vide.', flags: MessageFlags.Ephemeral });
            return;
          }
          SYSTEM_PROMPT = texte;
          CONFIG.systemPrompt = texte;
          saveConfig();
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
        const newEnable = interaction.options.getBoolean('enablethreadtransform');
        const newCooldown = interaction.options.getInteger('transformthreadcooldownseconds');
        const newArchive = interaction.options.getString('threadautoarchiveduration');
        if (newEnable === null && newCooldown === null && !newArchive) {
          const currentCd = Math.round(TRANSFORM_THREAD_COOLDOWN_MS/1000);
          const currentArchiveKey = CONFIG.threadAutoArchiveDuration || '24h';
          await interaction.reply({ content: `Valeurs actuelles:\n- enableThreadTransform: ${ENABLE_THREAD_TRANSFORM}\n- transformThreadCooldownSeconds: ${currentCd}\n- threadAutoArchiveDuration: ${currentArchiveKey}`, flags: MessageFlags.Ephemeral });
          return;
        }
        const summary = [];
        if (newEnable !== null) {
          ENABLE_THREAD_TRANSFORM = newEnable;
          CONFIG.enableThreadTransform = newEnable;
          summary.push(`enableThreadTransform => ${newEnable}`);
        }
        if (typeof newCooldown === 'number') {
          const safe = Math.max(0, newCooldown);
            CONFIG.transformThreadCooldownSeconds = safe;
            TRANSFORM_THREAD_COOLDOWN_MS = safe * 1000;
            summary.push(`transformThreadCooldownSeconds => ${safe}`);
        }
        if (newArchive) {
          if (setThreadAutoArchiveFromKey(newArchive)) {
            summary.push(`threadAutoArchiveDuration => ${newArchive}`);
          } else {
            summary.push(`threadAutoArchiveDuration => valeur invalide (${newArchive}) ignorée`);
          }
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
      return; // autre commande ignorée
    }

    if (!interaction.isButton()) return; // reste: boutons

    // Bloquer les utilisateurs blacklist sur les boutons aussi
    if (isUserBlacklisted(interaction.user.id)) {
      if (!interaction.replied && !interaction.deferred) {
        try { await interaction.reply({ content: 'Tu es blacklisté.', flags: MessageFlags.Ephemeral }); } catch {}
      }
      return;
    }

    // Nouveau: gestion multi-boutons
    if (interaction.customId === 'make-thread') {
      if (!ENABLE_THREAD_TRANSFORM) {
        try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'La création de thread est désactivée.', flags: MessageFlags.Ephemeral }); } catch {}
        return;
      }
      const sourceMessage = interaction.message;
      const parentChannel = sourceMessage.channel;
      // Vérification de l'âge du message (sauf pour admins)
      const isAdminUser = isAdmin(interaction.user.id, interaction.member);
      try {
        if (!isAdminUser && TRANSFORM_THREAD_MAX_MESSAGE_AGE_MS > 0) {
          const ageMs = Date.now() - (sourceMessage.createdTimestamp || 0);
          if (ageMs > TRANSFORM_THREAD_MAX_MESSAGE_AGE_MS) {
            if (!interaction.replied && !interaction.deferred) {
              await interaction.reply({ content: 'Délai expiré (admins exemptés): message trop ancien pour être transformé en thread.', flags: MessageFlags.Ephemeral });
            }
            return;
          }
        }
      } catch (e) { console.error('age check error', e); }
      await syncThreadLock(parentChannel);
      if (!isChannelAllowed(parentChannel)) {
        try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Salon non autorisé.', flags: MessageFlags.Ephemeral }); else if (interaction.deferred) await interaction.editReply({ content: 'Salon non autorisé.', flags: MessageFlags.Ephemeral }); } catch {}
        return;
      }
      try {
        await ensureDb();
        // Vérification cooldown global par utilisateur
  if (!isAdminUser && TRANSFORM_THREAD_COOLDOWN_MS > 0) {
          try {
            const lastTs = await getLastTransformTs(interaction.user.id);
            if (lastTs) {
              const elapsed = Date.now() - lastTs;
              const remain = TRANSFORM_THREAD_COOLDOWN_MS - elapsed;
              if (remain > 0) {
                const secs = Math.ceil(remain / 1000);
                if (!interaction.replied && !interaction.deferred) {
                  await interaction.reply({ content: `Cooldown actif. Réessaie dans ${secs}s.`, flags: MessageFlags.Ephemeral });
                } else if (!interaction.replied) {
                  await interaction.editReply({ content: `Cooldown actif (${secs}s restants).`, flags: MessageFlags.Ephemeral });
                }
                return; // stop
              }
            }
          } catch (e) { console.error('cooldown check error', e); }
        }
        // Vérification unique par message
  if (!isAdminUser && await hasUserTransformed(sourceMessage.id, interaction.user.id)) {
          if(!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Tu as déjà transformé ce message.', flags: MessageFlags.Ephemeral });
          else await interaction.editReply({ content: 'Déjà transformé.', flags: MessageFlags.Ephemeral });
          return;
        }
      } catch(e){ console.error('check transform', e); }
  // On différé directement en éphémère pour que le message final soit privé
  try { if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch {}
      if (!parentChannel.isTextBased()) { if (!interaction.replied) await interaction.editReply('Impossible ici'); return; }
      if (parentChannel.isThread?.()) { if (!interaction.replied) await interaction.editReply('Déjà un thread.'); return; }
      let originalQuestion = '';
      if (sourceMessage.reference?.messageId) { try { const ref = await sourceMessage.fetchReference(); originalQuestion = ref?.content || ''; } catch(e){ console.error('fetchReference', e);} }
      const answerContentRaw = sourceMessage.content;
      const threadName = await generateThreadTitle({ question: originalQuestion || answerContentRaw, answer: answerContentRaw });
  let thread; try { thread = await parentChannel.threads.create({ name: threadName, autoArchiveDuration: THREAD_AUTO_ARCHIVE_DURATION, reason: 'Thread IA' }); } catch(e){ console.error('create thread', e); if(!interaction.replied) await interaction.editReply('Erreur création thread'); return; }
      const owner = interaction.user;
  try { console.log(`[thread] transform user=${owner.tag} (${owner.id}) sourceMsg=${sourceMessage.id} -> thread=${thread?.id || '??'} name="${threadName}"`); } catch {}
      const embed = new EmbedBuilder()
        .setTitle('Conversation IA')
        .setColor(0x5865F2)
        .addFields(
          { name: 'Message initial', value: (originalQuestion || '—').slice(0, 1024) || '—' },
          { name: 'Réponse', value: (answerContentRaw || '—').slice(0, 1024) || '—' },
          { name: 'Commencé par', value: `<@${owner.id}>`, inline: true }
        )
        .setTimestamp(new Date());
      try { await thread.send({ embeds: [embed], components: [buildThreadControlButtons({locked:false})] }); } catch(e){ console.error('send embed', e);}    
      try { await ensureDb(); if (originalQuestion) await addMessage(thread.id,'user',originalQuestion); await addMessage(thread.id,'assistant',answerContentRaw); await setThreadOwner(thread.id, owner.id); await recordTransform(sourceMessage.id, owner.id, thread.id); } catch(e){ console.error('seed meta', e);}    
  // L'auto-archivage est désormais géré par la durée Discord (THREAD_AUTO_ARCHIVE_DURATION)
      if (!interaction.replied) {
        await interaction.editReply({ content: `Thread créé: <#${thread.id}>` });
      } else {
        try { await interaction.followUp({ content: `Thread créé: <#${thread.id}>`, flags: MessageFlags.Ephemeral }); } catch {}
      }
      return;
    }

    if (interaction.customId === 'lock-thread') {
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Confirmer le verrouillage ?', components: [buildConfirmRow('lock')], flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId === 'close-thread') {
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Confirmer la fermeture du fil ?', components: [buildConfirmRow('close')], flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId === 'confirm-lock') {
      const thread = interaction.channel; if (!thread?.isThread?.()) return;
      try { if(!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch {}
      await ensureDb();
      const meta = await getThreadMeta(thread.id);
      const isOwner = meta && meta.owner_id === interaction.user.id;
      const hasPerm = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageThreads);
      if (!isOwner && !hasPerm) { if(!interaction.replied) await interaction.editReply({ content: 'Non autorisé.' }); return; }
      if (meta?.locked) { await interaction.editReply({ content: 'Déjà verrouillé.' }); return; }
      try { await lockThreadMeta(thread.id); await thread.setLocked(true,'lock'); await thread.setArchived(true,'lock'); } catch(e){ console.error('lock', e);} 
      await interaction.editReply({ content: 'Thread verrouillé.' });
      return;
    }
    if (interaction.customId === 'confirm-close') {
      const thread = interaction.channel; if (!thread?.isThread?.()) return;
      try { if(!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch {}
      const isOwner = thread.ownerId === interaction.user.id; // fallback minimal
      const hasPerm = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageThreads);
      if (!isOwner && !hasPerm) { if(!interaction.replied) await interaction.editReply({ content: 'Non autorisé.' }); return; }
      if (thread.archived) { await interaction.editReply({ content: 'Déjà fermé.' }); return; }
      try { await thread.setArchived(true, 'close-thread'); } catch (e) { console.error('close thread', e); if(!interaction.replied) await interaction.editReply({ content: 'Erreur fermeture.' }); return; }
      await interaction.editReply({ content: 'Fil fermé (archivé).', components: [] });
      return;
    }
    if (interaction.customId === 'delete-thread') {
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Confirmer la suppression ?', components: [buildConfirmRow('delete')], flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId === 'confirm-delete') {
      const thread = interaction.channel; if (!thread?.isThread?.()) return;
      try { if(!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch {}
      await ensureDb();
      const meta = await getThreadMeta(thread.id);
      const isOwner = meta && meta.owner_id === interaction.user.id;
      const hasPerm = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageThreads);
      if (!isOwner && !hasPerm) { if(!interaction.replied) await interaction.editReply({ content: 'Non autorisé.' }); return; }
      try { await thread.delete('Suppression par owner'); } catch(e){ console.error('delete', e); if(!interaction.replied) await interaction.editReply({ content: 'Erreur suppression.' }); return; }
      try { if(!interaction.replied) await interaction.editReply({ content: 'Thread supprimé.' }); } catch {}
      return;
    }
    if (interaction.customId === 'cancel-action') {
      // Toujours répondre: interaction bouton fresh => update, sinon editReply
      try {
        if (interaction.isButton()) {
          // update fonctionne pour un ComponentInteraction (même éphémère)
          await interaction.update({ content: 'Action annulée.', components: [] });
        } else if (!interaction.replied) {
          await interaction.reply({ content: 'Action annulée.', flags: MessageFlags.Ephemeral });
        } else {
          await interaction.editReply({ content: 'Action annulée.', components: [] });
        }
      } catch (e) {
        console.error('cancel-action error', e);
        try { if (!interaction.replied) await interaction.reply({ content: 'Annulé.', flags: MessageFlags.Ephemeral }); } catch {}
      }
      return;
    }
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
