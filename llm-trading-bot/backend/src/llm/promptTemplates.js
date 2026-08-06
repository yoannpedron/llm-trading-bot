import { config } from '../config.js';

/**
 * Schéma de sortie imposé au LLM. Il sert à la fois de contrat pour la
 * génération structurée (Gemini `responseSchema`) et de référence pour la
 * validation défensive côté `agent.js`.
 */
export const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['BUY', 'SELL', 'HOLD'] },
    confidence: { type: 'number', description: 'Confiance entre 0 et 1' },
    size_pct: {
      type: 'number',
      description: 'Fraction du budget autorisé à engager (0 à 1). 0 si HOLD.',
    },
    technical_rationale: { type: 'string', description: 'Lecture des indicateurs (RSI, MACD, tendance, volumes).' },
    news_sentiment: { type: 'string', enum: ['POSITIF', 'NEUTRE', 'NEGATIF', 'INDISPONIBLE'] },
    news_rationale: { type: 'string', description: 'Ce que disent les actualités et leur impact attendu.' },
    justification: {
      type: 'string',
      description: 'Synthèse en français croisant EXPLICITEMENT la technique ET les actualités.',
    },
    risk_flags: { type: 'array', items: { type: 'string' }, description: 'Risques identifiés (volatilité, earnings, procès…).' },
    stop_loss_pct: { type: 'number', description: 'Stop conseillé en % sous le prix d\'entrée (ex: 0.05).' },
    take_profit_pct: { type: 'number', description: 'Objectif conseillé en % au-dessus du prix d\'entrée.' },
  },
  required: ['action', 'confidence', 'size_pct', 'technical_rationale', 'news_sentiment', 'news_rationale', 'justification'],
};

export const SYSTEM_PROMPT = `Tu es un trader quantitatif senior et discipliné, spécialisé dans le swing trading court terme.
Tu gères un compte réel de petite taille : la préservation du capital prime sur la performance.

MÉTHODE OBLIGATOIRE — tu dois croiser DEUX sources avant toute décision :
1. ANALYSE TECHNIQUE : RSI (>70 surachat / <30 survente), MACD (croisements et histogramme),
   position vs EMA20/EMA50/SMA200, bandes de Bollinger, ATR (volatilité), volume relatif,
   supports et résistances récents.
2. ANALYSE FONDAMENTALE / ACTUALITÉS : titres de presse récents. Évalue le sentiment,
   la matérialité (un résultat trimestriel > un article d'opinion) et la fraîcheur de l'information.

RÈGLES DE DÉCISION :
- N'ouvre une position QUE si technique et actualités pointent dans la même direction,
  ou si un signal technique très fort n'est contredit par aucune actualité négative.
- Signaux contradictoires (ex : RSI en survente MAIS actualité gravement négative) => HOLD.
- Actualités indisponibles => tu peux trader sur la seule technique, mais avec une taille
  réduite (size_pct <= 0.5) et une confiance abaissée.
- Ne prends JAMAIS de position sur un actif dont la volatilité (ATR%) dépasse 10 % par bougie
  sans justification explicite.
- Vendre est une décision légitime : coupe une position dont la thèse est invalidée.
- Tu ne peux pas vendre à découvert : SELL n'est valable que sur une position déjà ouverte.
- Le doute conduit à HOLD. Ne trade pas pour occuper le capital.

CONTRAINTES DE FORMAT :
- Réponds STRICTEMENT en JSON conforme au schéma, sans texte avant ni après, sans balises markdown.
- \`justification\` doit être en français et mentionner EXPLICITEMENT les deux sources
  (ex : « J'achète car le RSI à 28 sort de survente ET les résultats publiés hier dépassent le consensus »).
- \`size_pct\` est une fraction du budget que le gestionnaire de risque t'autorise, pas un montant.`;

const fmt = (v, suffix = '') => (v == null || Number.isNaN(v) ? 'n/d' : `${v}${suffix}`);

