import { GoogleGenerativeAI } from '@google/generative-ai';
import { CURRENT_MODEL, SYSTEM_PROMPT, CONFIG, AVAILABLE_MODELS } from './config.js';
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
      const perplexityHostname = 'api.perplexity.ai';
      const perplexityPath = '/chat/completions';
      if (debug) {
        try { console.log(`[#debug][request][sonar] POST https://${perplexityHostname}${perplexityPath}\n  model=sonar  messages=${2 + (channelContext ? 1 : 0)}`); } catch {}
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
      if (debug) {
        try {
          console.log(
            `[#debug][request][sonar] body=\n` +
            `${'─'.repeat(60)}\n` +
            `${JSON.stringify(JSON.parse(body), null, 2)}\n` +
            `${'─'.repeat(60)}`
          );
        } catch {}
      }
      const response = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: perplexityHostname,
          path: perplexityPath,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
            'Accept': 'application/json'
          }
        }, res => {
          if (debug) { try { console.log(`[#debug][response][sonar] HTTP ${res.statusCode} ${res.statusMessage}`); } catch {} }
          let data='';
          res.on('data', c=> data+=c);
          res.on('end', ()=> {
            try {
              if (debug) {
                try {
                  console.log(
                    `[#debug][response][sonar] JSON brut:\n` +
                    `${'─'.repeat(60)}\n` +
                    `${JSON.stringify(JSON.parse(data), null, 2)}\n` +
                    `${'─'.repeat(60)}`
                  );
                } catch { console.log(`[#debug][response][sonar] JSON brut (non parsable):\n${data}`); }
              }
              const json = JSON.parse(data);
              const txt = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || '';
              // ── Citations Perplexity ──────────────────────────────────────
              // L'API renvoie les URLs sources dans json.citations (tableau de strings)
              const citations = Array.isArray(json?.citations) ? json.citations : [];
              resolve({ txt, citations });
            } catch(e){ reject(e); }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      const { txt, citations } = response;
      const cleaned = (txt||'').trim();

      // ── Remplacement inline des [N] par des liens Markdown cliquables ─────
      // Perplexity place des [1], [2]... dans le texte qui correspondent à citations[N-1]
      let finalText = cleaned || 'Réponse vide reçue.';
      if (citations.length > 0) {
        finalText = finalText.replace(/\[(\d+)\]/g, (match, n) => {
          const url = citations[Number(n) - 1];
          return url ? `[[${n}]](${url})` : match; // garde le [N] original si pas d'URL
        });
      }

      if (debug) {
        try {
          console.log(
            `[#debug][response][sonar] ${Date.now()-started}ms — length=${cleaned.length} — citations=${citations.length}\n` +
            `${'─'.repeat(60)}\n` +
            `${finalText}\n` +
            `${'─'.repeat(60)}`
          );
        } catch {}
      }
      return { ok:true, text: finalText, ms: Date.now()-started };
    }
    // ── Gemini ────────────────────────────────────────────────────────────────
    const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${selected}:generateContent`;
    if (debug) {
      try {
        console.log(
          `[#debug][request][gemini] POST ${geminiEndpoint}\n` +
          `${'─'.repeat(60)}\n` +
          `${prompt}\n` +
          `${'─'.repeat(60)}`
        );
      } catch {}
    }
    const model = genAI.getGenerativeModel({ model: selected });
    const result = await withTimeout(model.generateContent(prompt), 25000, 'Délai de génération dépassé');
    if (debug) {
      try {
        console.log(
          `[#debug][response][gemini] JSON brut:\n` +
          `${'─'.repeat(60)}\n` +
          `${JSON.stringify(result.response, null, 2)}\n` +
          `${'─'.repeat(60)}`
        );
      } catch {}
    }
    const response = result.response.text();
    const ms = Date.now() - started;
    if (debug) {
      try {
        console.log(
          `[#debug][response][gemini] model=${selected} — ${ms}ms — length=${(response||'').length}\n` +
          `${'─'.repeat(60)}\n` +
          `${(response||'').trim() || '(vide)'}\n` +
          `${'─'.repeat(60)}`
        );
      } catch {}
    }
    return { ok: true, text: (response||'').trim() || 'Réponse vide reçue.', ms };
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

// Fonction avec fallback automatique qui essaie les modèles de la liste autoModel en cas d'échec
export async function generateAnswerWithFallback({ userQuestion, channelContext, debug, modelOverride = null, systemPromptOverride = null }) {
  const autoModelConfig = CONFIG.autoModel || { enabled: false, fallbackModels: [] };
  
  // Si autoModel est désactivé ou si un modèle spécifique est demandé, utiliser la fonction originale
  if (!autoModelConfig.enabled || modelOverride) {
    return generateAnswer({ userQuestion, channelContext, debug, modelOverride, systemPromptOverride });
  }
  
  // Construire la liste des modèles à tenter
  let modelsToTry = [];
  
  // Commencer par le modèle actuel
  if (CURRENT_MODEL && AVAILABLE_MODELS.includes(CURRENT_MODEL)) {
    modelsToTry.push(CURRENT_MODEL);
  }
  
  // Ajouter les modèles de fallback configurés
  if (Array.isArray(autoModelConfig.fallbackModels)) {
    for (const model of autoModelConfig.fallbackModels) {
      if (AVAILABLE_MODELS.includes(model) && !modelsToTry.includes(model)) {
        modelsToTry.push(model);
      }
    }
  }
  
  // Ajouter tous les autres modèles disponibles en dernier recours
  for (const model of AVAILABLE_MODELS) {
    if (!modelsToTry.includes(model)) {
      modelsToTry.push(model);
    }
  }
  
  if (debug) {
    console.log(`[autoModel] Modèles à tenter (${modelsToTry.length}): ${modelsToTry.join(' -> ')}`);
  }
  
  let lastError = 'Aucun modèle disponible';
  let attemptCount = 0;
  
  // Tenter chaque modèle jusqu'à ce qu'un fonctionne
  for (const model of modelsToTry) {
    attemptCount++;
    
    if (debug) {
      console.log(`[autoModel] Tentative ${attemptCount}/${modelsToTry.length} avec modèle: ${model}`);
    }
    
    try {
      const result = await generateAnswer({ 
        userQuestion, 
        channelContext, 
        debug, 
        modelOverride: model, 
        systemPromptOverride 
      });
      
      if (result.ok) {
        if (debug) {
          console.log(`[autoModel] ✅ Succès avec ${model} après ${attemptCount} tentative(s)`);
        }
        
        // Ajouter des informations sur le modèle utilisé et les tentatives dans la réponse
        return {
          ...result,
          modelUsed: model,
          attemptCount,
          autoModelUsed: attemptCount > 1
        };
      } else {
        lastError = result.error;
        if (debug) {
          console.log(`[autoModel] ❌ Échec avec ${model}: ${result.error}`);
        }
      }
    } catch (error) {
      lastError = error.message || String(error);
      if (debug) {
        console.log(`[autoModel] ❌ Exception avec ${model}: ${lastError}`);
      }
    }
  }
  
  // Tous les modèles ont échoué
  if (debug) {
    console.log(`[autoModel] ❌ Tous les modèles ont échoué après ${attemptCount} tentative(s)`);
  }
  
  return {
    ok: false,
    error: `Tous les modèles ont échoué. Dernier erreur: ${lastError}`,
    ms: 0,
    attemptCount,
    modelsTried: modelsToTry
  };
}
