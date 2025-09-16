// Fichier reconstruit proprement (implémentation unique)
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { generateAnswer } from './ai.js';
import { CONFIG, saveConfig } from './config.js';

const SUBJECT_DEFAULTS = {
  subjectSimilarityThreshold: 0.32,
  subjectInactivityMinutes: 45,
  subjectSummaryMinMessages: 6,
  subjectAutoGenerateSummary: true,
  subjectAutoGenerateTitle: true,
  subjectIncludeMetadataInContext: true,
  subjectMaxContextMessages: 12,
  subjectSimilarityLogTop: 5,
  subjectSummaryRefreshEvery: 25,
  subjectSummaryRetryBackoffSeconds: 300
};
for (const [k,v] of Object.entries(SUBJECT_DEFAULTS)) { if (CONFIG[k] === undefined) CONFIG[k] = v; }
saveConfig();

const DATA_DIR = path.join(process.cwd(), 'data');
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR); } catch {}
const DB_PATH = path.join(DATA_DIR, 'subjects.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`CREATE TABLE IF NOT EXISTS subjects(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  summary TEXT,
  keywords TEXT,
  meta_fail_count INTEGER NOT NULL DEFAULT 0
);`);
db.exec(`CREATE TABLE IF NOT EXISTS subject_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(subject_id) REFERENCES subjects(id)
);`);
// TF-IDF infrastructure
db.exec(`CREATE TABLE IF NOT EXISTS tokens_df(
  token TEXT PRIMARY KEY,
  df INTEGER NOT NULL DEFAULT 0
);`);
db.exec(`CREATE TABLE IF NOT EXISTS subject_tokens(
  subject_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  tf INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(subject_id, token)
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_subject_tokens_subject ON subject_tokens(subject_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_subjects_channel ON subjects(channel_id, last_message_at);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_subject_messages_subject ON subject_messages(subject_id, created_at);`);

// Tokenisation & similarité
const STOPWORDS = new Set(['le','la','les','un','une','de','des','du','et','ou','a','à','en','dans','sur','pour','par','est','es','sont','je','tu','il','on','nous','vous','ils','elles','que','qui','au','aux','ce','cet','cette','ça','sa']);
function tokenize(t){return (t||'').toLowerCase().replace(/[^a-z0-9à-öø-ÿ\s]/gi,' ').split(/\s+/).filter(w=>w.length>2 && !STOPWORDS.has(w));}
function jaccard(a,b){const A=new Set(a),B=new Set(b);let inter=0;for(const x of A) if(B.has(x)) inter++;const union=A.size+B.size-inter;return union? inter/union:0;}

// Statements
const getMessagesStmt = db.prepare('SELECT content FROM subject_messages WHERE subject_id=? ORDER BY created_at DESC LIMIT ?');
const insertSubjectStmt = db.prepare(`INSERT INTO subjects(channel_id, created_at, updated_at, last_message_at, message_count) VALUES(?,?,?,?,0)`);
const updateSubjectOnMessageStmt = db.prepare(`UPDATE subjects SET updated_at=?, last_message_at=?, message_count=message_count+1 WHERE id=?`);
const insertMessageStmt = db.prepare(`INSERT INTO subject_messages(subject_id, author_id, content, created_at) VALUES(?,?,?,?)`);
const listRecentSubjectsStmt = db.prepare(`SELECT * FROM subjects WHERE channel_id=? ORDER BY last_message_at DESC LIMIT 25`);
const updateMetaStmt = db.prepare(`UPDATE subjects SET title=@title, summary=@summary, keywords=@keywords, updated_at=@now WHERE id=@id`);
const incrFailStmt = db.prepare(`UPDATE subjects SET meta_fail_count=meta_fail_count+1 WHERE id=?`);
const getSubjectStmt = db.prepare(`SELECT * FROM subjects WHERE id=?`);
const listSubjectsForContextStmt = db.prepare(`SELECT id,title,summary,keywords,message_count FROM subjects WHERE channel_id=? ORDER BY last_message_at DESC LIMIT 50`);
const listAllSubjectsStmt = db.prepare(`SELECT * FROM subjects WHERE channel_id=? ORDER BY last_message_at DESC`);
const getMessagesFullStmt = db.prepare(`SELECT author_id, content, created_at FROM subject_messages WHERE subject_id=? ORDER BY created_at ASC`);
// TF-IDF statements
const upsertSubjectTokenTF = db.prepare(`INSERT INTO subject_tokens(subject_id, token, tf) VALUES(?,?,?) ON CONFLICT(subject_id, token) DO UPDATE SET tf=tf+excluded.tf`);
const upsertTokenDF = db.prepare(`INSERT INTO tokens_df(token, df) VALUES(?,1) ON CONFLICT(token) DO UPDATE SET df=df+1`);
const getSubjectTokens = db.prepare(`SELECT token, tf FROM subject_tokens WHERE subject_id=?`);
const getTokenDF = db.prepare(`SELECT token, df FROM tokens_df WHERE token IN ($TOKENS)`);
const countSubjectsAll = db.prepare(`SELECT COUNT(*) as c FROM subjects`);

export function recordMessageToSubject({ channelId, authorId, content, now=Date.now(), debug=false }) {
  const recent = listRecentSubjectsStmt.all(channelId);
  const tokensNew = tokenize(content);
  // Catégorie IA contextuelle (avec messages précédents si disponibles)
  let category = '';
  if (CONFIG.subjectUseAIClassification) {
    const contextMsgs = recent.length ? getMessagesStmt.all(recent[0].id, CONFIG.subjectAIContextMessages || 3).map(r => r.content).reverse() : [];
    classifyWithAI(content, contextMsgs, { debug }).then(aiCategory => {
      if (aiCategory && debug) console.log('[subjects][aiCategory]', { content: content.slice(0, 80), category: aiCategory });
    }).catch(() => {});
  } else {
    category = classifyCategory(tokensNew);
  }
  let chosen = null; let bestScore = 0; const scored = [];
  for (const s of recent) {
    const msgs = getMessagesStmt.all(s.id, 8).map(r => r.content).reverse();
    const sample = msgs.slice(-5).join(' ');
    const tok = tokenize(sample);
    const scoreJ = jaccard(tokensNew, tok);
    let scoreTFIDF = 0;
    try { scoreTFIDF = computeTFIDFSimilarity(tokensNew, s.id) || 0; } catch {}
    const blended = (scoreJ*0.5) + (scoreTFIDF*0.5); // pondération simple initiale
    scored.push({ id: s.id, scoreJ, scoreTFIDF, blended, last: s.last_message_at });
    if (blended > bestScore) { bestScore = blended; chosen = s; }
  }
  const inactivityMs = CONFIG.subjectInactivityMinutes * 60 * 1000;
  let decision = 'reuse';
  let noveltyScore = 0; // proportion de tokens nouveaux vs sujet choisi
  let categoryShift = false;
  if (!chosen) decision = 'create';
  else if (bestScore < CONFIG.subjectSimilarityThreshold) decision = 'create';
  else if ((now - chosen.last_message_at) > inactivityMs) decision = 'create';
  else {
    // Calcul nouveauté si on réutilise potentiellement
    const chosenMsgs = getMessagesStmt.all(chosen.id, 12).map(r=>r.content).reverse();
    const chosenTokens = tokenize(chosenMsgs.join(' '));
    const setChosen = new Set(chosenTokens);
    let novelCount = 0; for (const t of tokensNew) if (!setChosen.has(t)) novelCount++;
    noveltyScore = tokensNew.length ? novelCount / tokensNew.length : 0;
    const wSim = CONFIG.subjectScoreWeightSimilarity ?? 1.0;
    const wNov = CONFIG.subjectScoreWeightNovelty ?? 0.0;
    const composite = (wSim * bestScore) - (wNov * noveltyScore);
    if (noveltyScore >= (CONFIG.subjectNoveltyForceThreshold || 0.55)) {
      decision = 'create';
    } else if (composite < CONFIG.subjectSimilarityThreshold) {
      // Score composite trop bas -> créer
      decision = 'create';
    }
    if (decision === 'reuse' && CONFIG.subjectCategoryShiftForce) {
      // Extraire catégorie principale des messages du sujet
      const oldCategory = classifyCategory(chosenTokens);
      if (oldCategory && category && oldCategory !== category) {
        categoryShift = true;
        decision = 'create';
      }
    }
  }
  if (decision === 'create') {
    const info = insertSubjectStmt.run(channelId, now, now, now);
    chosen = { id: info.lastInsertRowid, channel_id: channelId };
    // Titre heuristique immédiat optionnel
    if (CONFIG.subjectImmediateTitleHeuristic) {
      try {
        const heurTitle = buildHeuristicTitle(content);
        if (heurTitle) {
          db.prepare('UPDATE subjects SET title=? WHERE id=?').run(heurTitle, chosen.id);
        }
      } catch{}
    }
  if (debug) console.log('[subjects][create]', { channelId, newId: chosen.id, bestScore, noveltyScore, category, categoryShift, scored: scored.slice(0, CONFIG.subjectSimilarityLogTop) });
  } else if (debug) {
    const top = scored.sort((a,b)=>b.score-a.score).slice(0, CONFIG.subjectSimilarityLogTop);
  console.log('[subjects][reuse]', { subjectId: chosen.id, bestScore, noveltyScore, categoryShift, category, top });
  }
  insertMessageStmt.run(chosen.id, authorId, content, now);
  updateSubjectOnMessageStmt.run(now, now, chosen.id);
  try { updateTFIDFForMessage(chosen.id, tokensNew); } catch(e){ if (debug) console.log('[subjects][tfidf][error]', e.message); }
  try { maybeAutoRefreshSummary(chosen.id, { debug }); } catch {}
  maybeGenerateMeta({ subjectId: chosen.id, debug });
  
  // Tentative fusion micro-sujets après enregistrement
  try { attemptMicroMerge(channelId, chosen.id, { debug }); } catch(e){ if (debug) console.log('[subjects][microMerge][callError]', e.message); }
  
  return chosen.id;
}

// Classification heuristique de domaine (léger, sans IA externe)
const CATEGORY_LEX = [
  { name: 'tech', words: ['code','bug','api','serveur','node','javascript','python','sql','erreur','stack','lib','framework'] },
  { name: 'jeux', words: ['jeu','gaming','minecraft','serveur','loot','lvl','boss','map','build','craft'] },
  { name: 'cuisine', words: ['recette','cuisine','cuire','four','œuf','oeuf','ingrédient','grammes','poêle','mélanger'] },
  { name: 'achat', words: ['acheter','prix','coût','euros','amazon','magasin','commande','livraison','produit'] },
  { name: 'apple', words: ['iphone','ipad','macbook','ios','apple','airpods','watch','m1','m2','m3'] },
  { name: 'android', words: ['android','samsung','pixel','oneplus','xiaomi'] },
  { name: 'musique', words: ['musique','chanson','album','spotify','artiste','guitare','piano','bpm'] },
  { name: 'film', words: ['film','cinéma','acteur','actrice','série','épisode','netflix','marvel','anime'] },
  { name: 'sport', words: ['football','foot','basket','tennis','match','score','but','entrainement','entrainement','ligue'] }
];
function classifyCategory(tokens) {
  if (!tokens || !tokens.length) return '';
  let best = ''; let bestCount = 0;
  for (const cat of CATEGORY_LEX) {
    let c=0; for (const w of tokens) if (cat.words.includes(w)) c++;
    if (c>bestCount && c>=2) { best=cat.name; bestCount=c; }
  }
  return best;
}

// Classification IA contextuelle - génère catégories dynamiques
async function classifyWithAI(message, previousMessages = [], { debug = false } = {}) {
  if (!CONFIG.subjectUseAIClassification) return '';
  
  try {
    // Construire contexte avec messages précédents
    const contextLines = [];
    if (previousMessages.length) {
      contextLines.push('Messages précédents:');
      previousMessages.forEach((msg, i) => contextLines.push(`${i+1}. ${msg.slice(0, 150)}`));
      contextLines.push('---');
    }
    contextLines.push(`Message actuel: ${message.slice(0, 200)}`);
    
    const prompt = `Analyse ce message Discord et son contexte. Génère UNE catégorie descriptive et précise (2-4 mots max, tirets, minuscules).

Exemples:
- "Mon iPhone lag depuis iOS 17" → "iphone-problemes-ios"
- "Je construis un château dans Minecraft" → "minecraft-construction" 
- "Recette de cookies au chocolat?" → "cuisine-patisserie-cookies"
- "Salut ça va?" → "conversation-generale"

${contextLines.join('\n')}

Catégorie (format: mot1-mot2-mot3):`;

    const result = await generateAnswer({ 
      userQuestion: prompt, 
      channelContext: '', 
      debug,
      model: CONFIG.subjectAIModel || 'gemini-2.0-flash-exp'
    });
    
    if (result.ok) {
      let category = result.text.trim().toLowerCase();
      // Nettoyer et valider format
      category = category.replace(/[^a-z0-9\-]/g, '').slice(0, 50);
      if (category && category.includes('-')) {
        if (debug) console.log('[subjects][aiClassify]', { message: message.slice(0, 80), category });
        return category;
      }
    }
  } catch (e) {
    if (debug) console.log('[subjects][aiClassify][error]', e.message);
  }
  
  return '';
}

// Rafraîchissement périodique du résumé/titre (basique): si message_count multiple de subjectSummaryRefreshEvery
function maybeAutoRefreshSummary(subjectId, { debug=false } = {}) {
  if (!CONFIG.subjectSummaryAutoRefreshEnable) return;
  const every = CONFIG.subjectSummaryRefreshEvery || 0;
  if (!every || every < 5) return;
  const s = getSubjectStmt.get(subjectId);
  if (!s) return;
  if (s.message_count > 0 && s.message_count % every === 0) {
    if (debug) console.log('[subjects][refreshAttempt]', { subjectId, count: s.message_count });
    maybeGenerateMeta({ subjectId, debug });
  }
}

// --- TF-IDF ---
function updateTFIDFForMessage(subjectId, tokens) {
  if (!tokens || !tokens.length) return;
  const unique = Array.from(new Set(tokens));
  // Update TF for each token (count occurrences in this message)
  const freqMap = new Map();
  for (const t of tokens) freqMap.set(t, (freqMap.get(t)||0)+1);
  const insert = db.transaction(() => {
    for (const [tok, c] of freqMap.entries()) {
      upsertSubjectTokenTF.run(subjectId, tok, c);
    }
    // DF update only once per token per subject on first introduction
    const existing = new Set(getSubjectTokens.all(subjectId).map(r=>r.token));
    for (const tok of unique) {
      if (!existing.has(tok)) upsertTokenDF.run(tok);
    }
  });
  insert();
}

// (Futur usage) Calculer similarité TF-IDF entre message et sujet
function computeTFIDFSimilarity(tokensMessage, subjectId) {
  const subjectTok = getSubjectTokens.all(subjectId);
  if (!subjectTok.length) return 0;
  const totalSubjects = countSubjectsAll.get().c || 1;
  const dfMap = new Map();
  // Collect DF for tokens of interest
  const candidateTokens = Array.from(new Set([...tokensMessage, ...subjectTok.map(r=>r.token)]));
  if (!candidateTokens.length) return 0;
  const chunks = [];
  // SQLite placeholder dynamic construction
  for (let i=0; i<candidateTokens.length; i+=50) {
    const slice = candidateTokens.slice(i,i+50);
    const place = slice.map(()=>'?').join(',');
    const rows = db.prepare(`SELECT token, df FROM tokens_df WHERE token IN (${place})`).all(...slice);
    for (const r of rows) dfMap.set(r.token, r.df);
  }
  // Build vectors
  const subjMap = new Map(subjectTok.map(r=>[r.token, r.tf]));
  let dot=0, normSubj=0, normMsg=0;
  const msgFreq = new Map();
  for (const t of tokensMessage) msgFreq.set(t, (msgFreq.get(t)||0)+1);
  for (const [tok, tf] of subjMap.entries()) {
    const df = dfMap.get(tok) || 1;
    const idf = Math.log((totalSubjects+1)/(df+1));
    const wSubj = tf * idf;
    normSubj += wSubj*wSubj;
  }
  for (const [tok, tfm] of msgFreq.entries()) {
    const df = dfMap.get(tok) || 1;
    const idf = Math.log((totalSubjects+1)/(df+1));
    const wMsg = tfm * idf;
    normMsg += wMsg*wMsg;
    const subjTF = subjMap.get(tok);
    if (subjTF) {
      const wSubj = subjTF * idf;
      dot += wSubj * wMsg;
    }
  }
  if (!dot || !normSubj || !normMsg) return 0;
  return dot / (Math.sqrt(normSubj) * Math.sqrt(normMsg));
}

// Heuristique simple pour générer un titre court à partir du premier message
function buildHeuristicTitle(text) {
  const cleaned = (text||'').replace(/https?:\/\/\S+/g,'').replace(/<@!?\d+>/g,'').trim();
  if (!cleaned) return '';
  // Si question longue "comment ..." -> extraire jusqu'à 6 mots
  const lower = cleaned.toLowerCase();
  const questionStart = /(comment|pourquoi|quand|quel(le)?|combien|c'est quoi)\b/;
  let candidate = '';
  if (questionStart.test(lower)) {
    candidate = cleaned.split(/[?!\.]/)[0];
  } else {
    candidate = cleaned.split(/[\.?!]/)[0];
  }
  // Garder premiers mots significatifs
  const words = candidate.split(/\s+/).filter(w=>w.length>1).slice(0,8);
  let title = words.join(' ');
  // Capitaliser première lettre
  title = title.charAt(0).toUpperCase()+title.slice(1);
  // Nettoyage final
  title = title.replace(/[,;:]+$/,'').slice(0,70).trim();
  return title;
}

function shouldGenerateMeta(s){
  if (!CONFIG.subjectAutoGenerateSummary && !CONFIG.subjectAutoGenerateTitle) return false;
  if (s.message_count < CONFIG.subjectSummaryMinMessages) return false;
  if (s.summary && s.title) return false;
  return true;
}

function buildMetaPrompt(msgs){
  return `Analyse les messages d'une discussion Discord et produis JSON strict:\n{\n  "title": "TITRE COURT (max 8 mots)",\n  "summary": "Résumé en 2 phrases",\n  "keywords": ["mot1","mot2","mot3"]\n}\nContraintes: français, pas de guillemets inutiles.\nMessages:\n---\n${msgs.map(m=>`- ${m}`).join('\n')}\n---\nJSON:`;
}

export function maybeGenerateMeta({ subjectId, debug=false }) {
  try {
    const s = getSubjectStmt.get(subjectId);
    if (!s || !shouldGenerateMeta(s)) return;
    const rows = getMessagesStmt.all(subjectId, 30).map(r=>r.content).reverse();
    const prompt = buildMetaPrompt(rows);
    generateAnswer({ userQuestion: prompt, channelContext: '', debug }).then(r => {
      if (!r.ok) { incrFailStmt.run(subjectId); if (debug) console.log('[subjects][meta][fail]', r.error); return; }
      let jsonText = r.text.trim();
      const match = jsonText.match(/\{[\s\S]*\}/); if (match) jsonText = match[0];
      let parsed=null; try { parsed = JSON.parse(jsonText); } catch { incrFailStmt.run(subjectId); if (debug) console.log('[subjects][meta][parsefail]', jsonText.slice(0,150)); return; }
      const title = String(parsed.title||'').slice(0,120).trim();
      const summary = String(parsed.summary||'').slice(0,700).trim();
      const keywords = Array.isArray(parsed.keywords)? parsed.keywords.filter(x=>typeof x==='string').slice(0,8).join(', '):'';
      updateMetaStmt.run({ id: subjectId, title, summary, keywords, now: Date.now() });
      if (debug) console.log('[subjects][meta][ok]', { subjectId, haveTitle: !!title, haveSummary: !!summary });
    }).catch(()=>{});
  } catch(e){ if (debug) console.log('[subjects][meta][error]', e.message); }
}

export function buildUniversalContextForLatest({ channelId }) {
  try {
    const subs = listSubjectsForContextStmt.all(channelId);
    if (!subs.length) return '';
    const latest = subs[0];
    const msgs = getMessagesStmt.all(latest.id, CONFIG.subjectMaxContextMessages).map(r=>r.content).reverse();
    const lines=[];
    if (CONFIG.subjectIncludeMetadataInContext) {
      if (latest.title) lines.push(`Titre: ${latest.title}`);
      if (latest.keywords) lines.push(`Mots-clés: ${latest.keywords}`);
      if (latest.summary) lines.push(`Résumé: ${latest.summary}`);
      if (lines.length) lines.push('---');
    }
    for (const m of msgs) lines.push(m.slice(0,400));
    return lines.join('\n');
  } catch { return ''; }
}

export function listSubjectsForDisplay(channelId, limit=15) {
  try {
    const subs = listSubjectsForContextStmt.all(channelId).slice(0, limit).map(s => ({
      id: s.id,
      title: s.title || '(Sans titre)',
      summary: s.summary || '(Résumé indisponible)',
      keywords: s.keywords || '',
      count: s.message_count
    }));
    return subs;
  } catch { return []; }
}

export function listAllSubjects(channelId) {
  try {
    return listAllSubjectsStmt.all(channelId).map(s => ({
      id: s.id,
      title: s.title || '(Sans titre)',
      summary: s.summary || '',
      keywords: s.keywords || '',
      count: s.message_count,
      created_at: s.created_at,
      last_message_at: s.last_message_at
    }));
  } catch { return []; }
}

export function getAllMessagesForSubject(subjectId) {
  try { return getMessagesFullStmt.all(subjectId); } catch { return []; }
}

// TODO: mergeMicroSubjects (à implémenter) : fusionner petits sujets récents retournés vers un sujet principal.
// TODO: autoRefreshSummary(subjectId) : vérifier intervalle subjectSummaryRefreshEvery et relancer maybeGenerateMeta.

// Micro merge statements
const moveMessagesStmt = db.prepare(`UPDATE subject_messages SET subject_id=? WHERE subject_id=?`);
const moveTokensStmt = db.prepare(`INSERT INTO subject_tokens(subject_id, token, tf) SELECT ?, token, tf FROM subject_tokens WHERE subject_id=? ON CONFLICT(subject_id, token) DO UPDATE SET tf=tf+excluded.tf`);
const deleteSubjectStmt = db.prepare(`DELETE FROM subjects WHERE id=?`);
const deleteSubjectTokensStmt = db.prepare(`DELETE FROM subject_tokens WHERE subject_id=?`);
const getRecentMicroSubjects = db.prepare(`SELECT * FROM subjects WHERE channel_id=? AND message_count<=? AND (? - created_at) <= ? ORDER BY created_at DESC`);

// Fusion micro-sujets: chercher sujets récents petits et les fusionner si similarité élevée
export function attemptMicroMerge(channelId, currentSubjectId, { debug=false } = {}) {
  if (!CONFIG.subjectMicroMerge) return;
  
  const maxMicroMsgs = 4; // Considérer micro si <= 4 messages
  const returnWindowMs = (CONFIG.subjectMicroReturnMinutes || 25) * 60 * 1000;
  const mergeThreshold = CONFIG.subjectMicroSimilarityThreshold || 0.68;
  const now = Date.now();
  
  try {
    // Chercher micro-sujets récents (créés dans la fenêtre de retour)
    const microCandidates = getRecentMicroSubjects.all(channelId, maxMicroMsgs, now, returnWindowMs);
    if (!microCandidates.length) return;
    
    // Pour chaque micro-sujet, tenter fusion avec sujet plus ancien
    const allSubjects = listRecentSubjectsStmt.all(channelId);
    
    for (const micro of microCandidates) {
      if (micro.id === currentSubjectId) continue; // Pas fusionner avec lui-même
      
      // Chercher meilleur candidat pour fusion (sujet plus ancien et plus gros)
      let bestTarget = null;
      let bestScore = 0;
      
      for (const target of allSubjects) {
        if (target.id === micro.id) continue;
        if (target.message_count <= maxMicroMsgs) continue; // Target doit être plus substantiel
        if (target.created_at >= micro.created_at) continue; // Target doit être plus ancien
        
        // Calculer similarité entre micro et target
        const microMsgs = getMessagesStmt.all(micro.id, 10).map(r => r.content);
        const targetMsgs = getMessagesStmt.all(target.id, 10).map(r => r.content).reverse();
        
        const microTokens = tokenize(microMsgs.join(' '));
        const targetTokens = tokenize(targetMsgs.slice(-6).join(' '));
        
        const scoreJ = jaccard(microTokens, targetTokens);
        let scoreTFIDF = 0;
        try { scoreTFIDF = computeTFIDFSimilarity(microTokens, target.id) || 0; } catch {}
        const blended = (scoreJ * 0.5) + (scoreTFIDF * 0.5);
        
        if (blended > bestScore && blended >= mergeThreshold) {
          bestScore = blended;
          bestTarget = target;
        }
      }
      
      if (bestTarget) {
        // Fusionner micro dans bestTarget
        const mergeOp = db.transaction(() => {
          // 1. Déplacer messages
          moveMessagesStmt.run(bestTarget.id, micro.id);
          
          // 2. Fusionner tokens TF
          moveTokensStmt.run(bestTarget.id, micro.id);
          
          // 3. Mettre à jour compteurs sujet target
          const newCount = bestTarget.message_count + micro.message_count;
          updateSubjectOnMessageStmt.run(now, Math.max(bestTarget.last_message_at, micro.last_message_at), bestTarget.id);
          db.prepare('UPDATE subjects SET message_count=? WHERE id=?').run(newCount, bestTarget.id);
          
          // 4. Supprimer micro-sujet
          deleteSubjectTokensStmt.run(micro.id);
          deleteSubjectStmt.run(micro.id);
        });
        
        mergeOp();
        
        if (debug) {
          console.log('[subjects][microMerge]', {
            microId: micro.id,
            targetId: bestTarget.id,
            score: bestScore,
            microMsgs: micro.message_count,
            targetMsgs: bestTarget.message_count
          });
        }
      }
    }
  } catch (e) {
    if (debug) console.log('[subjects][microMerge][error]', e.message);
  }
}

export function getSubjectDetails(subjectId, messagesLimit = 30) {
  const subject = getSubjectById(subjectId);
  if (!subject) return null;
  const total = countMessages(subjectId);
  const msgs = getMessagesForSubject(subjectId, messagesLimit, Math.max(0, total - messagesLimit));
  return { subject, msgs, total };
}

export function resetSubjectsChannel(channelId) {
  db.prepare(`DELETE FROM subjects WHERE channel_id=?`).run(channelId);
}
export function resetSubjectsAll() { db.prepare(`DELETE FROM subjects`).run(); }

export async function maybeGenerateSummary(subjectId, { force=false, debug=false, model=CURRENT_MODEL } = {}) {
  const subject = getSubjectById(subjectId);
  if (!subject) return null;
  const wantTitle = CONFIG.subjectAutoGenerateTitle ?? DEFAULTS.subjectAutoGenerateTitle;
  if (!force && subject.summary && subject.keywords && (subject.title || !wantTitle)) return subject;
  const minMsgs = CONFIG.subjectSummaryMinMessages ?? DEFAULTS.subjectSummaryMinMessages;
  const auto = CONFIG.subjectAutoGenerateSummary ?? DEFAULTS.subjectAutoGenerateSummary;
  if (!auto && !force && (!wantTitle || subject.title)) return subject;
  const total = countMessages(subjectId);
  if (!force && total < minMsgs) {
    // Si pas assez de messages pour résumé mais on veut un titre et pas encore présent -> tenter titre rapide
    if (wantTitle && !subject.title) {
      try { await maybeGenerateTitleOnly(subjectId, { debug }); } catch {}
    }
    return subject;
  }
  const rawMsgs = getMessagesForSubject(subjectId, Math.min(total, 40), Math.max(0, total - 40));
  const text = rawMsgs.map(m=>`${m.author_username}: ${m.content}` ).join('\n');
  const prompt = `Analyse la discussion et fournis:\n1) Un titre très court (max 6 mots) sans guillemets.\n2) Un résumé concis en une seule phrase (max 18 mots).\n3) Une liste de 5 mots-clés séparés par des virgules (minuscules).\nFormat EXACT attendu:\nTitre: <titre>\nRésumé: <phrase>\nMots-clés: mot1, mot2, mot3, mot4, mot5\n---\n${text}`;
  try {
    const ans = await generateAnswer({ userQuestion: prompt, channelContext: '', debug: debug });
    if (ans.ok) {
      const lines = ans.text.split(/\n+/).map(l=>l.trim());
      let title = lines.find(l=>l.toLowerCase().startsWith('titre:')) || '';
      let summary = lines.find(l=>l.toLowerCase().startsWith('résumé:')) || '';
      let keywords = lines.find(l=>l.toLowerCase().startsWith('mots-clés:')) || '';
      title = title.replace(/^titre:\s*/i,'').slice(0, 80);
      summary = summary.replace(/^résumé:\s*/i,'').slice(0,200);
      keywords = keywords.replace(/^mots-clés:\s*/i,'').split(/[,;]/).map(s=>s.trim().toLowerCase()).filter(Boolean).slice(0,5).join(', ');
      db.prepare(`UPDATE subjects SET title=?, summary=?, keywords=? WHERE id=?`).run(title || subject.title || null, summary || null, keywords || null, subjectId);
      return getSubjectById(subjectId);
    }
  } catch(e) { if (debug) console.log('[subjects][summary][error]', e); }
  return subject;
}

// Fin duplications legacy supprimées.
