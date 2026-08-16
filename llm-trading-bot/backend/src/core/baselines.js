/**
 * Classements de référence, calculés par formule.
 *
 * ── Pourquoi ce fichier est le plus important du projet ───────────────────
 * Le bot mesure si l'IA bat LE HASARD. Il ne mesure jamais si elle bat UNE
 * FORMULE. C'est pourtant la seule question qui décide si le projet a un sens.
 *
 * Le classement quantitatif d'actions existe depuis quarante ans et ses
 * facteurs ont un pouvoir prédictif documenté : une corrélation de rang de
 * l'ordre de 0,02 à 0,05 selon le facteur et l'horizon. C'est exactement
 * l'ordre de grandeur qu'on espère du modèle de langage — sauf que pour les
 * facteurs, c'est établi.
 *
 * Si l'IA obtient 0,03 et qu'une formule en fait 0,04, elle coûte 450 appels
 * par jour, vingt minutes par cycle et une surface de panne considérable, pour
 * faire MOINS BIEN que trois lignes de calcul. Il faut le savoir.
 *
 * ── Ce que l'IA apporte, en principe ──────────────────────────────────────
 * Elle lit les ACTUALITÉS. Aucune formule ne le fait. C'est le seul argument
 * sérieux en sa faveur dans ce projet, et il est aujourd'hui non démontré.
 * Ce fichier existe pour le mettre à l'épreuve.
 *
 * ── Les facteurs retenus ──────────────────────────────────────────────────
 * Ils ne sont pas choisis au hasard : chacun correspond à une anomalie
 * documentée, et le premier est celui dont l'horizon coïncide avec le nôtre.
 *
 * Le coût est nul : les bougies sont déjà en mémoire, aucun appel réseau,
 * aucun quota consommé.
 */

/**
 * Rendement sur les `n` dernières séances, à partir des clôtures.
 * Renvoie null si l'historique est insuffisant — jamais une valeur inventée.
 */
function rendement(candles, n) {
  if (!candles || candles.length < n + 1) return null;
  const fin = candles[candles.length - 1].close;
  const debut = candles[candles.length - 1 - n].close;
  if (!(debut > 0) || !(fin > 0)) return null;
  return fin / debut - 1;
}

/**
 * ── RETOUR À LA MOYENNE COURT TERME ──────────────────────────────────────
 *
 * Les actions qui ont chuté sur la semaine écoulée rebondissent en moyenne sur
 * les jours suivants. Le signe est INVERSÉ : un rendement récent élevé donne
 * un score BAS.
 *
 * ── CE FACTEUR A LE MAUVAIS SIGNE POUR NOTRE UNIVERS ─────────────────────
 * Il était présenté ici comme « LE facteur dont l'horizon correspond au
 * nôtre ». C'était faux, et l'erreur a failli coûter cher : le classement du
 * LLM corrèle à −0,89 avec lui, et j'ai un moment conclu qu'il fallait
 * inverser le modèle.
 *
 * Ce qui manquait est la condition de LIQUIDITÉ. Le retour à la moyenne n'est
 * pas une propriété des actions, c'est la rémunération du risque d'inventaire
 * des teneurs de marché : ils absorbent un déséquilibre, exigent une décote,
 * et le prix revient quand ils se sont délestés. Sur un titre très échangé,
 * ce délestage est quasi instantané — la décote n'a pas le temps d'exister.
 *
 * Mesuré sur le décile de plus fort taux de rotation, l'effet ne s'affaiblit
 * pas : il S'INVERSE. Le retour à la moyenne y est nul et c'est le momentum
 * court terme qui domine. Or notre univers de 150 grandes capitalisations
 * américaines EST ce décile, par construction.
 *
 * Le facteur reste ici, mais comme TÉMOIN NÉGATIF : on l'attend perdant. S'il
 * gagnait, c'est notre compréhension de l'univers qu'il faudrait revoir.
 */
export function reversalCourtTerme(candles) {
  const r5 = rendement(candles, 5);
  return r5 == null ? null : -r5;
}

