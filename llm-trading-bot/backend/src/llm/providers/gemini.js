import { config } from '../../config.js';
import { createLogger } from '../../logger.js';
import { postJson, HttpError } from '../../utils/http.js';
import { keyPool } from '../keyPool.js';
import { DECISION_SCHEMA, SYSTEM_PROMPT } from '../promptTemplates.js';

const log = createLogger('gemini');
const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

/** Le schéma d'API Gemini n'accepte pas `description` sur la racine ni les types JS. */
function toGeminiSchema(schema) {
  const map = (node) => {
    if (node.type === 'object') {
      return {
        type: 'OBJECT',
        properties: Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, map(v)])),
        required: node.required,
      };
    }
    if (node.type === 'array') return { type: 'ARRAY', items: map(node.items) };
    if (node.type === 'number') return { type: 'NUMBER', description: node.description };
    if (node.type === 'string') {
      return node.enum
        ? { type: 'STRING', enum: node.enum, description: node.description }
        : { type: 'STRING', description: node.description };
    }
    return { type: 'STRING' };
  };
  return map(schema);
}

function buildPayload(userPrompt) {
  return {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: config.llm.temperature,
      maxOutputTokens: config.llm.maxOutputTokens,
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(DECISION_SCHEMA),
      // Les modèles récents « pensent » par défaut et consomment
      // maxOutputTokens avant d'écrire la moindre ligne de JSON — d'où des
      // réponses tronquées si on les laisse faire.
      //
      // Attention : Gemini 2.x accepte `thinkingBudget: 0` pour désactiver
      // complètement la réflexion, mais Gemini 3.x le REFUSE (HTTP 400
      // INVALID_ARGUMENT). Il lui faut un budget strictement positif ; 128
      // suffit et le modèle n'en consomme alors aucun. La valeur par défaut
      // est choisie par famille de modèle dans config.js.
      thinkingConfig: { thinkingBudget: config.llm.thinkingBudget },
    },
    safetySettings: [],
  };
}

function parseCandidate(data) {
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const reason = data?.promptFeedback?.blockReason || 'aucun candidat retourné';
    throw new Error(`Réponse Gemini vide (${reason})`);
  }
  if (candidate.finishReason === 'MAX_TOKENS') {
    // JSON tronqué = inexploitable. Mieux vaut échouer franchement et laisser
    // le fallback heuristique décider que parser un objet incomplet.
    throw new Error(
      `Réponse tronquée (MAX_TOKENS, budget ${config.llm.maxOutputTokens}). Augmente LLM_MAX_OUTPUT_TOKENS ou baisse LLM_THINKING_BUDGET.`,
    );
  }
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    throw new Error(`Génération interrompue par Gemini : ${candidate.finishReason}`);
  }

  const text = (candidate.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Réponse Gemini sans contenu texte');
  return text;
}

export const geminiProvider = {
  name: 'gemini',

  /**
   * Envoie le prompt et retourne l'objet décision brut (déjà parsé en JSON).
   *
   * Rotation de clés : sur HTTP 429 (quota du jour atteint), la clé est marquée
   * épuisée et l'appel est immédiatement retenté avec la suivante. Le cycle
   * n'est perdu que si TOUTES les clés du pool sont à sec.
   */
  async decide(userPrompt) {
    const payload = buildPayload(userPrompt);
    const attempted = [];

    // Au pire on essaie chaque clé une fois.
    const maxAttempts = Math.max(1, (await keyPool.capacity()).keys);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const entry = await keyPool.acquire();
      if (!entry) {
        throw new Error(
          `Toutes les clés Gemini sont épuisées pour aujourd'hui (${attempted.length} essayée(s) : ${attempted.join(', ') || 'aucune'}).`,
        );
      }
      attempted.push(entry.masked);

      const url = `${API_ROOT}/models/${config.llm.model}:generateContent?key=${encodeURIComponent(entry.key)}`;
      const started = Date.now();

      try {
        // `retryOnRateLimit: false` : on ne veut pas attendre 8 s sur une clé
        // à sec alors qu'une autre est disponible tout de suite.
        const data = await postJson(url, payload, {
          timeoutMs: config.llm.timeoutMs,
          retries: 1,
          retryOnRateLimit: false,
        });

        await keyPool.recordUse(entry.id);
        const text = parseCandidate(data);

        log.info(`Décision générée en ${Date.now() - started} ms via ${entry.masked}`, {
          model: config.llm.model,
          tokens: data.usageMetadata?.totalTokenCount,
        });

        return { raw: text, usage: data.usageMetadata || null, model: config.llm.model, keyUsed: entry.masked };
      } catch (err) {
        if (err instanceof HttpError && err.status === 429) {
          // Le corps du 429 est la SEULE source d'information de Google sur le
          // quota réel (aucun en-tête n'est renvoyé en cas de succès). On s'en
          // sert pour recalibrer le plafond au lieu de le supposer.
          const detected = keyPool.calibrateFrom429(err.body);
          await keyPool.markExhausted(
            entry.id,
            detected ? `HTTP 429 (quota réel détecté : ${detected}/jour)` : 'HTTP 429 (quota journalier)',
          );
          continue;
        }
        if (err instanceof HttpError && (err.status === 400 || err.status === 403)) {
          await keyPool.markExhausted(entry.id, `HTTP ${err.status} (clé invalide ou révoquée)`);
          continue;
        }
        // Erreur non liée à la clé (réseau, réponse illisible) : inutile d'en
        // brûler une autre, on remonte l'erreur au fallback heuristique.
        await keyPool.recordUse(entry.id);
        throw err;
      }
    }

    throw new Error(`Aucune clé Gemini utilisable (essayées : ${attempted.join(', ')}).`);
  },
};
