import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, MessageFlags } from 'discord.js';
import { CONFIG, AVAILABLE_MODELS, CURRENT_MODEL, setCurrentModel, SYSTEM_PROMPT, saveConfig, setSystemPrompt, getChannelPrompt, setChannelPrompt, clearChannelPrompt, listChannelPrompts, getModelRateLimit, listModelRateLimits, setModelRateLimit, clearModelRateLimit } from './lib/config.js';
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
// Réponse uniquement sur mention (option supprimée)
const REQUIRE_MENTION_OR_REPLY = true;
if (CONFIG.requireMentionOrReply !== true) { CONFIG.requireMentionOrReply = true; saveConfig(); }

// --- Auto résumé propre ---
let AUTO_SUMMARY_ENABLED = typeof CONFIG.autoSummaryEnabled === 'boolean' ? CONFIG.autoSummaryEnabled : false;
let AUTO_SUMMARY_IDLE_SECONDS = (typeof CONFIG.autoSummaryIdleSeconds === 'number' && CONFIG.autoSummaryIdleSeconds >= 60) ? Math.min(10800, CONFIG.autoSummaryIdleSeconds) : 1800;
let AUTO_SUMMARY_MIN_MESSAGES = (typeof CONFIG.autoSummaryMinMessages === 'number' && CONFIG.autoSummaryMinMessages >= 3) ? Math.min(500, CONFIG.autoSummaryMinMessages) : 15;
let AUTO_SUMMARY_PROMPT = (typeof CONFIG.autoSummaryPrompt === 'string' && CONFIG.autoSummaryPrompt.trim()) ? CONFIG.autoSummaryPrompt.trim() : 'Résumé.';
let AUTO_SUMMARY_CONTEXT_LIMIT = (typeof CONFIG.autoSummaryContextLimit === 'number' && CONFIG.autoSummaryContextLimit >= 10) ? Math.min(200, CONFIG.autoSummaryContextLimit) : 80;
let AUTO_SUMMARY_MODEL = (typeof CONFIG.autoSummaryModel === 'string') ? CONFIG.autoSummaryModel.trim() : '';
const summaryState = new Map();
const channelLastContextUsage = new Map();
const modelUsage = new Map();

function checkAndRegisterModelUse(model){
  const cfg = getModelRateLimit(model)||{}; const cooldownMs=(cfg.cooldownSeconds||0)*1000; const maxPerHour=cfg.maxPerHour||0; const now=Date.now();
  let entry=modelUsage.get(model); if(!entry){ entry={ lastCallTs:0, window:[] }; modelUsage.set(model, entry); }
  if(cooldownMs>0 && entry.lastCallTs && (now-entry.lastCallTs)<cooldownMs){ const wait=Math.ceil((cooldownMs-(now-entry.lastCallTs))/1000); return { ok:false, reason:`Cooldown actif (${wait}s restants)` }; }
  if(maxPerHour>0){ entry.window = entry.window.filter(ts => (now-ts)<3600_000); if(entry.window.length>=maxPerHour) return { ok:false, reason:`Limite horaire atteinte (${maxPerHour}/h)` }; }
  entry.lastCallTs=now; entry.window.push(now); return { ok:true };
}

async function isAdmin(userId, member, guild){
  if(ADMIN_USER_IDS.includes(userId)) return true;
  try { let rolesCache=member?.roles?.cache; if((!rolesCache||!rolesCache.size)&&guild){ try{ const fresh=await guild.members.fetch(userId); rolesCache=fresh.roles.cache; }catch{} } if(rolesCache&&rolesCache.size){ if(ADMIN_ROLE_IDS.some(r=>rolesCache.has(r))) return true; } } catch(e){ if(DEBUG_MODE) console.log('[debug][isAdmin][error]', e?.message); }
  return false;
}

