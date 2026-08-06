import { config } from '../config.js';
import { anonymizeNews } from './anonymize.js';

/**
 * Schéma de sortie imposé au modèle.
 *
 * ── L'ORDRE DES CHAMPS EST LA PARTIE LA PLUS IMPORTANTE ───────────────────
 * Un LLM génère en autorégressif : chaque champ est conditionné par ceux qui
 * précèdent. L'ordre n'est donc pas cosmétique, c'est le mécanisme même du
 * contrôle :
 *
 *   1. `evidence`   — le modèle doit d'abord RECOPIER les chiffres du prompt.
 *                     Vérifiable numériquement : s'il cite un prix absent,
 *                     c'est une hallucination détectée avant toute décision.
 *   2. `checks`     — grille booléenne, pas de texte libre. Le CoT narratif
 *                     produit de la rationalisation a posteriori et gonfle la
 *                     confiance surtout quand la réponse est FAUSSE.
 *   3. `pre_mortem` — il doit énoncer ce qui invaliderait sa thèse AVANT de
 *                     chiffrer sa prévision. Un argument contraire formulé
 *                     après coup ne sert qu'à décorer ; formulé avant, il
 *                     déplace réellement les nombres qui suivent.
 *   4. `forecast`   — la prévision, en fréquences sur 100 scénarios.
 *   5. `risk_math`  — il calcule sa perte maximale AVANT de recommander quoi
 *                     que ce soit. Ancrer l'attention sur la borne de risque
 *                     réprime l'overtrading.
 *   6. `action`     — sa recommandation, qui n'est PAS ce qu'on exécute.
 *
 * ── POURQUOI UNE PRÉVISION ET NON UNE DÉCISION ────────────────────────────
 * Le modèle ne choisit plus. Il répartit 100 scénarios entre surperformance,
 * sous-performance et indécision ; le seuil de passage à l'acte est appliqué
 * côté code (config.risk.minEdge). Trois raisons :
 *
 *   • Le biais d'inaction du RLHF s'exerce sur « que faire », pas sur « que se
 *     passera-t-il ». On contourne le réflexe prudent sans pousser au trade :
 *     c'est nous qui fixons le seuil, donc l'agressivité reste un paramètre
 *     visible et modifiable, pas un trait de caractère du modèle.
 *   • L'événement prédit devient VÉRIFIABLE terme à terme contre ce que
 *     mesure déjà le carnet fantôme (rendement excédentaire vs indice). Une
 *     « confiance dans ma décision » ne se confronte à rien de bien défini ;
 *     une fréquence annoncée sur un événement daté, si.
 *   • Le cadrage fréquentiste (« sur 100 scénarios ») casse l'agglutination
 *     des réponses sur 0,7 / 0,8 / 0,9 que produit la demande de « confiance ».
 *
 * `action` est conservé sans être exécuté : l'écart entre ce que le modèle
 * recommande et ce que sa propre prévision implique MESURE le biais d'inaction
 * au lieu de le supposer.
 *
 * `justification` vient en dernier : c'est un commentaire pour l'humain, il ne
 * doit surtout pas conditionner la décision.
 */