/**
 * ── MOMENTUM COURT TERME ─────────────────────────────────────────────────
 *
 * Le même rendement à 5 séances, sans inversion de signe. C'est le facteur
 * dont l'horizon correspond réellement au nôtre.
 *
 * Sur les titres à fort taux de rotation — les plus grandes capitalisations,
 * les plus suivies, les plus liquides — acheter les gagnants récents et vendre
 * les perdants dégage une performance robuste, tandis que la stratégie inverse
 * en perd autant. L'explication tient à deux mécanismes : la sous-réaction à
 * l'information sur des titres complexes, et l'inertie des flux
 * institutionnels, qui fractionnent leurs ordres sur plusieurs séances pour
 * limiter leur impact et prolongent ainsi mécaniquement la tendance.
 *
 * ── Pourquoi c'est le témoin le plus important du carnet ─────────────────
 * Le LLM produit essentiellement ce facteur : son classement corrèle à +0,89
 * avec le rendement 5 séances brut. La comparaison n'est donc plus « le
 * modèle bat-il une formule ? » mais la seule question qui compte
 * économiquement : le modèle apporte-t-il quelque chose EN PLUS de ce que
 * cette ligne de code produit gratuitement ?
 *
 * Si les deux courbes se superposent, l'appel d'API ne sert à rien et il faut
 * garder la formule. C'est cette confrontation-là qui décidera du sort du LLM,
 * et elle ne coûte rien à instrumenter.
 */
export function momentumCourtTerme(candles) {
  return rendement(candles, 5);
}

/**
 * ── MOMENTUM 12-1 ────────────────────────────────────────────────────────
 *
 * Le facteur le plus célèbre de la finance quantitative : les gagnants des
 * douze derniers mois continuent de gagner. On exclut le dernier mois, parce
 * qu'il est dominé par le retour à la moyenne ci-dessus — les inclure ferait
 * s'annuler les deux effets.
 *
 * On l'attend FAIBLE à un horizon de 3 jours : sa demi-vie se compte en mois.
 * Il est inclus comme témoin, précisément pour vérifier que la mesure sait
 * distinguer un facteur adapté à l'horizon d'un facteur inadapté. Un momentum
 * qui ressortirait aussi fort que le reversal signalerait un défaut de mesure.
 */
export function momentum(candles) {
  if (!candles || candles.length < 252) return null;
  const fin = candles[candles.length - 1 - 21]?.close;  // il y a un mois
  const debut = candles[candles.length - 252]?.close;   // il y a un an
  if (!(debut > 0) || !(fin > 0)) return null;
  return fin / debut - 1;
}

/**
 * ── FAIBLE VOLATILITÉ ────────────────────────────────────────────────────
 *
 * Les actions peu volatiles offrent historiquement un meilleur rendement
 * ajusté du risque que les agitées — anomalie persistante et contraire au
 * modèle d'évaluation des actifs financiers.
 *
 * Signe inversé : moins de volatilité, meilleur score. Le facteur est lent, il
 * sert surtout de second témoin.
 */
export function faibleVolatilite(indicators) {
  const atrPct = indicators?.atrPct;
  return Number.isFinite(atrPct) && atrPct > 0 ? -atrPct : null;
}

/**
 * ── SURVENTE TECHNIQUE ───────────────────────────────────────────────────
 *
 * Le RSI est déjà calculé pour le prompt du modèle. On l'utilise ici comme
 * facteur autonome : sous 30 l'actif est dit survendu, au-dessus de 70
 * suracheté. C'est une lecture de retour à la moyenne, cousine du premier
 * facteur mais construite sur une fenêtre différente et lissée autrement.
 *
 * Centré sur 50 puis inversé, pour que « survendu » donne un score positif.
 */
export function surventeRsi(indicators) {
  const rsi = indicators?.rsi14;
  return Number.isFinite(rsi) ? (50 - rsi) / 50 : null;
}

