/**
 * État de conservation.
 *
 * Aucune API publique ne renvoie de prix par état : YGOPRODeck n'expose qu'une
 * moyenne, et la fiche Cardmarket affiche un seul « à partir de ». En revanche
 * cette fiche accepte un filtre `minCondition` — on obtient donc un *vrai* prix
 * filtré quand la fonction serveur atteint Cardmarket.
 *
 * Sinon, on applique le coefficient ci-dessous à la cote de référence. C'est
 * une estimation, jamais présentée comme un relevé : l'interface étiquette la
 * différence, et le CSV conserve la source.
 */

export const CONDITIONS = [
  { code: 'MT', id: 1, label: 'Mint', hint: 'neuve, jamais jouée', factor: 1.1 },
  { code: 'NM', id: 2, label: 'Near Mint', hint: 'défaut à peine visible', factor: 1 },
  { code: 'EX', id: 3, label: 'Excellent', hint: 'légères marques de bord', factor: 0.85 },
  { code: 'GD', id: 4, label: 'Good', hint: 'usure visible', factor: 0.7 },
  { code: 'LP', id: 5, label: 'Light Played', hint: 'rayures, bords blanchis', factor: 0.55 },
  { code: 'PL', id: 6, label: 'Played', hint: 'usure marquée', factor: 0.4 },
  { code: 'PO', id: 7, label: 'Poor', hint: 'pli, tache, déchirure', factor: 0.25 },
];

export const DEFAULT_CONDITION = 'NM';

export const conditionByCode = (code) =>
  CONDITIONS.find((entry) => entry.code === code) ?? null;

/** Identifiant attendu par le filtre `minCondition` de Cardmarket. */
export const conditionId = (code) => conditionByCode(code)?.id ?? null;

/**
 * Applique le coefficient d'état à une cote.
 *
 * @param {number|null} price cote de référence, en Near Mint
 * @param {string} code état visé
 * @returns {number|null}
 */
export function adjustForCondition(price, code) {
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  const condition = conditionByCode(code);
  if (!condition) return price;
  // Deux décimales : au-delà, on afficherait une précision qu'on n'a pas.
  return Math.round(price * condition.factor * 100) / 100;
}

/**
 * Cote à afficher pour un état donné.
 *
 * Quand Cardmarket a répondu *et* que le filtre d'état lui a été transmis, le
 * « à partir de » est déjà celui des exemplaires dans cet état : on le prend
 * tel quel. Sinon on estime.
 *
 * @returns {{value: number|null, estimated: boolean, basis: 'from'|'trend'|null}}
 */
export function conditionPrice(price, code) {
  if (!price) return { value: null, estimated: false, basis: null };

  if (price.conditionApplied && typeof price.prices?.from === 'number') {
    return { value: price.prices.from, estimated: false, basis: 'from' };
  }

  const reference = price.prices?.trend ?? price.prices?.from ?? null;
  if (reference === null) return { value: null, estimated: false, basis: null };

  // Sans état demandé, on n'invente pas de coefficient.
  if (!code || code === DEFAULT_CONDITION) {
    return { value: reference, estimated: false, basis: price.prices?.trend ? 'trend' : 'from' };
  }

  return {
    value: adjustForCondition(reference, code),
    estimated: true,
    basis: price.prices?.trend ? 'trend' : 'from',
  };
}

/** Lien Cardmarket filtré sur l'état, pour vérifier les offres réelles. */
export function cardmarketLink(price, code) {
  const base = price?.productUrl ?? price?.searchUrl ?? null;
  const id = conditionId(code);
  if (!base || !id) return base;
  return `${base}${base.includes('?') ? '&' : '?'}minCondition=${id}`;
}