export const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    evidence: {
      type: 'object',
      description: 'Recopie EXACTE des valeurs du prompt. Toute invention est détectée.',
      properties: {
        cited_price: { type: 'number', description: 'Le prix courant, tel qu\'écrit dans le prompt.' },
        cited_rsi: { type: 'number', description: 'Le RSI(14), tel qu\'écrit dans le prompt.' },
        cited_atr_pct: { type: 'number', description: 'L\'ATR en % du prix, tel qu\'écrit dans le prompt.' },
        cited_budget: { type: 'number', description: 'Le budget maximal autorisé, tel qu\'écrit dans le prompt.' },
      },
      required: ['cited_price', 'cited_rsi', 'cited_atr_pct', 'cited_budget'],
    },

    checks: {
      type: 'object',
      description: 'Évaluations booléennes indépendantes. Réponds par vrai/faux, sans nuance.',
      properties: {
        momentum_favorable: { type: 'boolean', description: 'Le RSI soutient-il une entrée à la hausse ?' },
        trend_favorable: { type: 'boolean', description: 'La structure de tendance soutient-elle une entrée à la hausse ?' },
        news_confirms: { type: 'boolean', description: 'Les actualités vont-elles dans le même sens que la technique ?' },
        volatility_acceptable: { type: 'boolean', description: 'La volatilité permet-elle de tenir la position sans être sorti par le bruit ?' },
      },
      required: ['momentum_favorable', 'trend_favorable', 'news_confirms', 'volatility_acceptable'],
    },

    news_sentiment: { type: 'string', enum: ['POSITIF', 'NEUTRE', 'NEGATIF', 'INDISPONIBLE'] },

    pre_mortem: {
      type: 'object',
      description:
        'Avant de chiffrer : suppose que ta thèse se révèle FAUSSE dans 7 séances. Explique pourquoi.',
      properties: {
        scenario_defavorable: {
          type: 'string',
          description: 'Le mécanisme le plus plausible par lequel tu te trompes ici. Une phrase concrète, pas une généralité sur le risque de marché.',
        },
        signal_le_plus_fragile: {
          type: 'string',
          description: 'Parmi les données fournies, laquelle soutient le moins bien ta lecture ?',
        },
      },
      required: ['scenario_defavorable', 'signal_le_plus_fragile'],
    },

    forecast: {
      type: 'object',
      description:
        'Imagine 100 marchés indépendants dans EXACTEMENT cette configuration de données. '
        + 'Répartis-les entre les trois issues, à 3 séances. Les trois nombres totalisent 100.',
      properties: {
        // Entiers et non fractions : demander « 34 sur 100 » plutôt que « 0,34 »
        // produit des valeurs nettement moins agglutinées sur les nombres
        // ronds, et le modèle raisonne mieux sur des effectifs que sur des
        // probabilités abstraites.
        sur_100_surperforme: {
          type: 'integer',
          description: 'Dans combien de ces 100 marchés l\'actif fait-il MIEUX que l\'indice de référence de plus de 0,5 % ?',
        },
        sur_100_sousperforme: {
          type: 'integer',
          description: 'Dans combien fait-il MOINS BIEN que l\'indice de plus de 0,5 % ?',
        },
        sur_100_indistinct: {
          type: 'integer',
          description: 'Dans combien l\'écart avec l\'indice reste-t-il sous 0,5 % en valeur absolue ?',
        },
      },
      required: ['sur_100_surperforme', 'sur_100_sousperforme', 'sur_100_indistinct'],
    },

    risk_math: {
      type: 'object',
      description: 'Calcule la perte maximale AVANT de décider.',
      properties: {
        proposed_notional: { type: 'number', description: 'Montant en dollars que tu proposes d\'engager.' },
        stop_distance_pct: { type: 'number', description: 'Distance au stop, estimée à 4 × ATR%, en fraction (ex : 0.11).' },
        max_loss_dollars: { type: 'number', description: 'proposed_notional × stop_distance_pct.' },
      },
      required: ['proposed_notional', 'stop_distance_pct', 'max_loss_dollars'],
    },

    // Recommandation du modèle. Elle n'est PAS exécutée : l'action réelle est
    // déduite de `forecast` par le code. On la lui demande quand même, pour
    // pouvoir mesurer l'écart entre ce qu'il conseille et ce que sa propre
    // prévision implique.
    action: { type: 'string', enum: ['BUY', 'SELL', 'HOLD'], description: 'Ce que tu recommanderais, à titre indicatif.' },
    risk_flags: { type: 'array', items: { type: 'string' }, description: 'Risques identifiés.' },
    justification: { type: 'string', description: 'Une phrase en français croisant technique ET actualités.' },
  },
  // Ni `confidence` ni `size_pct` ne sont demandés : le premier est déduit de
  // `forecast`, le second de l'écart de probabilité. Deux nombres arbitraires
  // en moins à la charge du modèle.
  required: ['evidence', 'checks', 'news_sentiment', 'pre_mortem', 'forecast', 'risk_math', 'action', 'justification'],
};

