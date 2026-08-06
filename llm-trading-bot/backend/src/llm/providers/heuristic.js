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
    const ind = context.snapshot?.indicators ?? {};
    const sentiment = scoreNews(context.news);
    const hasPosition = (context.position?.quantity ?? 0) > 0;

    const rsi = ind.rsi14 ?? 50;
    const cross = ind.macd?.crossover ?? 'unknown';
    const bullishTrend = ind.trend === 'haussière';

    let action = 'HOLD';
    let size = 0;
    let confidence = 0.3;

    const technicalBuy = (cross === 'bullish_cross' || (cross === 'above_signal' && rsi < 60)) && rsi < 68;
    const technicalSell = cross === 'bearish_cross' || rsi > 75;

    if (!hasPosition && technicalBuy && sentiment.score >= 0 && bullishTrend) {
      action = 'BUY';
      size = sentiment.label === 'POSITIF' ? 0.8 : 0.5;
      confidence = sentiment.label === 'POSITIF' ? 0.65 : 0.45;
    } else if (hasPosition && (technicalSell || sentiment.score < -0.4)) {
      action = 'SELL';
      size = 1;
      confidence = 0.6;
    }

    const decision = {
      action,
      confidence,
      size_pct: size,
      technical_rationale: `RSI ${rsi}, MACD ${cross}, tendance ${ind.trend ?? 'inconnue'}.`,
      news_sentiment: sentiment.label,
      news_rationale:
        sentiment.label === 'INDISPONIBLE'
          ? 'Aucune actualité exploitable sur la fenêtre analysée.'
          : `Score lexical ${sentiment.score.toFixed(2)} sur ${context.news.articles.length} titres.`,
      justification:
        action === 'HOLD'
          ? `Attente : signal technique (RSI ${rsi}, MACD ${cross}) insuffisant ou contredit par le sentiment ${sentiment.label}.`
          : `${action} : signal technique ${cross} avec RSI ${rsi} ET sentiment presse ${sentiment.label}.`,
      risk_flags: ['Décision produite par le moteur heuristique de secours, pas par le LLM.'],
      stop_loss_pct: 0.05,
      take_profit_pct: 0.12,
    };

    return { raw: JSON.stringify(decision), usage: null, model: 'heuristic-v1' };
  },
};
