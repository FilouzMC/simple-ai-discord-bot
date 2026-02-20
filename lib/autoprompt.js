import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

// ─── Chemins ─────────────────────────────────────────────────────────────────
const AUTOPROMPT_FILE = path.join(CONFIG_DIR, 'autoprompt.json');

// ─── Structure d'une entrée autoprompt ───────────────────────────────────────
// {
//   id:          string  (uuid court, ex: "ap_1a2b3c")
//   name:        string  (label humain)
//   enabled:     boolean
//   channelId:   string  (ID salon Discord cible)
//   pingRoleId:  string  (ID du rôle à mentionner avant la réponse, "" = aucun)
//   model:       string  (modèle IA à utiliser, "" = modèle courant)
//   prompt:      string  (le texte envoyé à l'IA)
//   schedule: {
//     type: "daily" | "weekly" | "monthly" | "yearly" | "interval"
//     hour:        number  0-23  (pour daily/weekly/monthly/yearly)
//     minute:      number  0-59
//     dayOfWeek:   number  0-6   (0=Dim, pour weekly)
//     dayOfMonth:  number  1-31  (pour monthly/yearly)
//     month:       number  1-12  (pour yearly)
//     intervalMinutes: number    (pour interval)
//   }
//   lastRunTs:   number  (timestamp ms du dernier déclenchement, 0 = jamais)
//   createdAt:   number  (timestamp ms de création)
// }

// ─── Cache mémoire ────────────────────────────────────────────────────────────
let _entries = [];

// ─── Persistance ─────────────────────────────────────────────────────────────
function _load() {
  try {
    if (!fs.existsSync(AUTOPROMPT_FILE)) {
      _entries = [];
      _save();
      return;
    }
    const raw = fs.readFileSync(AUTOPROMPT_FILE, 'utf8');
    const data = JSON.parse(raw);
    _entries = Array.isArray(data.entries) ? data.entries : [];
  } catch (e) {
    console.error('[autoprompt][load] Erreur:', e.message);
    _entries = [];
  }
}

function _save() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(AUTOPROMPT_FILE, JSON.stringify({ entries: _entries }, null, 2), 'utf8');
  } catch (e) {
    console.error('[autoprompt][save] Erreur:', e.message);
  }
}