export const SYSTEM_PROMPT = `Tu es un moteur d'inférence quantitative opérant sous contraintes de risque strictes.
Tu n'émets aucune opinion narrative. Tu remplis une grille d'évaluation.

L'actif est ANONYMISÉ : tu ne connais ni son nom ni son secteur. C'est délibéré.
Tu dois juger uniquement sur les données fournies, sans mobiliser de souvenir sur une entreprise
que tu croirais reconnaître. Toute tentative d'identifier l'actif dégrade ton évaluation.

MÉTHODE IMPOSÉE, dans cet ordre strict :
1. RECOPIE les valeurs numériques demandées dans "evidence", exactement telles qu'écrites.
2. Remplis la grille "checks" : quatre booléens indépendants, sans nuance.
3. Rédige le "pre_mortem" : par quel mécanisme te trompes-tu ici ?
4. Chiffre "forecast" : la répartition de 100 scénarios entre les trois issues.
5. Calcule "risk_math" : le montant engagé et la perte encourue si le stop est touché.
6. SEULEMENT ENSUITE, donne ta recommandation indicative.

TA TÂCHE N'EST PAS DE DÉCIDER, C'EST DE PRÉVOIR.
Tu ne passes aucun ordre. Tu estimes une fréquence : sur 100 marchés placés dans exactement
cette configuration de données, combien voient l'actif battre son indice de référence ?
Le seuil de passage à l'acte est appliqué ailleurs, tu n'as pas à en tenir compte.
N'essaie donc ni d'être prudent ni d'être audacieux — essaie d'avoir raison en fréquence.

COMMENT RÉPARTIR LES 100 SCÉNARIOS :
- Une répartition proche de 45/45/10 est la réponse HONNÊTE quand les données ne penchent pas.
  C'est le cas le plus fréquent, et l'annoncer n'est pas un échec.
- Ne t'écarte de l'équilibre qu'à proportion de ce que les données montrent réellement.
  Un écart de 30 points suppose un signal net et convergent, pas une impression.
- Sur trois séances, l'essentiel du mouvement d'un titre est du bruit et le reste suit son
  indice. Un écart supérieur à 70/30 n'est presque jamais justifiable.
- Actualités indisponibles => "news_confirms" est faux, et resserre la répartition vers
  l'équilibre : il te manque une des deux sources.

CONTRAINTES FACTUELLES :
- Le découvert est impossible : une baisse anticipée ne se joue que par la sortie d'une
  position déjà ouverte.
- La grille "checks" reste requise : au moins 3 booléens vrais sont nécessaires pour qu'une
  ouverture soit autorisée en aval, quelle que soit ta prévision.

COMMENT TA PRÉVISION SERA JUGÉE :
Chaque répartition est confrontée au rendement réellement observé face à l'indice. On mesure
si tes fréquences annoncées correspondent aux fréquences constatées : annoncer 80 et avoir
raison 55 fois sur 100 est une erreur, même quand la direction est bonne. Un modèle qui
annonce 55 et a raison 55 fois vaut mieux qu'un modèle qui annonce 90 et a raison 70 fois.`;

const fmt = (v, suffix = '') => (v == null || Number.isNaN(v) ? 'n/d' : `${v}${suffix}`);

/**
 * Résumé macro en langage naturel.
 *
 * Le rapport sur le prompting est catégorique : déverser des centaines de
 * bougies brutes sature la fenêtre d'attention utile et provoque de
 * l'instabilité décisionnelle. La parade est la multi-résolution — une phrase
 * pour le long terme, trois indicateurs pour le moyen, dix bougies pour le
 * court. On obtient l'amplitude d'une longue fenêtre avec la précision d'une
 * courte.
 */
function macroSummary(candles, indicators) {
  if (!candles?.length) return 'Historique indisponible.';

  const closes = candles.map((c) => c.close);
  const first = closes[0];
  const last = closes[closes.length - 1];
  const yearChange = ((last - first) / first) * 100;

  const vsSma200 = indicators.sma200 ? ((last - indicators.sma200) / indicators.sma200) * 100 : null;

  // Volatilité réalisée récente comparée à celle de l'année : le régime a-t-il changé ?
  const recentVol = realizedVol(closes.slice(-21));
  const yearVol = realizedVol(closes);
  const regime = recentVol && yearVol
    ? recentVol > yearVol * 1.3 ? 'en expansion' : recentVol < yearVol * 0.7 ? 'en contraction' : 'stable'
    : 'indéterminé';

  return [
    `Sur ${candles.length} séances : ${yearChange >= 0 ? '+' : ''}${yearChange.toFixed(1)} %.`,
    vsSma200 != null
      ? `Prix ${vsSma200 >= 0 ? 'au-dessus' : 'en dessous'} de la moyenne 200 jours de ${Math.abs(vsSma200).toFixed(1)} %.`
      : '',
    `Régime de volatilité ${regime}.`,
  ].filter(Boolean).join(' ');
}

