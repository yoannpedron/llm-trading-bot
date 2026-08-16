import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { buildUserPrompt, expectedEvidence } from './promptTemplates.js';
import { keyPool } from './keyPool.js';
import { geminiProvider } from './providers/gemini.js';
import { heuristicProvider } from './providers/heuristic.js';

const log = createLogger('agent');

const PROVIDERS = { gemini: geminiProvider, heuristic: heuristicProvider };

/**
 * Le fournisseur configuré, sans passer par `decide()`.
 *
 * Le veto de risque a son propre schéma et sa propre consigne système : il a
 * besoin du transport — rotation de clés, gestion des 429, délais — mais pas
 * de la normalisation d'une prévision qu'il ne produit pas.
 */
export function providerActif() {
  return PROVIDERS[config.llm.provider] ?? heuristicProvider;
}

const ACTIONS = new Set(['BUY', 'SELL', 'HOLD']);
const SENTIMENTS = new Set(['POSITIF', 'NEUTRE', 'NEGATIF', 'INDISPONIBLE']);

/** Extrait un objet JSON même si le modèle l'a entouré de texte ou de ```json. */
// Exporté pour le test contrefactuel (src/scripts/entitySwap.js), qui appelle
// le fournisseur directement sans passer par decide().
export function extractJson(raw) {
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
 * Coercition booléenne tolérante.
 *
 * Indispensable : malgré un `responseSchema` déclarant `type: BOOLEAN`, Gemini
 * renvoie régulièrement des CHAÎNES "true"/"false" dans le JSON structuré. Une
 * comparaison stricte `=== true` compte alors zéro critère validé sur quatre,
 * ce qui transforme silencieusement chaque achat en HOLD. Le bot n'achèterait
 * plus jamais rien, et la mesure conclurait à tort à l'absence d'avantage du
 * modèle alors que seul le parseur serait en cause.
 */
const asBool = (v) => v === true || v === 1 || (typeof v === 'string' && /^(true|1|oui|yes)$/i.test(v.trim()));

/**
 * Vérifie que le modèle a bien recopié les chiffres du prompt (VERDI).
 *
 * C'est le contrôle d'hallucination le plus économique qui existe : il ne
 * coûte aucun appel supplémentaire et se réduit à une comparaison numérique.
 * Un modèle qui invente le prix ou le budget n'a pas lu ses données — sa
 * décision ne vaut rien, quelle que soit l'élégance de sa justification.
 *
 * Une tolérance relative est nécessaire : le modèle arrondit légitimement.
 * Au-delà, c'est de la fabulation.
 */
export function verifyEvidence(evidence, expected, tolerance = 0.02) {
  const mismatches = [];

  for (const [field, expectedValue] of Object.entries(expected)) {
    if (expectedValue == null) continue; // indicateur non calculable, rien à vérifier

    const cited = Number(evidence?.[field]);
    if (!Number.isFinite(cited)) {
      mismatches.push(`${field} absent ou non numérique`);
      continue;
    }

    const scale = Math.max(Math.abs(expectedValue), 1e-6);
    if (Math.abs(cited - expectedValue) / scale > tolerance) {
      mismatches.push(`${field} cité ${cited} au lieu de ${expectedValue}`);
    }
  }

  return {
    grounded: mismatches.length === 0,
    mismatches,
    // Un seul écart peut être un arrondi malheureux ; deux ou plus signalent
    // que le modèle ne s'appuie pas sur les données fournies.
    severity: mismatches.length >= 2 ? 'grave' : mismatches.length === 1 ? 'mineure' : 'aucune',
  };
}

/**
 * Traduit la répartition des 100 scénarios en probabilités exploitables.
 *
 * Le modèle est prié de totaliser 100, et ne le fait pas toujours. Plutôt que
 * de rejeter la réponse, on renormalise : un total à 98 ou 103 est une erreur
 * d'arithmétique sans conséquence sur l'information portée par les
 * proportions. En revanche un total absurde (0, ou négatif) signale que le
 * champ n'a pas été compris, et là il faut refuser.
 *
 * `pUpGivenMove` est la grandeur qui compte pour la calibration : la
 * probabilité de surperformance CONDITIONNELLE à un mouvement discernable.
 * C'est elle qui se confronte au signe du rendement excédentaire mesuré par le
 * carnet fantôme, la bande d'indécision se retrouvant au dénominateur.
 */
export function normalizeForecast(raw) {
  const up = Number(raw?.sur_100_surperforme);
  const down = Number(raw?.sur_100_sousperforme);
  const flat = Number(raw?.sur_100_indistinct);

  const parts = [up, down, flat].map((v) => (Number.isFinite(v) && v >= 0 ? v : NaN));
  if (parts.some(Number.isNaN)) return null;

  const total = parts[0] + parts[1] + parts[2];
  if (!(total > 0)) return null;

  const pUp = parts[0] / total;
  const pDown = parts[1] / total;
  const pFlat = parts[2] / total;
  const moving = pUp + pDown;

  return {
    pUp: Number(pUp.toFixed(4)),
    pDown: Number(pDown.toFixed(4)),
    pFlat: Number(pFlat.toFixed(4)),
    edge: Number((pUp - pDown).toFixed(4)),
    pUpGivenMove: moving > 0 ? Number((pUp / moving).toFixed(4)) : null,
    // Renseigné pour tracer les réponses qui ne totalisaient pas 100.
    rawTotal: total,
  };
}

/**
 * Dérive l'action du seuil, et la taille de l'écart de probabilité.
 *
 * Deux nombres que le modèle n'a plus à inventer. La taille croît linéairement
 * à partir du seuil : nulle quand l'écart l'atteint tout juste, maximale quand
 * la prévision est unanime. C'est une version amortie du critère de Kelly, dont
 * la seule propriété qu'on exige ici est la monotonie — engager davantage quand
 * la prévision est plus tranchée.
 *
 * Cette dérivation PARIE sur le fait que les probabilités du modèle sont au
 * moins monotones, sinon calibrées. C'est précisément ce que mesure
 * `core/calibration.js` : si son verdict passe à « non informative », la taille
 * devra redevenir fixe, parce que dimensionner sur un nombre creux revient à
 * augmenter la mise au hasard.
 */
export function deriveAction(forecast, { minEdge, minUpProbability }) {
  if (!forecast) return { action: 'HOLD', sizePct: 0, confidence: 0 };

  const { pUp, pDown, edge } = forecast;

  if (edge >= minEdge && pUp >= minUpProbability) {
    // ── Poids égal, plus de taille dérivée de l'écart ──────────────────────
    //
    // La version précédente dimensionnait proportionnellement à l'écart de
    // probabilité, avec un plancher à 25 %. Les deux sont abandonnés.
    //
    // La taille proportionnelle est une variante du critère de Kelly, et Kelly
    // suppose les probabilités connues avec certitude. Alimenté par un modèle
    // dont la calibration est incertaine, il engage le capital maximal
    // exactement là où le modèle est le plus exagérément confiant — il
    // amplifie l'erreur au lieu de l'absorber.
    //
    // Le plancher de 25 % était pire encore : je l'avais ajouté pour supprimer
    // une « zone morte » où un écart tout juste au seuil donnait une taille
    // nulle. Cette zone morte était le comportement CORRECT. Le plancher
    // forçait à sur-parier précisément quand l'avantage était le plus faible,
    // et imposait 75 % d'exposition minimale sur trois positions.
    //
    // Tant que la calibration n'est pas mesurée, seul le RANG du modèle est
    // exploitable — pas le niveau. La taille ne doit donc dépendre que de
    // l'appartenance au top K, décidée en aval par `core/ranking.js`.
    return { action: 'BUY', sizePct: 1, confidence: pUp };
  }

  if (-edge >= minEdge && pDown >= minUpProbability) {
    return { action: 'SELL', sizePct: 1, confidence: pDown };
  }

  // La confiance d'un HOLD est celle de l'issue dominante : c'est ce nombre qui
  // sera confronté au résultat, il doit désigner l'issue effectivement prédite.
  return { action: 'HOLD', sizePct: 0, confidence: Math.max(pUp, pDown, forecast.pFlat) };
}

/**
 * Normalise et sécurise la décision du modèle.
 * Toute anomalie est ramenée à une valeur sûre plutôt que de faire échouer le
 * cycle : une réponse imparfaite ne doit jamais produire un ordre imprévisible.
 */
export function normalizeDecision(parsed, expected = null, options = {}) {
  const warnings = [];
  const { degraded = false, thresholds = null } = options;

  const base = thresholds ?? {
    minEdge: config.risk.minEdge,
    minUpProbability: config.risk.minUpProbability,
  };
  // Copie : jamais muter l'objet du appelant.
  const seuils = { ...base };

  // Actualités absentes : on exige plus d'écart avant d'agir. Le modèle penche
  // à la baisse dans ce cas au lieu de se resserrer comme demandé, et une
  // simple panne de flux RSS ne doit pas suffire à solder une position saine.
  const degradedFloor = config.risk.minEdgeDegraded ?? seuils.minEdge;
  if (degraded && degradedFloor > seuils.minEdge) {
    seuils.minEdge = degradedFloor;
    warnings.push(`actualités indisponibles → écart minimal relevé à ${degradedFloor}`);
  }

  // ── Prévision → action ─────────────────────────────────────────────────
  const forecast = normalizeForecast(parsed.forecast);
  if (!forecast) {
    warnings.push('prévision absente ou illisible → HOLD');
  } else if (Math.abs(forecast.rawTotal - 100) > 2) {
    warnings.push(`répartition totalisant ${forecast.rawTotal} au lieu de 100 → renormalisée`);
  }

  const derived = deriveAction(forecast, seuils);
  let action = derived.action;
  let confidence = derived.confidence;
  let sizePct = derived.sizePct;

  // Recommandation propre du modèle : jamais exécutée, seulement comparée.
  // L'écart entre les deux chiffre le biais d'inaction du RLHF au lieu de le
  // postuler — si le modèle dit HOLD alors que sa propre répartition annonce
  // 65/20/15, c'est le réflexe prudent qui parle, pas l'analyse.
  let advised = text(parsed.action).toUpperCase();
  if (!ACTIONS.has(advised)) advised = null;
  const advisoryConflict = Boolean(advised && forecast && advised !== action);

  let sentiment = text(parsed.news_sentiment).toUpperCase();
  if (!SENTIMENTS.has(sentiment)) sentiment = 'NEUTRE';

  // ── Les garde-fous agissent sur L'ACTION, jamais sur la PROBABILITÉ ─────
  //
  // Distinction essentielle, et c'est un piège dans lequel la version
  // précédente tombait : elle rabotait la confiance quand un contrôle échouait
  // (0,8 ramené à 0,7, ou mise à 0 sur ancrage douteux). Or cette probabilité
  // est désormais l'objet même de la mesure de calibration. La corriger
  // reviendrait à mesurer nos propres corrections au lieu du modèle — et à
  // fabriquer une calibration artificiellement bonne, puisqu'on écrase
  // précisément les valeurs qu'on soupçonne d'être fausses.
  //
  // On note donc les anomalies, on bloque l'action si nécessaire, et on
  // enregistre la prévision telle qu'annoncée.

  const evidence = expected ? verifyEvidence(parsed.evidence, expected) : null;
  let voided = false;
  if (evidence && !evidence.grounded) {
    warnings.push(`ancrage défaillant (${evidence.severity}) : ${evidence.mismatches.join(' ; ')}`);
    // Une divergence grave annule l'exécution : le modèle n'a pas lu ses
    // données, sa prévision ne repose sur rien d'observable.
    if (evidence.severity === 'grave') {
      action = 'HOLD';
      sizePct = 0;
      voided = true;
    }
  }

  // ── Grille booléenne ───────────────────────────────────────────────────
  // Second verrou, indépendant du seuil de probabilité : au moins 3 booléens
  // vrais sur 4 pour ouvrir. C'est une contrainte arithmétique et non une
  // appréciation, donc vérifiable de notre côté plutôt que confiée au modèle.
  const rawChecks = parsed.checks && typeof parsed.checks === 'object' ? parsed.checks : {};
  // Normalisation en vrais booléens avant tout comptage.
  const checks = Object.fromEntries(Object.entries(rawChecks).map(([k, v]) => [k, asBool(v)]));
  const checksPassed = Object.values(checks).filter(Boolean).length;
  const checksTotal = Object.keys(checks).length;

  if (action === 'BUY' && checksTotal >= 4 && checksPassed < 3) {
    warnings.push(`achat déduit d'une prévision à ${(confidence * 100).toFixed(0)} % mais seulement ${checksPassed}/${checksTotal} critères validés → HOLD`);
    action = 'HOLD';
    sizePct = 0;
  }

  if (action === 'HOLD') sizePct = 0;
  if (action !== 'HOLD' && sizePct === 0) {
    // Un écart tout juste au seuil produit une taille nulle. Ce n'est pas une
    // anomalie, c'est la borne inférieure du dimensionnement : on n'engage rien.
    action = 'HOLD';
  }

  const justification = text(parsed.justification, 'Aucune justification fournie par le modèle.');

  // ── Contrôle retiré, et il faut dire pourquoi ──────────────────────────
  // Un test cherchait ici les mots « actualité / news / presse / annonce… »
  // dans la justification, pour vérifier que le modèle croise bien ses deux
  // sources. Mesuré sur 35 décisions réelles : il se déclenchait 15 fois, soit
  // 43 %, et c'était le SEUL avertissement jamais produit.
  //
  // Or c'étaient des fausses alertes. « soutenue par des partenariats solides
  // dans l'intelligence artificielle » référence évidemment les actualités,
  // sans contenir aucun des mots cherchés. Le regex mesurait un vocabulaire,
  // pas un raisonnement.
  //
  // Le coût était réel : un canal d'alerte qui crie au loup deux fois sur cinq
  // et ne signale rien d'autre entraîne à ignorer les alertes — donc à rater
  // celles qui comptent, comme l'ancrage défaillant ou la prévision illisible.
  //
  // Et la question de fond est déjà tranchée ailleurs, rigoureusement : le
  // carnet fantôme segmente les scores AVEC et SANS actualités. Si les deux
  // segments se valent, le module d'actualités ne sert à rien — et ça, aucune
  // recherche de mots-clés ne pouvait le dire.

  return {
    action,
    confidence,
    sizePct,
    // La prévision brute, telle qu'annoncée. C'est elle qui alimente la mesure
    // de calibration, indépendamment de ce que les garde-fous ont fait de
    // l'action.
    forecast,
    // Ce que le modèle recommandait de son côté, et s'il diverge du seuil.
    advisedAction: advised,
    advisoryConflict,
    voided,
    preMortem: parsed.pre_mortem
      ? {
        scenario: text(parsed.pre_mortem.scenario_defavorable, 'n/d'),
        weakestSignal: text(parsed.pre_mortem.signal_le_plus_fragile, 'n/d'),
      }
      : null,
    checks,
    checksPassed,
    checksTotal,
    evidence: evidence ?? undefined,
    riskMath: parsed.risk_math ?? null,
    newsSentiment: sentiment,
    justification,
    riskFlags: Array.isArray(parsed.risk_flags) ? parsed.risk_flags.map(String).slice(0, 8) : [],
    // Le stop n'est délibérément PAS demandé au modèle. Il est calculé par le
    // gestionnaire de risque sur l'ATR courant, donc recalibré à chaque cycle
    // en fonction de la volatilité réelle de l'actif. Laisser le LLM proposer
    // un pourcentage arbitraire reviendrait à lui confier une décision qu'il
    // n'a aucun moyen d'évaluer mieux qu'une formule.
    warnings,
  };
}

const HOLD_ON_ERROR = (message) => ({
  action: 'HOLD',
  confidence: 0,
  sizePct: 0,
  // Aucune prévision : cette décision ne doit surtout pas entrer dans la mesure
  // de calibration. Un HOLD de panne n'est pas un HOLD de conviction.
  forecast: null,
  technicalRationale: 'n/d',
  newsSentiment: 'INDISPONIBLE',
  newsRationale: 'n/d',
  justification: `Décision impossible : ${message}. Position inchangée par sécurité.`,
  riskFlags: ['erreur_agent'],
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
    decision = normalizeDecision(extractJson(response.raw), expectedEvidence(context), {
      degraded: Boolean(context.news?.degraded) || !(context.news?.articles?.length),
    });
  } catch (err) {
    log.error(`Réponse illisible de ${provider.name} : ${err.message}`, response.raw?.slice(0, 300));
    return { ...HOLD_ON_ERROR(err.message), provider: response.model, promptChars: userPrompt.length };
  }

  if (decision.warnings.length) {
    log.warn(`Décision ${context.snapshot.symbol} normalisée`, decision.warnings);
  }

  // Trace du biais d'inaction : le modèle conseille autre chose que ce que sa
  // propre répartition implique. On l'enregistre à chaque fois pour pouvoir en
  // faire une statistique, plutôt que de discuter du phénomène dans le vide.
  if (decision.advisoryConflict) {
    const f = decision.forecast;
    log.info(
      `${context.snapshot.symbol} : le modèle recommande ${decision.advisedAction} alors que sa prévision `
      + `${Math.round(f.pUp * 100)}/${Math.round(f.pDown * 100)}/${Math.round(f.pFlat * 100)} implique ${decision.action}.`,
    );
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