// ─── Générateur d'ID ─────────────────────────────────────────────────────────
function _genId() {
  return 'ap_' + Math.random().toString(36).slice(2, 9);
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────
export function loadAutoprompts() {
  _load();
}

export function listAutoprompts() {
  return _entries.map(e => ({ ...e })); // copies
}

export function getAutoprompt(id) {
  const e = _entries.find(e => e.id === id);
  return e ? { ...e } : null;
}

/**
 * Crée un autoprompt.
 * @param {{ name, channelId, pingRoleId, model, prompt, schedule }} opts
 * @returns {object} L'entrée créée
 */
export function createAutoprompt({ name, channelId, pingRoleId = '', model = '', prompt, schedule }) {
  _validateSchedule(schedule);
  const entry = {
    id: _genId(),
    name: (name || 'Sans nom').trim(),
    enabled: true,
    channelId: String(channelId),
    pingRoleId: (pingRoleId || '').trim(),
    model: (model || '').trim(),
    prompt: (prompt || '').trim(),
    schedule: _normalizeSchedule(schedule),
    lastRunTs: 0,
    createdAt: Date.now()
  };
  _entries.push(entry);
  _save();
  return { ...entry };
}

/**
 * Met à jour un autoprompt existant (merge partiel).
 */
export function updateAutoprompt(id, patch) {
  const idx = _entries.findIndex(e => e.id === id);
  if (idx === -1) return false;
  const current = _entries[idx];
  if (patch.name !== undefined) current.name = String(patch.name).trim();
  if (patch.enabled !== undefined) current.enabled = !!patch.enabled;
  if (patch.channelId !== undefined) current.channelId = String(patch.channelId);
  if (patch.pingRoleId !== undefined) current.pingRoleId = String(patch.pingRoleId).trim();
  if (patch.model !== undefined) current.model = String(patch.model).trim();
  if (patch.prompt !== undefined) current.prompt = String(patch.prompt).trim();
  if (patch.schedule !== undefined) {
    _validateSchedule(patch.schedule);
    current.schedule = _normalizeSchedule(patch.schedule);
  }
  _entries[idx] = current;
  _save();
  return true;
}

export function deleteAutoprompt(id) {
  const len = _entries.length;
  _entries = _entries.filter(e => e.id !== id);
  if (_entries.length !== len) { _save(); return true; }
  return false;
}

export function setAutopromptEnabled(id, enabled) {
  return updateAutoprompt(id, { enabled });
}

/** Enregistre le timestamp du dernier déclenchement. */
export function markAutopromptRun(id) {
  const e = _entries.find(e => e.id === id);
  if (!e) return;
  e.lastRunTs = Date.now();
  _save();
}

// ─── Logique de planification ─────────────────────────────────────────────────

/**
 * Retourne la liste des entrées dont le déclenchement est dû.
 * Compare lastRunTs + schedule avec l'heure courante.
 */
export function getDueAutoprompts() {
  const now = new Date();
  return _entries.filter(e => e.enabled && _isDue(e, now));
}

/**
 * Détermine si une entrée est à déclencher maintenant.
 * On utilise une fenêtre de ±30s autour de l'heure prévue pour absorber
 * le délai du tick (le scheduler tourne toutes les minutes).
 */
function _isDue(entry, now) {
  const s = entry.schedule;
  if (!s) return false;

  // ── interval : toutes les N minutes ──────────────────────────────────
  if (s.type === 'interval') {
    const mins = s.intervalMinutes || 1;
    if (entry.lastRunTs === 0) return true;
    return (Date.now() - entry.lastRunTs) >= mins * 60_000;
  }

  // ── Pour tous les autres : on vérifie que l'heure H:M correspond ─────
  const h = now.getHours();
  const m = now.getMinutes();
  if (h !== (s.hour ?? 8)) return false;
  if (m !== (s.minute ?? 0)) return false;

  // Vérifier qu'on n'a pas déjà tourné dans la même "minute calendaire"
  if (entry.lastRunTs > 0) {
    const lastRun = new Date(entry.lastRunTs);
    // Même minute = même jour + même heure + même minute
    if (
      lastRun.getFullYear() === now.getFullYear() &&
      lastRun.getMonth()    === now.getMonth()    &&
      lastRun.getDate()     === now.getDate()     &&
      lastRun.getHours()    === now.getHours()    &&
      lastRun.getMinutes()  === now.getMinutes()
    ) return false;
  }

  // ── daily ─────────────────────────────────────────────────────────────
  if (s.type === 'daily') return true;

  // ── weekly ────────────────────────────────────────────────────────────
  if (s.type === 'weekly') {
    return now.getDay() === (s.dayOfWeek ?? 1);
  }

  // ── monthly ───────────────────────────────────────────────────────────
  if (s.type === 'monthly') {
    return now.getDate() === (s.dayOfMonth ?? 1);
  }

  // ── yearly ────────────────────────────────────────────────────────────
  if (s.type === 'yearly') {
    return (
      now.getMonth() + 1 === (s.month ?? 1) &&
      now.getDate()       === (s.dayOfMonth ?? 1)
    );
  }

  return false;
}

// ─── Validation / normalisation ──────────────────────────────────────────────
function _validateSchedule(s) {
  if (!s || typeof s !== 'object') throw new Error('schedule invalide');
  const types = ['daily', 'weekly', 'monthly', 'yearly', 'interval'];
  if (!types.includes(s.type)) throw new Error(`type de schedule invalide: ${s.type}. Valeurs: ${types.join(', ')}`);
  if (s.type === 'interval') {
    const m = Number(s.intervalMinutes);
    if (!Number.isInteger(m) || m < 1 || m > 525600) throw new Error('intervalMinutes doit être entre 1 et 525600');
  } else {
    const h = Number(s.hour);
    const min = Number(s.minute ?? 0);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw new Error('hour doit être entre 0 et 23');
    if (!Number.isInteger(min) || min < 0 || min > 59) throw new Error('minute doit être entre 0 et 59');
  }
  if (s.type === 'weekly') {
    const d = Number(s.dayOfWeek);
    if (!Number.isInteger(d) || d < 0 || d > 6) throw new Error('dayOfWeek doit être entre 0 (Dim) et 6 (Sam)');
  }
  if (s.type === 'monthly' || s.type === 'yearly') {
    const d = Number(s.dayOfMonth);
    if (!Number.isInteger(d) || d < 1 || d > 31) throw new Error('dayOfMonth doit être entre 1 et 31');
  }
  if (s.type === 'yearly') {
    const mo = Number(s.month);
    if (!Number.isInteger(mo) || mo < 1 || mo > 12) throw new Error('month doit être entre 1 et 12');
  }
}

function _normalizeSchedule(s) {
  const out = { type: s.type };
  if (s.type === 'interval') {
    out.intervalMinutes = Math.max(1, Math.min(525600, Number(s.intervalMinutes)));
  } else {
    out.hour   = Math.max(0, Math.min(23, Number(s.hour)));
    out.minute = Math.max(0, Math.min(59, Number(s.minute ?? 0)));
  }
  if (s.type === 'weekly')  out.dayOfWeek  = Math.max(0, Math.min(6,  Number(s.dayOfWeek)));
  if (s.type === 'monthly' || s.type === 'yearly') out.dayOfMonth = Math.max(1, Math.min(31, Number(s.dayOfMonth)));
  if (s.type === 'yearly')  out.month      = Math.max(1, Math.min(12, Number(s.month)));
  return out;
}

// ─── Aide textuelle pour l'affichage Discord ─────────────────────────────────
const DAYS_FR = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const MONTHS_FR = ['Jan','Fév','Mar','Avr','Mai','Juin','Juil','Aoû','Sep','Oct','Nov','Déc'];

export function scheduleToString(s) {
  if (!s) return '(aucun)';
  const pad = n => String(n).padStart(2,'0');
  switch (s.type) {
    case 'daily':   return `Tous les jours à ${pad(s.hour)}h${pad(s.minute)}`;
    case 'weekly':  return `Chaque ${DAYS_FR[s.dayOfWeek] ?? '?'} à ${pad(s.hour)}h${pad(s.minute)}`;
    case 'monthly': return `Le ${s.dayOfMonth} de chaque mois à ${pad(s.hour)}h${pad(s.minute)}`;
    case 'yearly':  return `Le ${s.dayOfMonth} ${MONTHS_FR[(s.month??1)-1] ?? '?'} chaque année à ${pad(s.hour)}h${pad(s.minute)}`;
    case 'interval':return `Toutes les ${s.intervalMinutes} min`;
    default: return s.type;
  }
}