/**
 * Repères factuels autour des trois indicateurs.
 *
 * Les rapports sur le prompting recommandent de « narrativiser » les
 * indicateurs plutôt que de livrer des nombres nus, un LLM raisonnant mieux sur
 * une grandeur située que sur un scalaire isolé. J'applique la recommandation
 * en n'en gardant que la moitié défendable : on fournit des POINTS DE
 * COMPARAISON — seuils conventionnels, médiane récente, centile dans la
 * fourchette — et jamais leur interprétation.
 *
 * Écrire « RSI en zone haute, essoufflement probable » ferait l'analyse à la
 * place du modèle et injecterait notre propre biais dans ce qu'on prétend
 * mesurer chez lui. Écrire « RSI 68,3, seuil conventionnel de surachat à 70 »
 * lui donne l'échelle sans lui souffler la conclusion. La distinction est
 * mince à la lecture et décisive pour la validité de la mesure.
 */
function indicatorContext(candles, ind) {
  const out = {};

  if (candles?.length >= 20) {
    const window = candles.slice(-60);

    // Médiane du true range en % du prix : directement comparable à l'ATR(14),
    // qui est un true range lissé.
    const ranges = [];
    for (let i = 1; i < window.length; i += 1) {
      const c = window[i];
      const prevClose = window[i - 1].close;
      const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
      if (c.close > 0) ranges.push((tr / c.close) * 100);
    }
    const medianTr = median(ranges);
    if (medianTr != null && ind.atrPct != null && medianTr > 0) {
      const ratio = ind.atrPct / medianTr;
      out.atr = `médiane des ${window.length} dernières séances : ${medianTr.toFixed(2)} %, `
        + `soit ${ratio.toFixed(2)}× cette normale récente`;
    }

    // Centile du prix dans sa propre fourchette récente : situe le niveau sans
    // le qualifier.
    const closes = window.map((c) => c.close).filter((v) => v > 0);
    if (closes.length >= 20 && ind.price > 0) {
      const below = closes.filter((v) => v < ind.price).length;
      out.range = `${Math.round((below / closes.length) * 100)}ᵉ centile de la fourchette des `
        + `${closes.length} dernières séances (bas ${Math.min(...closes).toFixed(2)}, haut ${Math.max(...closes).toFixed(2)})`;
    }
  }

  if (ind.ema20 != null && ind.ema50 != null && ind.ema50 > 0) {
    const gap = ((ind.ema20 - ind.ema50) / ind.ema50) * 100;
    out.trend = `écart EMA20/EMA50 ${gap >= 0 ? '+' : ''}${gap.toFixed(2)} %`;
  }

  return out;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function realizedVol(closes) {
  if (closes.length < 5) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i += 1) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance);
}

function formatNews(articles, degraded, errors) {
  if (degraded || !articles.length) {
    return `AUCUNE ACTUALITÉ DISPONIBLE (${errors?.join(' ; ') || 'raison inconnue'}).
=> news_confirms doit être faux, et size_pct ne doit pas dépasser 0,5.`;
  }

  return articles
    .map((a, i) => {
      const when = a.publishedAt
        ? new Date(a.publishedAt).toISOString().slice(0, 16).replace('T', ' ')
        : 'date inconnue';
      const summary = a.summary ? ` — ${a.summary.slice(0, 200)}` : '';
      return `${i + 1}. [${when}] (${a.source}) ${a.title}${summary}`;
    })
    .join('\n');
}

function formatPosition(position, price) {
  if (!position || position.quantity <= 0) return 'AUCUNE position ouverte sur cet actif.';
  const pnlPct = ((price - position.avgPrice) / position.avgPrice) * 100;
  return `POSITION OUVERTE : ${position.quantity} unité(s), prix moyen ${position.avgPrice}, ` +
    `P&L latent ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)} %, stop en place ${fmt(position.stopPrice)}.`;
}

