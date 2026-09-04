/**
 * Journal des lectures.
 *
 * L'inventaire répond à « qu'est-ce que je possède » : il dédoublonne, compte
 * les exemplaires, et ne retient que ce qui a été enregistré. Il ne répond pas
 * à « qu'est-ce que j'ai passé sous le viseur, et qu'est-ce que ça a donné ».
 *
 * Ce journal-là est chronologique et ne dédoublonne rien. Il sert à trois
 * choses concrètes :
 *
 *  - **retrouver une carte** qu'on a identifiée puis écartée par erreur ;
 *  - **reprendre un dépouillement** interrompu, en voyant où l'on s'est arrêté ;
 *  - **comprendre les échecs** : une recherche manuelle infructueuse y figure
 *    avec ce qui avait été tapé, ce qui est la seule trace exploitable quand on
 *    se demande pourquoi une carte ne passe pas.
 *
 * Il vit dans le navigateur, comme l'inventaire, et il est borné : au-delà de
 * `LIMITE` entrées, les plus anciennes disparaissent. Un journal qui grossit
 * sans fin finit par saturer le stockage et emporte l'inventaire avec lui.
 */

export const STORAGE_KEY = 'ygo-scanner:journal:v1';

/** Nombre d'entrées conservées. Au-delà, les plus anciennes tombent. */
export const LIMITE = 300;

/**
 * Une entrée est-elle exploitable ?
 * Même prudence que pour l'inventaire : le stockage local est modifiable, et
 * une entrée malformée ne doit pas emporter l'écran.
 */
function valide(entree) {
  return (
    typeof entree === 'object' &&
    entree !== null &&
    typeof entree.at === 'number' &&
    Number.isFinite(entree.at) &&
    typeof entree.statut === 'string'
  );
}

/**
 * Consigne une identification réussie.
 *
 * @param {object} fiche résultat de `ficheDepuisScan`
 * @param {{at?: number}} options
 */
export function entreeIdentifiee(fiche, { at = Date.now() } = {}) {
  return {
    at,
    statut: 'identifiee',
    code: fiche.code ?? null,
    cardId: fiche.identifiant ?? null,
    nom: fiche.nom ?? null,
    methode: fiche.methode ?? null,
    lecture: fiche.lectureBrute ?? null,
    manuelle: Boolean(fiche.saisieManuelle),
    enregistree: false,
  };
}

/**
 * Consigne une recherche manuelle qui n'a rien donné.
 * On ne consigne PAS les échecs de la caméra : elle en produit plusieurs par
 * seconde, et le journal ne serait plus lisible. Une saisie manuelle, elle,
 * est un geste délibéré dont l'échec mérite une trace.
 */
export function entreeRefusee(saisie, statut, { at = Date.now() } = {}) {
  return {
    at,
    statut: statut === 'no_code' ? 'illisible' : 'introuvable',
    code: null,
    cardId: null,
    nom: null,
    methode: null,
    lecture: String(saisie ?? ''),
    manuelle: true,
    enregistree: false,
  };
}

/** Ajoute une entrée en tête, et borne la longueur. */
export function ajouter(entrees, entree) {
  return [entree, ...entrees].slice(0, LIMITE);
}

/**
 * Marque comme enregistrée la dernière identification d'une carte.
 * On ne touche qu'à la plus récente : la même carte peut avoir été rencontrée
 * plusieurs fois, et seule celle qu'on vient de valider change d'état.
 */
export function marquerEnregistree(entrees, cardId) {
  let fait = false;
  return entrees.map((entree) => {
    if (fait || entree.cardId !== cardId || entree.enregistree) return entree;
    fait = true;
    return { ...entree, enregistree: true };
  });
}

export function charger() {
  try {
    const brut = globalThis.localStorage?.getItem(STORAGE_KEY);
    const lu = brut ? JSON.parse(brut) : [];
    return Array.isArray(lu) ? lu.filter(valide).slice(0, LIMITE) : [];
  } catch {
    return [];
  }
}

export function enregistrer(entrees) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(entrees));
    return true;
  } catch {
    return false;
  }
}

/** Compte par statut, pour l'en-tête de l'écran. */
export function bilan(entrees) {
  return entrees.reduce(
    (compte, entree) => {
      compte.total += 1;
      if (entree.statut === 'identifiee') compte.identifiees += 1;
      else compte.refusees += 1;
      if (entree.enregistree) compte.enregistrees += 1;
      return compte;
    },
    { total: 0, identifiees: 0, refusees: 0, enregistrees: 0 },
  );
}