function scheduleAutoSummary(channel){
  if(!AUTO_SUMMARY_ENABLED) return; const st=summaryState.get(channel.id)||{ lastMessageTs:0,count:0,timeout:null }; if(st.timeout){ clearTimeout(st.timeout); st.timeout=null; }
  st.timeout=setTimeout(()=>{ runChannelSummary(channel,{forced:false}).catch(e=>console.error('[autosummary][error]', e)); }, AUTO_SUMMARY_IDLE_SECONDS*1000).unref?.(); summaryState.set(channel.id, st);
}

async function runChannelSummary(channel,{forced}){
  try {
    if(!channel||!channel.isTextBased?.()) return;
    const st=summaryState.get(channel.id)||{count:0};
    if(!forced){
      if(!AUTO_SUMMARY_ENABLED) return;
      if(st.count < AUTO_SUMMARY_MIN_MESSAGES) return;
    }
    let channelContext='';
    try {
      channelContext = await buildChannelContext({
        channel,
        uptoMessageId:null,
        overrideLimit:null,
        limit:Math.min(AUTO_SUMMARY_CONTEXT_LIMIT, CHANNEL_CONTEXT_LIMIT),
        threadLimit:Math.min(AUTO_SUMMARY_CONTEXT_LIMIT, CHANNEL_CONTEXT_THREAD_LIMIT),
        maxOverride:CHANNEL_CONTEXT_MAX_OVERRIDE,
        botId:channel.client?.user?.id,
        maxAgeMs:CHANNEL_CONTEXT_MESSAGE_MAX_AGE_MS
      });
    } catch(e){ if(DEBUG_MODE) console.log('[debug][summary][context][error]', e); }
    if(!channelContext.trim()) return;
    if (AUTO_SUMMARY_MODEL) {
      const userQuestion = AUTO_SUMMARY_PROMPT + '\n\nCONTEXTE:\n' + channelContext;
      const answerResult = await withTyping(channel, async ()=>{
        const rateCheck=checkAndRegisterModelUse(AUTO_SUMMARY_MODEL || CURRENT_MODEL);
        if(!rateCheck.ok) return { ok:false, error:rateCheck.reason, ms:0 };
        return generateAnswer({ userQuestion, channelContext:'', debug:DEBUG_MODE, systemPromptOverride:null, modelOverride:AUTO_SUMMARY_MODEL });
      });
      if(!answerResult.ok){ if(DEBUG_MODE) console.log('[autosummary][fail]', answerResult.error); return; }
      await sendAIResponse({ channel, text:answerResult.text, ms:answerResult.ms, model:AUTO_SUMMARY_MODEL, maxChars:MAX_ANSWER_CHARS, debug:DEBUG_MODE });
    } else {
      const text = `${AUTO_SUMMARY_PROMPT}\n\n${channelContext}`;
      await withTyping(channel, async () => {
        await sendAIResponse({ channel, text, ms:0, model:'resume', maxChars:MAX_ANSWER_CHARS, debug:DEBUG_MODE });
      });
    }
    summaryState.set(channel.id,{ lastMessageTs:Date.now(), count:0, timeout:null });
  } catch(e){ console.error('[autosummary][run][error]', e); }
}

