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
 * C'est LE facteur dont l'horizon correspond au nôtre. Les actions qui ont
 * chuté sur la semaine écoulée rebondissent en moyenne sur les jours suivants,
 * et l'inverse pour celles qui ont bondi. L'anomalie est documentée avec une
 * corrélation de rang journalière de 0,030 à 0,040 et une demi-vie de 1 à
 * 5 jours — précisément notre horizon de 3 séances.
 *
 * Le signe est INVERSÉ : un rendement récent élevé donne un score BAS. C'est
 * la définition même du retour à la moyenne, et c'est ce qui le distingue du
 * momentum, avec lequel on le confondrait sinon.
 */
export function reversalCourtTerme(candles) {
  const r5 = rendement(candles, 5);
  return r5 == null ? null : -r5;
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
  reversal: {
    label: 'Retour à la moyenne 5 j',
    horizonAdapte: true,
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