/**
 * Construit le prompt utilisateur.
 *
 * Trois indicateurs SEULEMENT, choisis orthogonaux (momentum / tendance /
 * volatilité). Passer de 5 à 18 variables dégrade la généralisation : le
 * modèle surpondère les caractéristiques explicites et cesse de chercher les
 * corrélations latentes. Fournir trois moyennes mobiles différentes serait le
 * type même de redondance à éviter.
 */
export function buildUserPrompt({ snapshot, news, account, position, budget, constraints, calendar }) {
  const ind = snapshot.indicators;
  const price = ind.price;

  // Anonymisation avant toute mise en forme.
  const anonymized = config.news.anonymize
    ? anonymizeNews(news, snapshot.symbol)
    : { articles: news?.articles ?? [], redactions: 0 };

  const candleTable = snapshot.recentCandles
    .map((c) => `${c.t} | O ${c.o} | H ${c.h} | L ${c.l} | C ${c.c}`)
    .join('\n');

  const ctx = indicatorContext(snapshot.candles, ind);

  const stopPct = Math.min(
    Math.max((constraints.stopAtrMultiple * (ind.atr14 ?? 0)) / price, constraints.stopMinPct),
    constraints.stopMaxPct,
  );

  return `## ACTIF ANALYSÉ : [ENTREPRISE_A]
Prix courant : ${price} USD
Unité de temps : bougies journalières | Horizon de détention visé : 1 à 7 séances

## PERSPECTIVE LONG TERME
${macroSummary(snapshot.candles, ind)}

## TROIS INDICATEURS (momentum / tendance / volatilité)
Momentum   — RSI(14) : ${fmt(ind.rsi14)} | seuils conventionnels : 30 survente, 70 surachat
Tendance   — ${ind.trend} | EMA20 ${fmt(ind.ema20)} vs EMA50 ${fmt(ind.ema50)}${ctx.trend ? ` | ${ctx.trend}` : ''}
Volatilité — ATR(14) : ${fmt(ind.atrPct, ' %')} du prix${ctx.atr ? ` | ${ctx.atr}` : ''}
${ctx.range ? `Niveau     — ${ctx.range}` : ''}

## 10 DERNIÈRES SÉANCES
${candleTable}

## ACTUALITÉS (fenêtre ${config.news.lookbackHours} h, entités masquées)
${formatNews(anonymized.articles, news?.degraded, news?.errors)}
${calendar && calendar.phase !== 'NEUTRAL' ? `\n## CONTEXTE CALENDAIRE\nJour de bourse ${calendar.label}, phase ${calendar.phase}.\n${calendar.note}\n` : ''}
## PORTEFEUILLE
Équity ${account.equity.toFixed(2)} USD | Liquidités ${account.cash.toFixed(2)} USD | Positions ${account.positionsCount}/${constraints.maxPositions}
${formatPosition(position, price)}

## CONTRAINTES NON NÉGOCIABLES
Budget maximal mobilisable : ${budget.maxNotionalBase.toFixed(2)} USD
${budget.canBuy ? 'Achat autorisé.' : `Achat INTERDIT : ${budget.blockReason}`}
${position && position.quantity > 0 ? `Vente autorisée jusqu'à ${position.quantity} unité(s).` : 'Vente impossible : aucune position (découvert interdit).'}
Stop qui sera posé : ${(stopPct * 100).toFixed(1)} % sous le prix d'entrée (4 × ATR, borné).

## CE QUE TU DOIS PRÉVOIR
L'indice de référence est un panier large du marché actions américain. Ta prévision porte sur
l'écart entre cet actif et cet indice, sur les 3 prochaines séances — pas sur la hausse ou la
baisse du marché lui-même. Un actif qui perd 2 % quand l'indice perd 4 % SURPERFORME.

## TA TÂCHE
Remplis le schéma JSON dans l'ordre : evidence, checks, pre_mortem, forecast, risk_math, action.
Les trois nombres de "forecast" doivent totaliser exactement 100.`;
}

/** Valeurs de référence pour vérifier l'ancrage des preuves du modèle. */
export function expectedEvidence({ snapshot, budget }) {
  return {
    cited_price: snapshot.indicators.price,
    cited_rsi: snapshot.indicators.rsi14,
    cited_atr_pct: snapshot.indicators.atrPct,
    cited_budget: Number(budget.maxNotionalBase.toFixed(2)),
  };
}
