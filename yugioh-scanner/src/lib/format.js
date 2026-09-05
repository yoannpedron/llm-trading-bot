/**
 * Mise en forme des valeurs affichées.
 *
 * Un seul endroit pour les formateurs, parce que trois copies du même
 * `Intl.NumberFormat` vivaient dans trois composants : le jour où la devise ou
 * la précision change, on ne peut pas en oublier une. Les instances d'`Intl`
 * coûtent cher à construire ; les créer au module les partage entre tous les
 * rendus au lieu d'en fabriquer une par passe.
 *
 * Toutes les fonctions acceptent une valeur absente et rendent le tiret cadratin
 * plutôt que « NaN € » ou une case vide : dans un tableau de données, « pas de
 * valeur » doit se lire aussi clairement qu'une valeur.
 */

/** Ce qu'on affiche à la place d'une donnée absente. */
export const ABSENT = '—';

const EURO = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
});

/** Sans décimales : pour un total de classeur, le centime est du bruit. */
const EURO_ROND = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});

const ENTIER = new Intl.NumberFormat('fr-FR');

const DATE_COURTE = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
});

const DATE_LONGUE = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'long',
  timeStyle: 'short',
});

const nombreValide = (valeur) => typeof valeur === 'number' && Number.isFinite(valeur);

/** Montant en euros. `12,50 €`, ou `—` si la cote est inconnue. */
export const euros = (valeur) => (nombreValide(valeur) ? EURO.format(valeur) : ABSENT);

/**
 * Montant en euros sans centimes, pour les totaux.
 * Au-delà de quelques dizaines d'euros, le centime n'apporte rien et fait
 * osciller la largeur du chiffre à chaque rafraîchissement de cote.
 */
export const eurosRonds = (valeur) => (nombreValide(valeur) ? EURO_ROND.format(valeur) : ABSENT);

/** Nombre entier, avec l'espace des milliers français. */
export const entier = (valeur) => (nombreValide(valeur) ? ENTIER.format(valeur) : ABSENT);

/** `04/09/26` — pour une colonne de tableau, où la place est comptée. */
export const dateCourte = (horodatage) =>
  horodatage ? DATE_COURTE.format(new Date(horodatage)) : ABSENT;

/** `4 septembre 2026 à 16:42` — pour une infobulle ou une fiche. */
export const dateLongue = (horodatage) =>
  horodatage ? DATE_LONGUE.format(new Date(horodatage)) : ABSENT;

/**
 * Accord d'un nom au pluriel.
 * `pluriel(1, 'carte')` → « 1 carte » ; `pluriel(3, 'carte')` → « 3 cartes ».
 */
export const pluriel = (compte, singulier, plurielForme = `${singulier}s`) =>
  `${entier(compte)} ${compte > 1 ? plurielForme : singulier}`;
