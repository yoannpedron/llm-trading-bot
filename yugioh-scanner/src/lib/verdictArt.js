/**
 * De l'identification par illustration à une décision, et à un résultat.
 *
 * Une passe rend une carte et un score. Quand accepter ? Mesuré sur le banc
 * (200 scènes, index complet) : les bonnes cartes ont un score médian de 0,93
 * et une marge médiane de 0,31 sur la deuxième ; les fausses en tête, 0,73 et
 * 0,03. Un score d'au moins 0,85 avec une marge d'au moins 0,05 accepte 78 %
 * des bonnes cartes sans en accepter aucune fausse. En dessous, on demande à
 * une deuxième image de confirmer la même carte — le bruit change, la carte
 * non. Sous 0,70, la passe ne compte pas.
 */

import { cardFromIndex } from './cardIndex.js';
import { ReadingVote } from './vote.js';

export const SCORE_SUR = 0.85;
export const MARGE_SURE = 0.05;
export const SCORE_MINIMAL = 0.7;

export class VoteArt {
  constructor(options = {}) {
    this.vote = new ReadingVote(options);
  }

  /**
   * @param {Array<{id: number, score: number}>} candidats triés par score
   * @returns {{accepted: boolean, id: number|null, score: number, marge: number, count: number}}
   */
  cast(candidats) {
    const premier = candidats?.[0];
    if (!premier || premier.score < SCORE_MINIMAL) return { accepted: false, id: null, score: premier?.score ?? 0, marge: 0, count: 0 };
    const marge = premier.score - (candidats[1]?.score ?? 0);
    const certain = premier.score >= SCORE_SUR && marge >= MARGE_SURE;
    const { accepted, count } = this.vote.cast(String(premier.id), { certain });
    return { accepted, id: premier.id, score: premier.score, marge, count };
  }

  reset() {
    this.vote.reset();
  }
}

/** Région d'un code d'extension (`LDK2-FR001` → `FR`), ou `''`. */
const region = (setCode) => /^[A-Z0-9]+-([A-Z]{2})\d/.exec(String(setCode ?? '').toUpperCase())?.[1] ?? '';

/**
 * Tirages distincts (code d'extension + rareté), les tirages FRANÇAIS
 * d'abord, puis l'ordre de l'index.
 *
 * Une carte reconnue par son illustration peut avoir soixante tirages. Ceux
 * que l'utilisateur tient en main sont presque toujours français : ils
 * passent en tête, le reste suit, rien n'est caché.
 */
export function tiragesDistincts(printings, regionPreferee = 'FR') {
  const vus = new Set();
  const sortie = [];
  for (const tirage of printings ?? []) {
    const cle = `${tirage.setCode}|${tirage.rarity}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    sortie.push(tirage);
  }
  const rang = (tirage) => (region(tirage.setCode) === regionPreferee ? 0 : 1);
  // Tri stable : à rang égal, l'ordre de l'index est conservé.
  return sortie.map((t, i) => [t, i]).sort((a, b) => rang(a[0]) - rang(b[0]) || a[1] - b[1]).map(([t]) => t);
}

/**
 * Le résultat d'une identification par illustration, à la forme de
 * `scanCode` : ce que l'écran de résultat, le journal et l'inventaire
 * consomment déjà.
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
