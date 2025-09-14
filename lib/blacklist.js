import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

const BLACKLIST_PATH = path.join(CONFIG_DIR, 'blacklist.json');
let cache = new Set();

export function loadBlacklist() {
  try {
    if (!fs.existsSync(BLACKLIST_PATH)) fs.writeFileSync(BLACKLIST_PATH, JSON.stringify({ users: [] }, null, 2), 'utf8');
    const raw = fs.readFileSync(BLACKLIST_PATH, 'utf8');
    const data = JSON.parse(raw);
    cache = new Set((data.users || []).map(String));
  } catch (e) {
    console.error('Erreur chargement blacklist', e);
    cache = new Set();
  }
}

export function saveBlacklist() {
  try { fs.writeFileSync(BLACKLIST_PATH, JSON.stringify({ users: Array.from(cache) }, null, 2), 'utf8'); } catch (e) { console.error('Erreur sauvegarde blacklist', e); }
}

export function isUserBlacklisted(id) { return cache.has(String(id)); }
export function addBlacklist(id) { cache.add(String(id)); saveBlacklist(); }
export function removeBlacklist(id) { cache.delete(String(id)); saveBlacklist(); }
export function listBlacklist() { return Array.from(cache); }
