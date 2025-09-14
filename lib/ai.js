import { GoogleGenerativeAI } from '@google/generative-ai';
import { CURRENT_MODEL, SYSTEM_PROMPT } from './config.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

function withTimeout(promise, ms, label='Timeout') {
  let timer; const t = new Promise((_,rej)=>{ timer=setTimeout(()=>rej(new Error(label)),ms); });
  return Promise.race([promise.finally(()=>clearTimeout(timer)), t]);
}

export async function generateAnswer({ userQuestion, channelContext, debug }) {
  const started = Date.now();
  const prompt = [
    '----- PROMPT START -----',
    SYSTEM_PROMPT,
    channelContext ? 'Contexte récent :' : null,
    channelContext || null,
    `UTILISATEUR : ${userQuestion}`,
    '----- PROMPT END -----'
  ].filter(Boolean).join('\n\n');
  if (debug) {
    try { console.log(`[#debug][prompt] model=${CURRENT_MODEL} length=${prompt.length}\n----- PROMPT START -----\n${prompt}\n----- PROMPT END -----`); } catch {}
  }
  try {
    const model = genAI.getGenerativeModel({ model: CURRENT_MODEL });
    const result = await withTimeout(model.generateContent(prompt), 25000, 'Délai de génération dépassé');
    const response = result.response.text();
    if (debug) {
      try { console.log(`[#debug][response] length=${(response||'').length}\n----- RESPONSE START -----\n${response}\n----- RESPONSE END -----`); } catch {}
    }
    return { ok: true, text: (response||'').trim() || 'Réponse vide reçue.', ms: Date.now()-started };
  } catch (e) {
    const msg = e?.message || String(e);
    if (debug) { try { console.log(`[#debug][error] model=${CURRENT_MODEL} err="${msg}"`); } catch {} }
    return { ok: false, error: msg, ms: Date.now()-started };
  }
}

export async function testGemini() {
  try {
    if (!process.env.GEMINI_API_KEY) return { ok:false, error:'CLE API GEMINI absente' };
    const model = genAI.getGenerativeModel({ model: CURRENT_MODEL });
    const r = await model.generateContent('ping');
    const text = r.response.text().slice(0,40);
    return { ok:true, sample:text };
  } catch(e){ return { ok:false, error:e.message||String(e) }; }
}
