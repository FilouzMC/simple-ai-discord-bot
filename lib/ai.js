import { GoogleGenerativeAI } from '@google/generative-ai';
import { CURRENT_MODEL, SYSTEM_PROMPT } from './config.js';
import https from 'node:https';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

function withTimeout(promise, ms, label='Timeout') {
  let timer; const t = new Promise((_,rej)=>{ timer=setTimeout(()=>rej(new Error(label)),ms); });
  return Promise.race([promise.finally(()=>clearTimeout(timer)), t]);
}

export async function generateAnswer({ userQuestion, channelContext, debug, modelOverride = null, systemPromptOverride = null }) {
  const started = Date.now();
  const effectiveSystemPrompt = (systemPromptOverride && systemPromptOverride.trim()) ? systemPromptOverride.trim() : SYSTEM_PROMPT;
  const prompt = [
    '----- PROMPT START -----',
    effectiveSystemPrompt,
    channelContext ? 'Contexte récent :' : null,
    channelContext || null,
    `UTILISATEUR : ${userQuestion}`,
    '----- PROMPT END -----'
  ].filter(Boolean).join('\n\n');
  if (debug) {
  try { console.log(`[#debug][prompt] model=${modelOverride||CURRENT_MODEL} length=${prompt.length} override=${!!systemPromptOverride}\n----- PROMPT START -----\n${prompt}\n----- PROMPT END -----`); } catch {}
  }
  try {
    const selected = modelOverride || CURRENT_MODEL;
    if (selected === 'sonar') {
      if (!process.env.PERPLEXITY_API_KEY) {
        return { ok:false, error:'PERPLEXITY_API_KEY manquante pour modèle sonar', ms: Date.now()-started };
      }
      const body = JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          channelContext ? { role: 'system', content: `Contexte récent:\n${channelContext}` } : null,
          { role: 'user', content: userQuestion }
        ].filter(Boolean),
        stream: false
      });
      const response = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.perplexity.ai',
          path: '/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
            'Accept': 'application/json'
          }
        }, res => {
          let data='';
          res.on('data', c=> data+=c);
          res.on('end', ()=> {
            try {
              const json = JSON.parse(data);
              const txt = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || '';
              resolve(txt);
            } catch(e){ reject(e); }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      const cleaned = (response||'').trim();
      if (debug) { try { console.log(`[#debug][response][sonar] length=${cleaned.length}`); } catch {} }
      return { ok:true, text: cleaned || 'Réponse vide reçue.', ms: Date.now()-started };
    }
    const model = genAI.getGenerativeModel({ model: selected });
    const result = await withTimeout(model.generateContent(prompt), 25000, 'Délai de génération dépassé');
    const response = result.response.text();
    if (debug) {
      try { console.log(`[#debug][response] length=${(response||'').length}\n----- RESPONSE START -----\n${response}\n----- RESPONSE END -----`); } catch {}
    }
    return { ok: true, text: (response||'').trim() || 'Réponse vide reçue.', ms: Date.now()-started };
  } catch (e) {
    const msg = e?.message || String(e);
  if (debug) { try { console.log(`[#debug][error] model=${modelOverride||CURRENT_MODEL} err="${msg}"`); } catch {} }
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
