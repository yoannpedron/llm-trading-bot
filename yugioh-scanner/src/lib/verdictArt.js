/**
 * De l'identification par illustration à une décision, et à un résultat.
 *
 * Une passe rend une carte, un score et une MARGE (l'écart avec la deuxième
 * carte). Trois zones, mesurées sur le banc étendu (`scripts/art-bench.mjs` :
 * 200 cartes connues, 60 cartes absentes de l'index, 40 scènes sans carte) :
 *
 *   - **sûre** : score ≥ 0,85 et marge ≥ 0,05, OU score ≥ 0,75 et marge ≥ 0,12.
 *     La carte est verrouillée à cette image. Mesuré : 77,5 % des bonnes
 *     cartes, 0,5 % de mauvaises sur les scènes connues (une sur 200), 0 %
 *     sur les cartes inconnues, 0 % sur les scènes sans carte ;
 *   - **à proposer** : score ≥ 0,70 et marge ≥ 0,03. On ne tranche pas : les
 *     trois meilleures cartes sont proposées à l'utilisateur, qui touche la
 *     sienne. Mesuré : la bonne est dans les trois dans 8 cas sur 19 ; 13
 *     scènes négatives sur 60 déclenchent une proposition — un dérangement,
 *     pas une erreur ;
 *   - **rien** : en dessous, la passe ne compte pas.
 *
 * Pourquoi la marge et non une confirmation par une deuxième image : sur un
 * téléphone posé devant une carte, deux images successives sont presque
 * identiques, et une mauvaise lecture se répète telle quelle. Une première
 * version acceptait « deux images d'accord » entre 0,70 et 0,85 ; c'est
 * l'explication la plus probable des fausses cartes vues sur l'appareil.
 * Une marge de 0,12 n'a laissé passer aucune scène négative sur le banc.
 */

import { cardFromIndex } from './cardIndex.js';

export const SCORE_SUR = 0.85;
export const MARGE_SURE = 0.05;
export const SCORE_FERME = 0.75;
export const MARGE_FERME = 0.12;
export const SCORE_PROPOSE = 0.7;
export const MARGE_PROPOSE = 0.03;
export const NOMBRE_PROPOSITIONS = 3;

/**
 * La zone d'une passe.
 *
 * @param {Array<{id: number, score: number}>} candidats triés par score décroissant
 * @returns {{zone: 'sure'|'proposer'|'rien', id: number|null, score: number, marge: number,
 *   propositions: Array<{id: number, score: number}>}}
 */
export function zoneDe(candidats) {
  const premier = candidats?.[0];
  if (!premier) return { zone: 'rien', id: null, score: 0, marge: 0, propositions: [] };
  const marge = premier.score - (candidats[1]?.score ?? 0);
  const sure =
    (premier.score >= SCORE_SUR && marge >= MARGE_SURE) || (premier.score >= SCORE_FERME && marge >= MARGE_FERME);
  if (sure) return { zone: 'sure', id: premier.id, score: premier.score, marge, propositions: [] };
  if (premier.score >= SCORE_PROPOSE && marge >= MARGE_PROPOSE) {
    return { zone: 'proposer', id: premier.id, score: premier.score, marge, propositions: candidats.slice(0, NOMBRE_PROPOSITIONS) };
  }
  return { zone: 'rien', id: null, score: premier.score, marge, propositions: [] };
}

/**
 * Le verdict d'une suite de passes. Sans mémoire désormais : la décision
 * tient à la passe seule (voir l'en-tête). La classe reste pour que le viseur
 * garde un point d'appel unique, et pour `reset()`.
 */
export class VoteArt {
  /**
   * @param {Array<{id: number, score: number}>} candidats triés par score
   * @returns {{accepted: boolean, id: number|null, score: number, marge: number, zone: string,
   *   propositions: Array<{id: number, score: number}>}}
   */
  cast(candidats) {
    const z = zoneDe(candidats);
    return { accepted: z.zone === 'sure', id: z.zone === 'sure' ? z.id : null, score: z.score, marge: z.marge, zone: z.zone, propositions: z.propositions };
  }

  reset() {}
}

/**
 * Tirages distincts (code d'extension + rareté), dans l'ordre de l'index.
 *
 * Les codes sont ceux publiés — anglais. Leur mise dans la langue de
 * l'utilisateur, et le tri qui met sa région en tête, se font à l'affichage
 * (`fiche.js`, avec `region.js`) : la préférence peut changer après
 * l'identification, et la liste doit suivre sans réidentifier la carte.
 */
export function tiragesDistincts(printings) {
  const vus = new Set();
  const sortie = [];
  for (const tirage of printings ?? []) {
    const cle = `${tirage.setCode}|${tirage.rarity}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    sortie.push(tirage);
  }
  return sortie;
}

/**
 * Le résultat d'une identification par illustration, à la forme de
 * `scanCode` : ce que l'écran de résultat, le journal et l'inventaire
 * consomment déjà.
 *
 * Le code d'extension n'a pas été lu : `regionLue` est vide, et c'est la
 * préférence de l'utilisateur qui décidera de la langue des codes montrés.
 *
 * @param {object} index index de cartes (`buildSearchIndex`)
 * @param {number} id passcode de la carte reconnue
 * @param {{score: number, marge: number, sens: string|null, quad: Array|null}} lecture
 */
export function resultatDepuisArt(index, id, { score, marge, sens, quad }) {
  const position = index.byPasscode.get(id);
  if (position === undefined) return { status: 'no_match', reason: 'unknown_passcode', id };
  const entree = index.cards[position];
  const card = cardFromIndex(entree, entree.printings);
  const rarities = tiragesDistincts(entree.printings);
  return {
    status: rarities.length > 1 ? 'needs_user_selection' : 'resolved',
    source: 'local:art',
    method: 'art',
    read: null,
    code: null,
    matchedCode: null,
    regionLue: '',
    confidence: Math.round(score * 100),
    marge,
    sens,
    quad,
    regional: false,
    card,
    rarities,
    printings: entree.printings,
  };
}
