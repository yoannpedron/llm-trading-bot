/**
 * Moteur de secours déterministe, sans appel réseau.
 * Il s'active quand aucune clé LLM n'est configurée ou quand l'API est en panne :
 * le bot continue de tourner avec une stratégie simple et lisible plutôt que de
 * s'arrêter (ou pire, de prendre une décision sur une réponse corrompue).
 *
 * Stratégie : croisement MACD confirmé par le RSI et la tendance EMA20/EMA50,
 * pondéré par le sentiment grossier des titres d'actualité.
 */

const POSITIVE = ['beat', 'surge', 'record', 'upgrade', 'profit', 'growth', 'wins', 'rally', 'strong', 'raises', 'outperform'];
const NEGATIVE = ['miss', 'plunge', 'lawsuit', 'probe', 'downgrade', 'loss', 'recall', 'cut', 'warns', 'fraud', 'slump', 'weak'];

function scoreNews(news) {
  if (!news || news.degraded || !news.articles.length) return { score: 0, label: 'INDISPONIBLE' };
  let score = 0;
  for (const a of news.articles) {
    const text = `${a.title} ${a.summary || ''}`.toLowerCase();
    for (const w of POSITIVE) if (text.includes(w)) score += 1;
    for (const w of NEGATIVE) if (text.includes(w)) score -= 1;
  }
  const normalized = Math.max(-1, Math.min(1, score / Math.max(news.articles.length, 1)));
  return {
    score: normalized,
    label: normalized > 0.2 ? 'POSITIF' : normalized < -0.2 ? 'NEGATIF' : 'NEUTRE',
  };
}

export const heuristicProvider = {
  name: 'heuristic',
  isConfigured: true,

  async decide(_userPrompt, context = {}) {
    // ── Demande de CLASSEMENT : ce fournisseur n'a pas d'avis ─────────────
    // Depuis que le modèle ordonne des lots au lieu de noter des actifs
    // isolés, le repli reçoit un schéma qu'il ne sait pas remplir. Il
    // renvoyait alors une prévision, que la validation rejetait — chaque lot
    // échouait en silence et le classement ressortait vide.
    //
    // Fabriquer un ordre plausible serait pire : le bot croirait avoir un
    // avis là où il n'y en a aucun. Le repli déclare donc franchement ne rien
    // distinguer. Le test global le constatera, écartera ce signal du
    // mélange, et les cinq facteurs mécaniques décideront seuls — ce qui est
    // exactement le comportement voulu quand le modèle est indisponible.
    const etiquettes = context?.schema?.properties?.classement?.items?.enum;
    if (Array.isArray(etiquettes) && etiquettes.length) {
      return {
        raw: JSON.stringify({
          analyse: 'Moteur de secours : aucune capacité de comparaison sémantique.',
          classement: etiquettes,
          separation: 'AUCUNE',
        }),
        usage: null,
        model: 'heuristic',
      };
    }

    const ind = context.snapshot?.indicators ?? {};
    const sentiment = scoreNews(context.news);
    const hasPosition = (context.position?.quantity ?? 0) > 0;

    const rsi = ind.rsi14 ?? 50;
    const cross = ind.macd?.crossover ?? 'unknown';
    const bullishTrend = ind.trend === 'haussière';

    const technicalBuy = (cross === 'bullish_cross' || (cross === 'above_signal' && rsi < 60)) && rsi < 68;
    const technicalSell = cross === 'bearish_cross' || rsi > 75;

    // ── Conviction signée, puis répartition des 100 scénarios ─────────────
    // Le moteur de secours doit parler le MÊME langage que le LLM, sinon la
    // dérivation d'action côté agent le ramène systématiquement à HOLD et le
    // fallback ne sert plus à rien.
    let conviction = 0;
    if (technicalBuy && bullishTrend) conviction += 0.5;
    if (technicalSell) conviction -= 0.5;
    conviction += sentiment.score * 0.3;
    // Plafonné : une heuristique de secours ne prétend jamais à la quasi-certitude.
    conviction = Math.max(-0.7, Math.min(0.7, conviction));

    const flat = 15;
    const spread = 100 - flat;
    const up = Math.round((spread * (1 + conviction)) / 2);
    const down = spread - up;

    // Action indicative, cohérente avec la répartition (le seuil réel est
    // appliqué côté agent).
    const edge = (up - down) / 100;
    const action = edge >= 0.2 ? 'BUY' : edge <= -0.2 ? 'SELL' : 'HOLD';
    const size = action === 'SELL' ? 1 : action === 'BUY' ? Math.min(1, edge * 2) : 0;

    // Le moteur de secours produit le MÊME schéma que le LLM, y compris les
    // preuves et la grille : sans quoi la vérification d'ancrage rejetterait
    // systématiquement ses décisions et le fallback serait inopérant.
    const budget = context.budget?.maxNotionalBase ?? 0;
    const notional = budget * size;

    const decision = {
      evidence: {
        cited_price: ind.price,
        cited_rsi: rsi,
        cited_atr_pct: ind.atrPct,
        cited_budget: Number(budget.toFixed(2)),
      },
      checks: {
        momentum_favorable: technicalBuy,
        trend_favorable: bullishTrend,
        news_confirms: sentiment.label === 'POSITIF',
        volatility_acceptable: (ind.atrPct ?? 0) < 8,
      },
      news_sentiment: sentiment.label,
      pre_mortem: {
        scenario_defavorable:
          'Le croisement MACD est un signal retardé : il peut survenir après l\'essentiel du mouvement, '
          + 'auquel cas l\'entrée se fait au sommet local.',
        signal_le_plus_fragile: sentiment.label === 'INDISPONIBLE'
          ? 'Aucune actualité : la lecture est purement technique.'
          : 'Le sentiment est déduit d\'un simple comptage de mots-clés, sans compréhension du contexte.',
      },
      forecast: {
        sur_100_surperforme: up,
        sur_100_sousperforme: down,
        sur_100_indistinct: flat,
      },
      risk_math: {
        proposed_notional: Number(notional.toFixed(2)),
        stop_distance_pct: 0.1,
        max_loss_dollars: Number((notional * 0.1).toFixed(2)),
      },
      action,
      risk_flags: ['Décision produite par le moteur heuristique de secours, pas par le LLM.'],
      justification:
        action === 'HOLD'
          ? `Attente : signal technique (RSI ${rsi}, MACD ${cross}) insuffisant ou contredit par les actualités (sentiment ${sentiment.label}).`
          : `${action} : signal technique ${cross} avec RSI ${rsi} ET sentiment des actualités ${sentiment.label}.`,
    };

    return { raw: JSON.stringify(decision), usage: null, model: 'heuristic-v1' };
  },
};