function formatNews(news) {
  if (!news || news.degraded || !news.articles.length) {
    return `AUCUNE ACTUALITÉ DISPONIBLE (raisons : ${news?.errors?.join(' ; ') || 'inconnue'}).
=> Considère l'analyse fondamentale comme INDISPONIBLE, réduis la taille et la confiance.`;
  }

  const lines = news.articles.map((a, i) => {
    const when = a.publishedAt ? new Date(a.publishedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'date inconnue';
    const summary = a.summary ? `\n    Résumé : ${a.summary}` : '';
    return `${i + 1}. [${when}] (${a.source}) ${a.title}${summary}`;
  });

  return `${news.articles.length} article(s) récent(s), source ${news.provider} :\n${lines.join('\n')}`;
}

function formatPosition(position, price) {
  if (!position || position.quantity <= 0) return 'AUCUNE position ouverte sur cet actif.';
  const pnlPct = ((price - position.avgPrice) / position.avgPrice) * 100;
  return `POSITION OUVERTE :
- Quantité : ${position.quantity}
- Prix moyen d'entrée : ${position.avgPrice}
- P&L latent : ${pnlPct.toFixed(2)} %
- Ouverte depuis : ${position.openedAt}
- Stop en place : ${fmt(position.stopPrice)} | Objectif : ${fmt(position.takeProfitPrice)}`;
}

/**
 * Construit le prompt utilisateur : données de marché + indicateurs + actualités
 * + état du portefeuille + contraintes de risque effectives.
 */
export function buildUserPrompt({ snapshot, news, account, position, budget, constraints }) {
  const ind = snapshot.indicators;
  const candleTable = snapshot.recentCandles
    .map((c) => `${c.t} | O ${c.o} | H ${c.h} | L ${c.l} | C ${c.c} | Vol ${c.v}`)
    .join('\n');

  return `## ACTIF ANALYSÉ
Ticker : ${snapshot.symbol}${news?.companyName ? ` (${news.companyName})` : ''}
Place : ${snapshot.exchange} | Devise : ${snapshot.currency} | Type : ${snapshot.instrumentType}
Prix courant : ${ind.price} ${snapshot.currency}
Unité de temps : ${config.universe.interval}
Horodatage analyse : ${new Date().toISOString()}

## DONNÉES TECHNIQUES
RSI(14) : ${fmt(ind.rsi14)}
MACD : ligne ${fmt(ind.macd.line)} | signal ${fmt(ind.macd.signal)} | histogramme ${fmt(ind.macd.histogram)} | état ${ind.macd.crossover}
EMA20 : ${fmt(ind.ema20)} | EMA50 : ${fmt(ind.ema50)} | SMA200 : ${fmt(ind.sma200)} | tendance ${ind.trend}
Bollinger : bas ${fmt(ind.bollinger.lower)} | milieu ${fmt(ind.bollinger.middle)} | haut ${fmt(ind.bollinger.upper)} => ${ind.bollinger.position}
ATR(14) : ${fmt(ind.atr14)} (${fmt(ind.atrPct, ' %')} du prix)
Volume : ${fmt(ind.volume)} (× ${fmt(ind.volumeVsAvg)} la moyenne 20 périodes)
Variations : ${fmt(ind.change.last1, ' %')} (1 bougie) | ${fmt(ind.change.last5, ' %')} (5) | ${fmt(ind.change.last20, ' %')} (20)
Support récent : ${fmt(ind.support)} | Résistance récente : ${fmt(ind.resistance)}

## 20 DERNIÈRES BOUGIES (OHLCV)
${candleTable}

## ACTUALITÉS RÉCENTES (fenêtre ${config.news.lookbackHours} h)
${formatNews(news)}

## PORTEFEUILLE
Devise de compte : ${account.currency}
Équity totale : ${account.equity.toFixed(2)} ${account.currency}
Liquidités : ${account.cash.toFixed(2)} ${account.currency}
Positions ouvertes : ${account.positionsCount} / ${constraints.maxPositions}
${formatPosition(position, ind.price)}

## CONTRAINTES DU GESTIONNAIRE DE RISQUE (non négociables)
- Budget maximal mobilisable sur ce trade : ${budget.maxNotionalBase.toFixed(2)} ${account.currency}
  (soit environ ${budget.maxQuantity} unité(s) de ${snapshot.symbol} au prix courant)
- ${budget.canBuy ? 'Achat autorisé.' : `Achat INTERDIT ce cycle : ${budget.blockReason}`}
- ${position && position.quantity > 0 ? `Vente autorisée jusqu'à ${position.quantity} unité(s).` : 'Vente impossible : aucune position (la vente à découvert est interdite).'}
- Stop-loss par défaut : ${(constraints.stopLossPct * 100).toFixed(1)} % | Take-profit par défaut : ${(constraints.takeProfitPct * 100).toFixed(1)} %

## TA MISSION
Décide de l'action à mener MAINTENANT sur ${snapshot.symbol} et renvoie le JSON du schéma imposé.`;
}
