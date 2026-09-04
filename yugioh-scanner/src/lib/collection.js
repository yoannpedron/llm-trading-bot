/**
 * Historique des cartes scannées.
 *
 * Tout est conservé dans le navigateur : aucune image ni aucun scan ne part sur
 * un serveur. Le stockage peut être indisponible (navigation privée, quota
 * plein), auquel cas l'application continue de fonctionner en mémoire — d'où
 * les `try` autour de chaque accès.
 *
 * Ce module reste pur : pas de React, pas de DOM au-delà de `localStorage`, ce
 * qui permet de tester la fusion des entrées et l'export CSV sous Node.
 */

import { DEFAULT_CONDITION, conditionPrice } from './condition.js';

export const STORAGE_KEY = 'ygo-scanner:collection:v1';

/** Identité d'une ligne : une même carte dans deux raretés fait deux lignes. */
export const entryKey = (cardId, setCode, rarity) =>
  `${cardId}|${setCode ?? ''}|${rarity ?? ''}`;

/**
 * Construit une entrée à partir d'une carte identifiée et du tirage retenu.
 */
export function makeEntry(card, printing, { at = Date.now(), condition = DEFAULT_CONDITION } = {}) {
  return {
    key: entryKey(card.id, printing?.setCode, printing?.rarity),
    cardId: card.id,
    name: card.name,
    type: card.type ?? '',
    race: card.race ?? '',
    attribute: card.attribute ?? '',
    atk: card.atk ?? null,
    def: card.def ?? null,
    level: card.level ?? null,
    setCode: printing?.setCode ?? '',
    setName: printing?.setName ?? '',
    rarity: printing?.rarity ?? '',
    rarityCode: printing?.rarityCode ?? '',
    image: card.image ?? null,
    imageSmall: card.images?.[0]?.small ?? null,
    condition,
    scannedAt: at,
    seenAt: at,
    count: 1,
    price: null,
  };
}

/**
 * Insère ou met à jour une entrée, la plus récente en tête.
 *
 * Rescanner la même carte n'ajoute pas de doublon : on incrémente le compteur
 * et on remonte la ligne, ce qui correspond à ce qu'on attend en dépouillant un
 * classeur où les mêmes cartes repassent.
 */
export function upsertEntry(entries, entry) {
  const existing = entries.find((item) => item.key === entry.key);
  const merged = existing
    ? { ...existing, ...entry, scannedAt: existing.scannedAt, count: existing.count + 1, price: entry.price ?? existing.price }
    : entry;

  return [merged, ...entries.filter((item) => item.key !== entry.key)];
}

/** Change l'état retenu pour une entrée. */
export function withCondition(entries, key, condition) {
  return entries.map((entry) => (entry.key === key ? { ...entry, condition } : entry));
}

/** Remplace la cote d'une entrée sans toucher au reste. */
export function withPrice(entries, key, price, { at = Date.now() } = {}) {
  return entries.map((entry) =>
    entry.key === key ? { ...entry, price, pricedAt: price ? at : entry.pricedAt } : entry,
  );
}

export const removeEntry = (entries, key) => entries.filter((entry) => entry.key !== key);

/* ------------------------------------------------------------------ */
/* Persistance                                                          */
/* ------------------------------------------------------------------ */

export function loadCollection() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCollection(entries) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    // Quota dépassé ou stockage refusé : l'historique reste vivant en mémoire.
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Export CSV                                                           */
/* ------------------------------------------------------------------ */

const COLUMNS = [
  ['Nom', (entry) => entry.name],
  ['Code', (entry) => entry.setCode],
  ['Série', (entry) => entry.setName],
  ['Rareté', (entry) => entry.rarity],
  ['État', (entry) => entry.condition ?? ''],
  ['Cote EUR', (entry) => conditionPrice(entry.price, entry.condition).value ?? ''],
  ['Cote estimée', (entry) => (conditionPrice(entry.price, entry.condition).estimated ? 'oui' : 'non')],
  ['Cote de référence EUR', (entry) => entry.price?.prices?.trend ?? entry.price?.prices?.from ?? ''],
  ['Source', (entry) => entry.price?.source ?? ''],
  ['À partir de EUR', (entry) => entry.price?.prices?.from ?? ''],
  ['Moyenne 30j EUR', (entry) => entry.price?.prices?.avg30 ?? ''],
  ['Moyenne 7j EUR', (entry) => entry.price?.prices?.avg7 ?? ''],
  ['Exemplaires en vente', (entry) => entry.price?.prices?.available ?? ''],
  ['Type', (entry) => entry.type],
  ['Catégorie', (entry) => entry.race],
  ['Attribut', (entry) => entry.attribute],
  ['ATK', (entry) => entry.atk ?? ''],
  ['DEF', (entry) => entry.def ?? ''],
  ['Niveau', (entry) => entry.level ?? ''],
  ['Scans', (entry) => entry.count ?? 1],
  ['Scannée le', (entry) => toIso(entry.scannedAt)],
  ['Cote relevée le', (entry) => toIso(entry.pricedAt)],
  ['ID YGOPRODeck', (entry) => entry.cardId],
  ['Lien Cardmarket', (entry) => entry.price?.productUrl ?? entry.price?.searchUrl ?? ''],
];

const toIso = (value) => (value ? new Date(value).toISOString() : '');

/**
 * Échappement CSV.
 *
 * Un nom de carte contient volontiers une virgule, un point-virgule ou un
 * guillemet (« Number 39: Utopia », « Harpie's »). La règle RFC 4180 s'applique :
 * on entoure de guillemets et on double ceux qui sont dans la valeur.
 */
export function csvEscape(value, separator = ';') {
  const text = value === null || value === undefined ? '' : String(value);
  const needsQuotes =
    text.includes(separator) || text.includes('"') || /[\r\n]/.test(text);
  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Sérialise l'historique complet.
 *
 * Séparateur point-virgule et fins de ligne CRLF : c'est ce qu'attend Excel
 * dans une configuration francophone, où la virgule est le séparateur décimal.
 */
export function toCsv(entries, { separator = ';' } = {}) {
  const header = COLUMNS.map(([label]) => csvEscape(label, separator)).join(separator);
  const rows = entries.map((entry) =>
    COLUMNS.map(([, read]) => csvEscape(read(entry), separator)).join(separator),
  );
  return [header, ...rows].join('\r\n');
}

/** Nom de fichier daté, pour ne pas écraser un export précédent. */
export function csvFilename(now = new Date()) {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `cartes-yugioh-${stamp}.csv`;
}

/**
 * Déclenche le téléchargement.
 * Le BOM UTF-8 en tête est ce qui évite les accents cassés à l'ouverture dans
 * Excel sous Windows.
 */
export function downloadCsv(entries) {
  const blob = new Blob([`﻿${toCsv(entries)}`], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = csvFilename();
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Somme des cotes connues, pour l'en-tête de l'historique.
 * On additionne la valeur *à l'état retenu*, pas la cote de référence : sinon
 * un classeur de cartes jouées afficherait un total de cartes neuves.
 */
export function totalValue(entries) {
  return entries.reduce((total, entry) => {
    const { value } = conditionPrice(entry.price, entry.condition);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}
