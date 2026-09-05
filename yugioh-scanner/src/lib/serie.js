/**
 * Le mode SÉRIE : zéro geste par carte.
 *
 * Vider un classeur de trois cents cartes avec un écran de résultat par
 * carte, c'est trois appuis par carte. En série, la carte reconnue est
 * ajoutée au classeur aussitôt, et le viseur
 * passe à la suivante. Le code de tirage, lu sur la carte quand elle est assez
 * proche, complète l'entrée après coup ; sinon l'entrée porte « tirage à
 * préciser » et se règle dans l'inventaire. Pas de tirage estimé : soit le
 * code est lu, soit l'utilisateur choisit.
 *
 * Ce module est pur : la préférence (localStorage) et la règle qui empêche
 * d'ajouter dix fois la carte qui reste devant l'objectif.
 */

export const CLE_SERIE = 'ygo.serie';

/**
 * Passes consécutives sans la carte au-delà desquelles on considère qu'elle a
 * quitté le champ : la revoir ensuite, c'est un deuxième exemplaire. Trois
 * passes, c'est moins d'une seconde — assez pour poser la carte suivante.
 */
export const PASSES_ABSENCE = 3;

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
 * Garde-fou contre l'ajout répété de la carte qui reste devant l'objectif.
 *
 * Une première version se fondait sur le temps (huit secondes) : une carte
 * laissée vingt secondes devant l'appareil entrait trois fois au classeur.
 * La règle est maintenant la PRÉSENCE : tant que la même carte est vue à
 * chaque passe, elle n'est pas ré-ajoutée ; il faut qu'elle disparaisse
 * (`PASSES_ABSENCE` passes sans elle) ou qu'une autre carte passe.
 */
export class AntiDoublon {
  constructor({ absence = PASSES_ABSENCE } = {}) {
    this.absence = absence;
    this.dernier = null;
    this.manques = 0;
  }

  /** À appeler à CHAQUE passe, avec la carte vue (ou null). */
  voir(id) {
    if (this.dernier === null) return;
    if (id === this.dernier) this.manques = 0;
    else {
      this.manques += 1;
      if (this.manques >= this.absence) this.dernier = null;
    }
  }

  /** Vrai si `id` est la carte ajoutée en dernier, toujours présente. */
  dejaVu(id) {
    return this.dernier === id;
  }

  /** À appeler après chaque ajout. */
  noter(id) {
    this.dernier = id;
    this.manques = 0;
  }

  reset() {
    this.dernier = null;
    this.manques = 0;
  }
}
