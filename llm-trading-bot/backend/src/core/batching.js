/**
 * Découpage de l'univers en lots comparables.
 *
 * ── Le calcul qui rend la refonte possible ────────────────────────────────
 * Comparer 150 actifs deux à deux coûterait 11 175 appels : hors de question
 * sous un quota d'environ 1 000 par jour. Mais on n'a pas besoin de toutes les
 * paires. Demander au modèle d'ORDONNER un lot de dix produit 9 informations de
 * choix successives en un seul appel, et l'ajustement de Plackett-Luce sait
 * recoller des classements partiels qui se recoupent.
 *
 * À dix par lot et quatre tours de re-partitionnement aléatoire :
 *
 *     150 / 10 × 4 = 60 appels par cycle
 *
 * contre 150 en notation individuelle. La refonte DIVISE le coût par 2,5 tout
 * en produisant un ordre au lieu de notes agglutinées.
 *
 * ── Pourquoi re-partitionner au hasard plutôt que des lots fixes ──────────
 * Avec des lots fixes, aucun actif du lot 1 n'affronte jamais un actif du lot 2 :
 * le graphe des comparaisons est constitué de quinze composantes isolées et les
 * forces latentes de deux lots ne sont pas comparables. Recoller quinze
 * classements sans recouvrement est mathématiquement impossible.
 *
 * Un mélange complet à chaque tour rend le graphe connexe avec une probabilité
 * écrasante dès le deuxième tour, sans avoir à concevoir un plan d'expérience.
 * La connexité reste vérifiée explicitement en aval — on ne la suppose pas.
 *
 * ── Le nombre de tours est un arbitrage mesuré, pas un réglage ────────────
 * Mesuré par simulation, à 150 actifs et un signal d'écart-type 0,3 :
 *
 *     2 tours (30 appels) → puissance 19 %
 *     3 tours (45 appels) → puissance 31 %
 *     4 tours (60 appels) → puissance 51 %
 *     6 tours (90 appels) → puissance 68 %
 *
 * Quatre tours placent le bot au-dessus de la moitié de chances de détecter un
 * signal réel, pour 180 appels par jour sur trois cycles — le cinquième du
 * quota. C'est le point où la courbe commence à s'aplatir.
 */

import { createLogger } from '../logger.js';

const log = createLogger('lots');

export const TAILLE_LOT = 10;
export const TOURS = 4;

/** Générateur reproductible. Un cycle rejoué donne exactement les mêmes lots. */
function mulberry32(a) {
  return function suivant() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function melanger(tableau, rnd) {
  const m = [...tableau];
  for (let i = m.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [m[i], m[j]] = [m[j], m[i]];
  }
  return m;
}

/**
 * Construit les lots d'un cycle.
 *
 * ── L'ordre de PRÉSENTATION est mélangé, et c'est délibéré ────────────────
 * Un LLM favorise systématiquement les premiers éléments d'une liste — biais de
 * primauté, conséquence directe de la structure de l'attention. Présenter les
 * actifs toujours dans le même ordre transformerait ce biais en effet
 * systématique sur le classement final.
 *
 * Le mélange aléatoire à chaque tour fait qu'un même actif occupe des positions
 * différentes d'un lot à l'autre : le biais devient du bruit centré, que
 * l'ajustement absorbe. La position de présentation est CONSERVÉE dans la
 * sortie pour qu'on puisse mesurer l'ampleur du biais au lieu de la supposer
 * négligeable.
 *
 * @param {string[]} symboles   l'univers évaluable de ce cycle
 * @param {object}   options
 * @returns {{lots: Array, tours: number, taille: number}}
 */
export function construireLots(symboles, { taille = TAILLE_LOT, tours = TOURS, graine = Date.now() } = {}) {
  const utiles = [...new Set(symboles)].filter(Boolean);

  if (utiles.length < 2) {
    return { lots: [], tours: 0, taille, raison: 'moins de deux actifs évaluables' };
  }

  const effectif = Math.min(taille, utiles.length);
  const rnd = mulberry32(graine >>> 0);
  const lots = [];

  for (let tour = 0; tour < tours; tour += 1) {
    const melange = melanger(utiles, rnd);

    for (let i = 0; i < melange.length; i += effectif) {
      let membres = melange.slice(i, i + effectif);

      // Un reliquat d'un seul actif ne peut pas être classé — il n'a personne à
      // qui être comparé. On le rattache au lot précédent plutôt que de le
      // perdre : un lot de onze est sans conséquence, un actif jamais évalué
      // sortirait silencieusement de l'univers.
      if (membres.length < 2 && lots.length) {
        lots[lots.length - 1].membres.push(...membres);
        continue;
      }
      if (membres.length < 2) continue;

      lots.push({
        id: `t${tour + 1}-l${lots.length + 1}`,
        tour: tour + 1,
        membres,
      });
    }
  }

  log.info(
    `${lots.length} lots construits sur ${utiles.length} actifs `
    + `(${tours} tours × ${Math.ceil(utiles.length / effectif)} lots de ${effectif})`,
  );

  return { lots, tours, taille: effectif, univers: utiles.length };
}

/**
 * Position moyenne de présentation de chaque actif.
 *
 * Sert au diagnostic de biais de position : si le classement final corrèle avec
 * la position moyenne de présentation, c'est que le mélange n'a pas suffi à
 * neutraliser le biais de primauté, et le classement mesure en partie l'ordre
 * dans lequel on a posé la question.
 */
export function positionsMoyennes(lots) {
  const cumul = new Map();
  for (const lot of lots) {
    lot.membres.forEach((symbol, i) => {
      const e = cumul.get(symbol) || { somme: 0, n: 0 };
      // Position normalisée dans [0, 1] : comparable entre lots de tailles
      // différentes.
      e.somme += lot.membres.length > 1 ? i / (lot.membres.length - 1) : 0.5;
      e.n += 1;
      cumul.set(symbol, e);
    });
  }
  const out = new Map();
  for (const [symbol, e] of cumul) out.set(symbol, e.somme / e.n);
  return out;
}

/**
 * Corrélation entre le rang obtenu et la position de présentation.
 *
 * Attendue nulle. Significativement négative = le modèle privilégie ce qu'on
 * lui montre en premier, et le classement est en partie un artefact.
 */
export function biaisDePosition(ranks, positions) {
  const paires = [];
  for (const [symbol, info] of ranks) {
    const pos = positions.get(symbol);
    if (pos != null && info?.rank != null) paires.push([info.rank, pos]);
  }
  if (paires.length < 3) return { correlation: null, n: paires.length };

  const n = paires.length;
  const mx = paires.reduce((a, p) => a + p[0], 0) / n;
  const my = paires.reduce((a, p) => a + p[1], 0) / n;
  let num = 0; let dx = 0; let dy = 0;
  for (const [x, y] of paires) {
    num += (x - mx) * (y - my);
    dx += (x - mx) ** 2;
    dy += (y - my) ** 2;
  }
  const denom = Math.sqrt(dx * dy);
  return { correlation: denom > 0 ? num / denom : 0, n };
}
