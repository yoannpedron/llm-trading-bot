/**
 * Le mode SÉRIE : zéro geste par carte.
 *
 * Vider un classeur de trois cents cartes avec un écran de résultat par
 * carte, c'est trois appuis par carte. En série, la carte reconnue est
 * ajoutée au classeur aussitôt, avec le tirage le plus probable, et le viseur
 * passe à la suivante. Le code de tirage, lu sur la carte quand elle est assez
 * proche, précise l'entrée après coup ; sinon l'entrée porte « tirage à
 * préciser » et se règle dans l'inventaire.
 *
 * Ce module est pur : la préférence (localStorage), le tirage probable, et
 * la règle qui empêche d'ajouter dix fois la carte qui reste devant l'objectif.
 */

import { tiragesPourRegion } from './region.js';

export const CLE_SERIE = 'ygo.serie';

/**
 * Le même passcode, revu moins de huit secondes après son ajout et sans
 * qu'une autre carte soit passée entre-temps, est la même carte encore devant
 * l'objectif — pas un deuxième exemplaire. Au-delà, ou après une autre carte,
 * c'est un doublon voulu.
 */
export const DELAI_DOUBLON_MS = 8000;

/**
 * Le mode série est-il actif ? Activé par défaut (c'est le geste grand
 * public) ; `?serie=0` dans l'adresse le coupe pour une session (le banc de
 * bout en bout attend l'écran de résultat).
 */
export function lireSerie(stockage = globalThis.localStorage, recherche = globalThis.location?.search ?? '') {
  if (/[?&]serie=0(&|$)/.test(recherche)) return false;
  if (/[?&]serie=1(&|$)/.test(recherche)) return true;
  try {
    const brut = stockage?.getItem(CLE_SERIE);
    return brut === null || brut === undefined ? true : brut === '1';
  } catch {
    return true;
  }
}

export function ecrireSerie(actif, stockage = globalThis.localStorage) {
  try {
    stockage?.setItem(CLE_SERIE, actif ? '1' : '0');
  } catch {
    // Stockage indisponible (navigation privée) : la préférence ne survit pas, c'est tout.
  }
}

/**
 * Le tirage le plus probable pour une carte dont on n'a pas lu le code : le
 * premier dans la langue de la région choisie, sinon le premier publié.
 *
 * @returns {object|null} tirage avec `setCode` dans la région et `setCodePublie`
 */
export function tirageProbable(printings, region) {
  const tries = tiragesPourRegion(printings, region);
  return tries[0] ?? null;
}

/** Garde-fou contre l'ajout répété de la carte qui reste devant l'objectif. */
export class AntiDoublon {
  constructor({ delai = DELAI_DOUBLON_MS, now = () => Date.now() } = {}) {
    this.delai = delai;
    this.now = now;
    this.dernier = null;
    this.quand = 0;
  }

  /** Vrai si `id` vient d'être ajouté et n'a pas été suivi d'une autre carte. */
  dejaVu(id) {
    return this.dernier === id && this.now() - this.quand < this.delai;
  }

  /** À appeler après chaque ajout. */
  noter(id) {
    this.dernier = id;
    this.quand = this.now();
  }

  reset() {
    this.dernier = null;
    this.quand = 0;
  }
}