/** Les facteurs disponibles, avec leur mode de calcul. */
export const FACTEURS = {
  // Le concurrent sérieux du LLM : c'est lui qu'il doit battre pour justifier
  // son coût, puisque c'est essentiellement lui qu'il reproduit.
  momentumCourt: {
    label: 'Momentum 5 j',
    horizonAdapte: true,
    calc: ({ candles }) => momentumCourtTerme(candles),
  },
  // Témoin NÉGATIF : attendu perdant sur un univers aussi liquide. S'il gagne,
  // c'est la lecture de l'univers qu'il faut réviser, pas le facteur.
  reversal: {
    label: 'Retour à la moyenne 5 j',
    horizonAdapte: false,
    calc: ({ candles }) => reversalCourtTerme(candles),
  },
  momentum: {
    label: 'Momentum 12-1',
    horizonAdapte: false,
    calc: ({ candles }) => momentum(candles),
  },
  volatilite: {
    label: 'Faible volatilité',
    horizonAdapte: false,
    calc: ({ indicators }) => faibleVolatilite(indicators),
  },
  rsi: {
    label: 'Survente RSI',
    horizonAdapte: true,
    calc: ({ indicators }) => surventeRsi(indicators),
  },
};

/**
 * Calcule tous les facteurs pour un actif, à partir des données DÉJÀ chargées.
 *
 * Aucune requête réseau : les bougies et les indicateurs viennent du même
 * instantané que celui envoyé au modèle. Les deux classements voient donc
 * exactement la même information de marché — c'est la condition pour que la
 * comparaison soit honnête. La seule différence entre eux est que le modèle
 * voit EN PLUS les actualités.
 */
export function facteursPour({ candles, indicators }) {
  const out = {};
  for (const [nom, f] of Object.entries(FACTEURS)) {
    out[nom] = f.calc({ candles, indicators });
  }
  return out;
}

/**
 * Transforme les scores bruts en rangs transversaux, facteur par facteur.
 *
 * ── Pourquoi des rangs et non les scores bruts ────────────────────────────
 * Les facteurs n'ont pas la même unité : un rendement en pourcentage, un ATR
 * en pourcentage, un RSI centré. Les comparer bruts n'aurait aucun sens. Le
 * rang les ramène sur une échelle commune, et c'est de toute façon la seule
 * information qu'on exploite — le classement du modèle est lui aussi ordinal.
 *
 * Les ex æquo reçoivent le rang moyen : les départager par l'ordre d'arrivée
 * fabriquerait de la corrélation à partir de rien.
 *
 * @param {Array<{symbol: string, facteurs: object}>} lignes
 * @returns {Map<string, object>} symbole → { reversal: {rang, fractionnaire}, … }
 */
export function classerFacteurs(lignes) {
  const parSymbole = new Map();
  for (const l of lignes) parSymbole.set(l.symbol, {});

  for (const nom of Object.keys(FACTEURS)) {
    const valides = lignes
      .filter((l) => Number.isFinite(l.facteurs?.[nom]))
      .map((l) => ({ symbol: l.symbol, v: l.facteurs[nom] }));

    if (valides.length < 2) continue;

    // Tri décroissant : le meilleur score obtient le rang 1.
    valides.sort((a, b) => b.v - a.v);

    // Rangs moyens sur les ex æquo.
    let i = 0;
    while (i < valides.length) {
      let j = i;
      while (j + 1 < valides.length && valides[j + 1].v === valides[i].v) j += 1;
      const rangPartage = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) {
        parSymbole.get(valides[k].symbol)[nom] = {
          rang: rangPartage,
          total: valides.length,
          fractionnaire: valides.length > 1 ? 1 - (rangPartage - 1) / (valides.length - 1) : 1,
          score: valides[k].v,
        };
      }
      i = j + 1;
    }
  }

  return parSymbole;
}

/**
 * Dispersion transversale d'un facteur, pour comparer sa RÉSOLUTION à celle
 * du modèle.
 *
 * C'est la mesure qui répond à une observation déjà faite en production : le
 * modèle a produit trois valeurs distinctes seulement (35, 40, 45) sur vingt
 * réponses. Un facteur numérique produit autant de valeurs distinctes qu'il y
 * a d'actifs. Si le classement du modèle n'a pas de résolution, aucun réglage
 * de la règle de sortie n'y changera rien — et ce chiffre le dira.
 */
export function resolutionFacteur(lignes, nom) {
  const v = lignes.map((l) => l.facteurs?.[nom]).filter(Number.isFinite);
  if (v.length < 2) return null;
  return {
    n: v.length,
    valeursDistinctes: new Set(v.map((x) => x.toFixed(6))).size,
    partDistinctes: new Set(v.map((x) => x.toFixed(6))).size / v.length,
  };
}
