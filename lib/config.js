import path from 'node:path';
import fs from 'node:fs';

// Paths
export const CONFIG_DIR = path.join(process.cwd(), 'config');
export const CONFIG_FILE_PATH = path.join(CONFIG_DIR, 'config.json');
try { if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR); } catch {}

const ENV_FALLBACK_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

export const DEFAULT_CONFIG = {
  guildId: '',
  whitelistChannelIds: [],
  whitelistAdminUserIds: [],
  whitelistAdminRoleIds: [],
  enablePromptCommand: true,
  systemPrompt: '',
  maxAnswerCharsPerMessage: 4000,
  availableModels: ['gemini-2.5-pro','gemini-2.5-flash'],
  currentModel: 'gemini-2.5-pro',
  enableChannelContext: true,
  channelContextMessageLimit: 6,
  // Limite spécifique pour les threads / forums (souvent besoin de plus d'historique)
  channelContextThreadMessageLimit: 30,
  // Ancien: debugLogPrompts -> remplacé par 'debug' (bool)
  debug: false,
  channelContextMaxOverride: 20,
  channelContextAutoForgetSeconds: 0,
  requireMentionOrReply: true,
  // (autoResponse supprimé)
  modelGroups: {
    // Exemple: "rapide": ["gemini-2.5-flash"], "qualite": ["gemini-2.5-pro"]
  },
  channelContextMessageMaxAgeSeconds: 3600
};

export let CONFIG = { ...DEFAULT_CONFIG };
let needsWrite = false;
try {
  const raw = fs.readFileSync(CONFIG_FILE_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  CONFIG = { ...DEFAULT_CONFIG, ...parsed };
  // Migration clé legacy
  if (parsed.debugLogPrompts !== undefined && CONFIG.debug === false) {
    CONFIG.debug = !!parsed.debugLogPrompts;
  }
} catch {
  needsWrite = true;
}
if (needsWrite) {
  try { fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(CONFIG, null, 2), 'utf8'); } catch {}
}

// Models management
export let AVAILABLE_MODELS = Array.isArray(CONFIG.availableModels) ? CONFIG.availableModels.filter(m => typeof m === 'string' && m.trim()).map(m=>m.trim()) : [];
if (!AVAILABLE_MODELS.length) AVAILABLE_MODELS = [ENV_FALLBACK_MODEL];
if (!AVAILABLE_MODELS.includes(ENV_FALLBACK_MODEL)) AVAILABLE_MODELS.unshift(ENV_FALLBACK_MODEL);
AVAILABLE_MODELS = Array.from(new Set(AVAILABLE_MODELS)).slice(0,25);
// Réordonner selon modelGroups si fourni
if (CONFIG.modelGroups && typeof CONFIG.modelGroups === 'object') {
  const ordered = [];
  const seen = new Set();
  for (const groupName of Object.keys(CONFIG.modelGroups)) {
    const list = CONFIG.modelGroups[groupName];
    if (Array.isArray(list)) {
      for (const m of list) {
        if (AVAILABLE_MODELS.includes(m) && !seen.has(m)) { ordered.push(m); seen.add(m); }
      }
    }
  }
  for (const m of AVAILABLE_MODELS) { if (!seen.has(m)) { ordered.push(m); seen.add(m); } }
  AVAILABLE_MODELS = ordered;
}
CONFIG.availableModels = AVAILABLE_MODELS;
export let CURRENT_MODEL = (CONFIG.currentModel && AVAILABLE_MODELS.includes(CONFIG.currentModel)) ? CONFIG.currentModel : AVAILABLE_MODELS[0];
CONFIG.currentModel = CURRENT_MODEL;

export function setCurrentModel(name) {
  if (AVAILABLE_MODELS.includes(name)) {
    CURRENT_MODEL = name;
    CONFIG.currentModel = name;
    saveConfig();
    console.log(`[model] Modèle actuel changé -> ${CURRENT_MODEL}`);
    return true;
  }
  return false;
}

export let SYSTEM_PROMPT = (
  CONFIG.systemPrompt ||
  process.env.GEMINI_SYSTEM_PROMPT ||
  `Tu es un assistant IA utile et concis sur un serveur Discord francophone.\n- Si la question est ambiguë, demande une clarification courte.\n- Ne révèle pas de clés ou secrets.\n- Réponses en Markdown léger.`
).trim();

export function setSystemPrompt(p) {
  SYSTEM_PROMPT = (p || '').trim();
  CONFIG.systemPrompt = SYSTEM_PROMPT;
  saveConfig();
}

export function saveConfig() {
  try {
  // Ne plus écrire debugLogPrompts; uniquement debug
  const { debugLogPrompts, ...rest } = { ...CONFIG };
  fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify({ ...rest, systemPrompt: SYSTEM_PROMPT }, null, 2), 'utf8');
  } catch (e) { console.error('Erreur saveConfig', e); }
}

// Derived config runtime vars
export function getMaxAnswerChars() {
  const raw = CONFIG.maxAnswerCharsPerMessage;
  if (typeof raw === 'number') return Math.max(500, Math.min(4000, raw));
  return 4000;
}
