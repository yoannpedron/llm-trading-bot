import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { buildUserPrompt } from './promptTemplates.js';
import { keyPool } from './keyPool.js';
import { geminiProvider } from './providers/gemini.js';
import { heuristicProvider } from './providers/heuristic.js';

const log = createLogger('agent');

const PROVIDERS = { gemini: geminiProvider, heuristic: heuristicProvider };

const ACTIONS = new Set(['BUY', 'SELL', 'HOLD']);
const SENTIMENTS = new Set(['POSITIF', 'NEUTRE', 'NEGATIF', 'INDISPONIBLE']);

/** Extrait un objet JSON même si le modèle l'a entouré de texte ou de ```json. */
function extractJson(raw) {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // on continue
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // on continue
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // on continue
    }
  }
  throw new Error('Impossible d\'extraire un JSON valide de la réponse du modèle.');
}

const clamp = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const text = (v, fallback = '') => (typeof v === 'string' && v.trim() ? v.trim() : fallback);

/**
 * Normalise et sécurise la décision du modèle.
 * Toute anomalie est ramenée à une valeur sûre plutôt que de faire échouer le
 * cycle : une réponse imparfaite ne doit jamais produire un ordre imprévisible.
 */
export function normalizeDecision(parsed) {
  const warnings = [];

  let action = text(parsed.action).toUpperCase();
  if (!ACTIONS.has(action)) {
    warnings.push(`action inconnue « ${parsed.action} » → HOLD`);
    action = 'HOLD';
  }

  let sentiment = text(parsed.news_sentiment).toUpperCase();
  if (!SENTIMENTS.has(sentiment)) sentiment = 'NEUTRE';

  const confidence = clamp(parsed.confidence, 0, 1, 0.3);
  let sizePct = clamp(parsed.size_pct, 0, 1, 0);

  if (action === 'HOLD') sizePct = 0;
  if (action !== 'HOLD' && sizePct === 0) {
    warnings.push(`${action} demandé avec une taille nulle → HOLD`);
    action = 'HOLD';
  }

  const justification = text(parsed.justification, 'Aucune justification fournie par le modèle.');
  // Le prompt exige un croisement explicite des deux sources : on trace le manquement
  // sans bloquer, cela permet d'auditer la qualité du modèle dans le dashboard.
  const mentionsNews = /actualit|news|presse|article|annonce|résultat|sentiment/i.test(justification);
  if (!mentionsNews) warnings.push('la justification ne référence pas explicitement les actualités');

  return {
    action,
    confidence,
    sizePct,
    technicalRationale: text(parsed.technical_rationale, 'n/d'),
    newsSentiment: sentiment,
    newsRationale: text(parsed.news_rationale, 'n/d'),
    justification,
    riskFlags: Array.isArray(parsed.risk_flags) ? parsed.risk_flags.map(String).slice(0, 8) : [],
    stopLossPct: clamp(parsed.stop_loss_pct, 0.005, 0.5, config.risk.stopLossPct),
    takeProfitPct: clamp(parsed.take_profit_pct, 0.005, 2, config.risk.takeProfitPct),
    warnings,
  };
}

const HOLD_ON_ERROR = (message) => ({
  action: 'HOLD',
  confidence: 0,
  sizePct: 0,
  technicalRationale: 'n/d',
  newsSentiment: 'INDISPONIBLE',
  newsRationale: 'n/d',
  justification: `Décision impossible : ${message}. Position inchangée par sécurité.`,
  riskFlags: ['erreur_agent'],
  stopLossPct: config.risk.stopLossPct,
  takeProfitPct: config.risk.takeProfitPct,
  warnings: [message],
});

/**
 * Le cerveau : construit le prompt, interroge le LLM, valide la réponse.
 * Ne lève jamais — en cas d'échec, retourne un HOLD explicite et tracé.
 *
 * @param {object} context { snapshot, news, account, position, budget, constraints }
 */
export async function decide(context) {
  let provider = PROVIDERS[config.llm.provider] ?? heuristicProvider;
  const userPrompt = buildUserPrompt(context);

  // Pool de clés vide ou entièrement épuisé : on n'appelle même pas l'API, on
  // bascule directement sur le secours. Évite une salve de 429 à chaque cycle.
  if (provider !== heuristicProvider) {
    const available = await keyPool.acquire();
    if (!available) {
      const capacity = await keyPool.capacity();
      log.warn(
        capacity.keys === 0
          ? 'Aucune clé Gemini dans le pool → moteur heuristique. Ajoute-en avec `npm run keys:add <clé>`.'
          : `Toutes les clés épuisées (${capacity.used}/${capacity.totalPerDay} appels) → moteur heuristique jusqu'au reset.`,
      );
      provider = heuristicProvider;
    }
  }

  let response;
  try {
    response = await provider.decide(userPrompt, context);
  } catch (err) {
    log.error(`Appel ${provider.name} en échec sur ${context.snapshot.symbol} : ${err.message}`);
    if (provider !== heuristicProvider) {
      try {
        log.warn('Bascule sur le moteur heuristique de secours.');
        response = await heuristicProvider.decide(userPrompt, context);
      } catch (fallbackErr) {
        return { ...HOLD_ON_ERROR(fallbackErr.message), provider: 'none', promptChars: userPrompt.length };
      }
    } else {
      return { ...HOLD_ON_ERROR(err.message), provider: 'none', promptChars: userPrompt.length };
    }
  }

  let decision;
  try {
    decision = normalizeDecision(extractJson(response.raw));
  } catch (err) {
    log.error(`Réponse illisible de ${provider.name} : ${err.message}`, response.raw?.slice(0, 300));
    return { ...HOLD_ON_ERROR(err.message), provider: response.model, promptChars: userPrompt.length };
  }

  if (decision.warnings.length) {
    log.warn(`Décision ${context.snapshot.symbol} normalisée`, decision.warnings);
  }

  return {
    ...decision,
    provider: response.model,
    usage: response.usage,
    promptChars: userPrompt.length,
  };
}

/** Exposé pour l'inspection/debug depuis l'API (`GET /api/prompt/:symbol`). */
export { buildUserPrompt };