// --- Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMembers
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
    if (message.author.bot) return;
    if (WHITELIST.length && !WHITELIST.includes(message.channel.id)) return;

    const botId = client.user?.id;
    const mentioned = message.mentions.users.has(botId) || new RegExp(`<@!?${botId}>`).test(message.content || '');
    if (REQUIRE_MENTION_OR_REPLY && !mentioned) return;

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

    // Tracking auto résumé
    try {
      let st = summaryState.get(message.channel.id);
      if (!st) { st = { lastMessageTs: Date.now(), count: 0, timeout: null }; summaryState.set(message.channel.id, st); }
      st.lastMessageTs = Date.now();
      st.count++;
      if (AUTO_SUMMARY_ENABLED) scheduleAutoSummary(message.channel);
    } catch (e) { if (DEBUG_MODE) console.log('[debug][summary][track][error]', e); }

    const answerResult = await withTyping(message.channel, async () => {
      const rateCheck = checkAndRegisterModelUse(CURRENT_MODEL);
      if (!rateCheck.ok) return { ok:false, error: rateCheck.reason, ms:0 };
      let channelContext='';
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
        } catch(e){ if (DEBUG_MODE) console.log('[debug][context][error]', e); }
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
    if (!interaction.isChatInputCommand()) return;
    // Blocage global: utilisateur blacklist n'a accès à aucune commande
    if (isUserBlacklisted(interaction.user.id)) {
      try {
        await interaction.reply({ content: 'Tu es blacklist : aucune commande disponible.', flags: MessageFlags.Ephemeral });
      } catch {}
      return;
    }

    // Logging basique
    let subName = '';
    try { subName = interaction.options.getSubcommand(); } catch {}
    if (DEBUG_MODE) console.log(`[slash] /${interaction.commandName}${subName?` ${subName}`:''} user=${interaction.user.tag} (${interaction.user.id})`);

    // Helper permission
    const ensureAdmin = async () => {
      if (!(await isAdmin(interaction.user.id, interaction.member, interaction.guild))) {
        await interaction.reply({ content: 'Non autorisé.', flags: MessageFlags.Ephemeral });
        return false;
      }
      return true;
    };

    switch (interaction.commandName) {
      case 'ask': {
        const question = interaction.options.getString('texte', true).trim();
        const modelOpt = interaction.options.getString('model');
        const publicFlag = interaction.options.getBoolean('public') || false;
        const useContext = interaction.options.getBoolean('usecontext') || false;
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
                  uptoMessageId: null,
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
            const rateCheck = checkAndRegisterModelUse(chosenModel);
            if (!rateCheck.ok) return { ok:false, error: rateCheck.reason, ms:0 };
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
      case 'forceresume': {
        if (!(await ensureAdmin())) return;
        await interaction.deferReply({ ephemeral: true });
        try {
          await runChannelSummary(interaction.channel, { forced: true });
          await interaction.editReply({ content: 'Bloc résumé (prompt + contexte) envoyé si contexte suffisant.' });
        } catch (e) {
          await interaction.editReply({ content: 'Erreur pendant l\'envoi du bloc résumé.' });
        }
        return;
      }
      case 'blacklist': {
        if (!(await ensureAdmin())) return;
        let subBL=''; try { subBL = interaction.options.getSubcommand(); } catch {}
        if (subBL === 'add') {
          const user = interaction.options.getUser('utilisateur', true);
          if (isUserBlacklisted(user.id)) { await interaction.reply({ content: `${user} déjà blacklist.`, flags: MessageFlags.Ephemeral }); return; }
          addBlacklist(user.id);
          await interaction.reply({ content: `${user} ajouté à la blacklist.`, flags: MessageFlags.Ephemeral });
          return;
        }
        if (subBL === 'remove') {
          const user = interaction.options.getUser('utilisateur', true);
          if (!isUserBlacklisted(user.id)) { await interaction.reply({ content: `${user} n'est pas blacklist.`, flags: MessageFlags.Ephemeral }); return; }
          removeBlacklist(user.id);
          await interaction.reply({ content: `${user} retiré de la blacklist.`, flags: MessageFlags.Ephemeral });
          return;
        }
        if (subBL === 'list') {
          const users = listBlacklist();
          const display = users.length ? users.map(id => `<@${id}>`).join(', ') : 'Aucun';
          await interaction.reply({ content: `Blacklist (${users.length}): ${display}`, flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({ content: 'Sous-commande inconnue.', flags: MessageFlags.Ephemeral });
        return;
      }
      case 'channelprompt': {
        if (!(await ensureAdmin())) return;
        let sub=''; try { sub = interaction.options.getSubcommand(); } catch {}
        if (sub === 'show') {
          const cp = getChannelPrompt(interaction.channel.id);
          if (!cp) { await interaction.reply({ content: 'Aucun prompt défini pour ce salon.', flags: MessageFlags.Ephemeral }); return; }
          const display = cp.length > 1800 ? cp.slice(0,1800)+'…' : cp;
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
      case 'ratelimit': {
        if (!(await ensureAdmin())) return;
        let sub=''; try { sub = interaction.options.getSubcommand(); } catch {}
        const model = interaction.options.getString('model');
        if (sub === 'show') {
          const cfg = getModelRateLimit(model);
          if (!cfg) { await interaction.reply({ content:`Aucune limite pour ${model}.`, flags: MessageFlags.Ephemeral }); return; }
          await interaction.reply({ content:`Limites ${model}: cooldownSeconds=${cfg.cooldownSeconds||0}, maxPerHour=${cfg.maxPerHour||0}`, flags: MessageFlags.Ephemeral }); return;
        }
        if (sub === 'setcooldown') {
          const seconds = interaction.options.getInteger('seconds', true);
          setModelRateLimit(model, { cooldownSeconds: seconds });
          const cfg = getModelRateLimit(model);
          await interaction.reply({ content:`Cooldown ${model} => ${cfg.cooldownSeconds||0}s`, flags: MessageFlags.Ephemeral }); return;
        }
        if (sub === 'setmaxhour') {
          const count = interaction.options.getInteger('count', true);
          setModelRateLimit(model, { maxPerHour: count });
          const cfg = getModelRateLimit(model);
          await interaction.reply({ content:`Max/h ${model} => ${cfg.maxPerHour||0}`, flags: MessageFlags.Ephemeral }); return;
        }
        if (sub === 'clear') {
          if (clearModelRateLimit(model)) { await interaction.reply({ content:`Limites supprimées pour ${model}.`, flags: MessageFlags.Ephemeral }); }
          else { await interaction.reply({ content:`Aucune limite à supprimer pour ${model}.`, flags: MessageFlags.Ephemeral }); }
          return;
        }
        if (sub === 'list') {
          const list = listModelRateLimits();
          if (!list.length) { await interaction.reply({ content:'Aucune limite définie.', flags: MessageFlags.Ephemeral }); return; }
          const lines = list.map(l=>`${l.model}: cooldown=${l.cooldownSeconds||0}s maxPerHour=${l.maxPerHour||0}`);
          await interaction.reply({ content:`Limites modèles (${list.length}):\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral }); return;
        }
        await interaction.reply({ content:'Sous-commande inconnue.', flags: MessageFlags.Ephemeral });
        return;
      }
      case 'options': {
        if (!(await ensureAdmin())) return;
        const newMaxChars = interaction.options.getInteger('maxanswerchars');
        const newModel = interaction.options.getString('model');
        const newEnableChanCtx = interaction.options.getBoolean('enablechannelcontext');
        const newChanCtxLimit = interaction.options.getInteger('channelcontextlimit');
        const newChanCtxThreadLimit = interaction.options.getInteger('channelcontextthreadlimit');
        const newDebugLog = interaction.options.getBoolean('debug');
        const newChanCtxMaxOverride = interaction.options.getInteger('channelcontextmaxoverride');
        const newChanCtxAutoForget = interaction.options.getInteger('channelcontextautoforget');
        const newChanCtxMaxAge = interaction.options.getInteger('channelcontextmaxage');
        const newAutoSummaryEnabled = interaction.options.getBoolean('autosummaryenabled');
        const newAutoSummaryIdle = interaction.options.getInteger('autosummaryidleseconds');
        const newAutoSummaryMin = interaction.options.getInteger('autosummaryminmessages');
        const newAutoSummaryContextLimit = interaction.options.getInteger('autosummarycontextlimit');
  const newAutoSummaryPrompt = interaction.options.getString('resumesetprompt');
  const newAutoSummaryModel = interaction.options.getString('autosummarymodel');
        const showResumePrompt = interaction.options.getBoolean('showresumeprompt');

  if (showResumePrompt || (newMaxChars === null && !newModel && newEnableChanCtx === null && newChanCtxLimit === null && newChanCtxThreadLimit === null && newDebugLog === null && newChanCtxMaxOverride === null && newChanCtxAutoForget === null && newChanCtxMaxAge === null && newAutoSummaryEnabled === null && newAutoSummaryIdle === null && newAutoSummaryMin === null && newAutoSummaryContextLimit === null && !newAutoSummaryPrompt && !newAutoSummaryModel)) {
          await interaction.reply({ content: `Valeurs actuelles:\n- maxAnswerCharsPerMessage: ${MAX_ANSWER_CHARS}\n- enableChannelContext: ${ENABLE_CHANNEL_CONTEXT}\n- channelContextMessageLimit: ${CHANNEL_CONTEXT_LIMIT}\n- channelContextThreadMessageLimit: ${CHANNEL_CONTEXT_THREAD_LIMIT}\n- channelContextMaxOverride: ${CHANNEL_CONTEXT_MAX_OVERRIDE}\n- channelContextAutoForgetSeconds: ${CHANNEL_CONTEXT_AUTO_FORGET_MS/1000}\n- channelContextMessageMaxAgeSeconds: ${CHANNEL_CONTEXT_MESSAGE_MAX_AGE_MS/1000}\n- requireMentionOrReply: ${REQUIRE_MENTION_OR_REPLY}\n- debug: ${DEBUG_MODE}\n- currentModel: ${CURRENT_MODEL}\n- autoSummaryEnabled: ${AUTO_SUMMARY_ENABLED}\n- autoSummaryIdleSeconds: ${AUTO_SUMMARY_IDLE_SECONDS}\n- autoSummaryMinMessages: ${AUTO_SUMMARY_MIN_MESSAGES}\n- autoSummaryContextLimit: ${AUTO_SUMMARY_CONTEXT_LIMIT}\n- autoSummaryModel: ${AUTO_SUMMARY_MODEL||'(aucun)'}\n- resumePromptLength: ${AUTO_SUMMARY_PROMPT.length}\n- availableModels: ${AVAILABLE_MODELS.join(', ')}` , flags: MessageFlags.Ephemeral });
          return;
        }
        const summary = [];
        if (newEnableChanCtx !== null) { ENABLE_CHANNEL_CONTEXT = newEnableChanCtx; CONFIG.enableChannelContext = newEnableChanCtx; summary.push(`enableChannelContext => ${newEnableChanCtx}`); }
        if (typeof newMaxChars === 'number') { const clamped = Math.max(500, Math.min(4000, newMaxChars)); MAX_ANSWER_CHARS = clamped; CONFIG.maxAnswerCharsPerMessage = clamped; summary.push(`maxAnswerCharsPerMessage => ${clamped}` + (clamped !== newMaxChars ? ' (ajusté)' : '')); }
        if (typeof newChanCtxLimit === 'number') { const safe = Math.max(1, Math.min(25, newChanCtxLimit)); CHANNEL_CONTEXT_LIMIT = safe; CONFIG.channelContextMessageLimit = safe; summary.push(`channelContextMessageLimit => ${safe}` + (safe !== newChanCtxLimit ? ' (ajusté)' : '')); }
        if (typeof newChanCtxThreadLimit === 'number') { const safe = Math.max(1, Math.min(100, newChanCtxThreadLimit)); CHANNEL_CONTEXT_THREAD_LIMIT = safe; CONFIG.channelContextThreadMessageLimit = safe; summary.push(`channelContextThreadMessageLimit => ${safe}` + (safe !== newChanCtxThreadLimit ? ' (ajusté)' : '')); }
        if (typeof newChanCtxMaxOverride === 'number') { const safe = Math.max(1, Math.min(50, newChanCtxMaxOverride)); CHANNEL_CONTEXT_MAX_OVERRIDE = safe; CONFIG.channelContextMaxOverride = safe; summary.push(`channelContextMaxOverride => ${safe}` + (safe !== newChanCtxMaxOverride ? ' (ajusté)' : '')); }
        if (typeof newChanCtxAutoForget === 'number') { const safeSec = Math.max(0, Math.min(86400, newChanCtxAutoForget)); CHANNEL_CONTEXT_AUTO_FORGET_MS = safeSec * 1000; CONFIG.channelContextAutoForgetSeconds = safeSec; summary.push(`channelContextAutoForgetSeconds => ${safeSec}` + (safeSec !== newChanCtxAutoForget ? ' (ajusté)' : '')); }
        if (typeof newChanCtxMaxAge === 'number') { const safeSec = Math.max(60, Math.min(86400, newChanCtxMaxAge)); CHANNEL_CONTEXT_MESSAGE_MAX_AGE_MS = safeSec * 1000; CONFIG.channelContextMessageMaxAgeSeconds = safeSec; summary.push(`channelContextMessageMaxAgeSeconds => ${safeSec}` + (safeSec !== newChanCtxMaxAge ? ' (ajusté)' : '')); }
        if (newModel) { if (setCurrentModel(newModel)) summary.push(`model => ${CURRENT_MODEL}`); else summary.push(`model => valeur inconnue (${newModel}) ignorée`); }
        if (newDebugLog !== null) { DEBUG_MODE = newDebugLog; CONFIG.debug = newDebugLog; summary.push(`debug => ${newDebugLog}`); }
        if (newAutoSummaryEnabled !== null) { AUTO_SUMMARY_ENABLED = newAutoSummaryEnabled; CONFIG.autoSummaryEnabled = AUTO_SUMMARY_ENABLED; summary.push(`autoSummaryEnabled => ${AUTO_SUMMARY_ENABLED}`); }
        if (typeof newAutoSummaryIdle === 'number') { const safe = Math.max(60, Math.min(10800, newAutoSummaryIdle)); AUTO_SUMMARY_IDLE_SECONDS = safe; CONFIG.autoSummaryIdleSeconds = safe; summary.push(`autoSummaryIdleSeconds => ${safe}` + (safe !== newAutoSummaryIdle ? ' (ajusté)' : '')); }
        if (typeof newAutoSummaryMin === 'number') { const safe = Math.max(3, Math.min(500, newAutoSummaryMin)); AUTO_SUMMARY_MIN_MESSAGES = safe; CONFIG.autoSummaryMinMessages = safe; summary.push(`autoSummaryMinMessages => ${safe}` + (safe !== newAutoSummaryMin ? ' (ajusté)' : '')); }
        if (typeof newAutoSummaryContextLimit === 'number') { const safe = Math.max(10, Math.min(200, newAutoSummaryContextLimit)); AUTO_SUMMARY_CONTEXT_LIMIT = safe; CONFIG.autoSummaryContextLimit = safe; summary.push(`autoSummaryContextLimit => ${safe}` + (safe !== newAutoSummaryContextLimit ? ' (ajusté)' : '')); }
  if (typeof newAutoSummaryPrompt === 'string' && newAutoSummaryPrompt.trim()) { AUTO_SUMMARY_PROMPT = newAutoSummaryPrompt.trim(); CONFIG.autoSummaryPrompt = AUTO_SUMMARY_PROMPT; summary.push(`autoSummaryPrompt => (len ${AUTO_SUMMARY_PROMPT.length})`); }
  if (typeof newAutoSummaryModel === 'string') { AUTO_SUMMARY_MODEL = newAutoSummaryModel.trim(); CONFIG.autoSummaryModel = AUTO_SUMMARY_MODEL; summary.push(`autoSummaryModel => ${AUTO_SUMMARY_MODEL || '(aucun)'}`); }
        saveConfig();
        await interaction.reply({ content: `Options mises à jour:\n${summary.join('\n')}`, flags: MessageFlags.Ephemeral });
        return;
      }
      case 'op': {
        if (!(await ensureAdmin())) return;
        const sub = interaction.options.getSubcommand();
        if (sub === 'add') {
          const user = interaction.options.getUser('utilisateur', true);
          const uid = String(user.id);
          if (ADMIN_USER_IDS.includes(uid)) { await interaction.reply({ content: `${user} est déjà admin.`, flags: MessageFlags.Ephemeral }); return; }
          ADMIN_USER_IDS.push(uid);
          CONFIG.whitelistAdminUserIds = Array.from(new Set(ADMIN_USER_IDS));
          saveConfig();
          await interaction.reply({ content: `${user} ajouté aux admins.`, flags: MessageFlags.Ephemeral });
          return;
        }
        if (sub === 'remove') {
          const user = interaction.options.getUser('utilisateur', true);
          const uid = String(user.id);
          if (!ADMIN_USER_IDS.includes(uid)) { await interaction.reply({ content: `${user} n'est pas admin.`, flags: MessageFlags.Ephemeral }); return; }
          ADMIN_USER_IDS = ADMIN_USER_IDS.filter(id => id !== uid);
          CONFIG.whitelistAdminUserIds = ADMIN_USER_IDS;
          saveConfig();
          await interaction.reply({ content: `${user} retiré des admins.`, flags: MessageFlags.Ephemeral });
          return;
        }
        if (sub === 'list') {
          const list = ADMIN_USER_IDS.length ? ADMIN_USER_IDS.map(id => `<@${id}>`).join(', ') : 'Aucun';
          await interaction.reply({ content: `Admins utilisateurs (${ADMIN_USER_IDS.length}): ${list}`, flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({ content: 'Sous-commande inconnue.', flags: MessageFlags.Ephemeral });
        return;
      }
      case 'whitelistchannels': {
        if (!(await ensureAdmin())) return;
        const sub = interaction.options.getSubcommand();
        if (sub === 'add') {
          const ch = interaction.options.getChannel('salon', true);
          const id = ch.id;
          if (WHITELIST.includes(id)) { await interaction.reply({ content: `${ch} déjà dans la whitelist.`, flags: MessageFlags.Ephemeral }); return; }
          WHITELIST.push(id);
          CONFIG.whitelistChannelIds = WHITELIST;
          saveConfig();
          await interaction.reply({ content: `${ch} ajouté à la whitelist.`, flags: MessageFlags.Ephemeral });
          return;
        }
        if (sub === 'remove') {
          const ch = interaction.options.getChannel('salon', true);
          const id = ch.id;
          if (!WHITELIST.includes(id)) { await interaction.reply({ content: `${ch} n'est pas dans la whitelist.`, flags: MessageFlags.Ephemeral }); return; }
          WHITELIST = WHITELIST.filter(c => c !== id);
          CONFIG.whitelistChannelIds = WHITELIST;
          saveConfig();
          await interaction.reply({ content: `${ch} retiré de la whitelist.`, flags: MessageFlags.Ephemeral });
          return;
        }
        if (sub === 'list') {
          if (!WHITELIST.length) { await interaction.reply({ content: 'Whitelist vide (tous les salons autorisés).', flags: MessageFlags.Ephemeral }); return; }
          const display = WHITELIST.map(id => `<#${id}>`).join(', ');
          await interaction.reply({ content: `Salons whitelists (${WHITELIST.length}): ${display}`, flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({ content: 'Sous-commande inconnue.', flags: MessageFlags.Ephemeral });
        return;
      }
      case 'resetcontext': {
        if (!(await ensureAdmin())) return;
        const all = interaction.options.getBoolean('all') || false;
        let cleared = 0;
        if (all) { cleared = channelLastContextUsage.size; channelLastContextUsage.clear(); }
        else { if (channelLastContextUsage.delete(interaction.channelId)) cleared++; }
        await interaction.reply({ content: `Contexte réinitialisé (${all?'global':'salon'}) – entrées effacées: ${cleared}.`, flags: MessageFlags.Ephemeral });
        return;
      }
      default: return; // ignorer autres commandes
    }
  } catch (e) {
    console.error('Erreur InteractionCreate', e);
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) await interaction.followUp({ content: 'Erreur interne.', flags: MessageFlags.Ephemeral });
        else await interaction.reply({ content: 'Erreur interne.', flags: MessageFlags.Ephemeral });
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

// Lancement propre (si absent)
if (!process.env.DISCORD_TOKEN) { console.error('DISCORD_TOKEN manquant. Configure .env'); process.exit(1); }
if (!process.env.GEMINI_API_KEY) { console.error('GEMINI_API_KEY manquant. Configure .env'); process.exit(1); }
if (!client.isReady()) { try { client.login(process.env.DISCORD_TOKEN); } catch(e){ console.error('Login échoué', e); } }
