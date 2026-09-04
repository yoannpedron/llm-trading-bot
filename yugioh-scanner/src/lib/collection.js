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
  if (!existing) return [entry, ...entries.filter((item) => item.key !== entry.key)];

  // Ce que la nouvelle lecture apporte, et ce que l'ancienne ligne garde.
  //
  // L'étalement `{ ...existing, ...entry }` écrasait tout, y compris trois
  // champs que l'utilisateur avait renseignés ou que le temps avait remplis :
  //
  //  - `condition` — l'entrée neuve porte toujours « NM » par défaut, donc
  //    rescanner une carte déclarée « Played » la remettait à neuf et gonflait
  //    le total de tout l'inventaire, en silence ;
  //  - `price` et `pricedAt` — une cote fraîchement relevée était remplacée par
  //    `null`, ce qui relançait une requête inutile ;
  //  - `count` — préservé, mais incrémenté même quand rien ne le justifiait.
  //
  // On énumère donc explicitement. Un champ ajouté plus tard sera repris de
  // l'entrée neuve, ce qui est le bon défaut pour une donnée de catalogue.
  const merged = {
    ...existing,
    ...entry,
    // Ce que l'utilisateur a décidé prime sur ce que la lecture suppose.
    condition: existing.condition ?? entry.condition,
    // La date de première rencontre ne se réécrit pas.
    scannedAt: existing.scannedAt,
    // Un exemplaire de plus dans le classeur.
    count: (existing.count ?? 1) + 1,
    // La cote connue survit à un rescan.
    price: entry.price ?? existing.price,
    pricedAt: entry.price ? entry.pricedAt : existing.pricedAt,
  };

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

/**
 * Une entrée est-elle exploitable ?
 *
 * Le stockage local est modifiable par l'utilisateur, partagé avec d'autres
 * versions de l'application, et sujet aux écritures interrompues. On ne
 * vérifiait que le fait d'avoir un tableau : un seul élément `null` suffisait
 * à faire remonter une `TypeError` depuis `conditionPrice` jusqu'au rendu
 * racine, et comme rien ne rattrape les erreurs de rendu, l'application
 * affichait une page blanche — définitivement, puisque la donnée fautive est
 * relue à chaque ouverture. L'utilisateur n'a alors aucun moyen de s'en sortir.
 *
 * On exige donc le minimum sans lequel une ligne ne peut rien afficher : un
 * objet, une clé, un nom. Le reste est facultatif et retombe sur des valeurs
 * sûres au moment de l'affichage.
 */
function entreeValide(valeur) {
  return (
    typeof valeur === 'object' &&
    valeur !== null &&
    typeof valeur.key === 'string' &&
    valeur.key.length > 0 &&
    typeof valeur.name === 'string'
  );
}

/**
 * Relit l'inventaire, en écartant ce qui n'est pas exploitable.
 *
 * @returns {Array} les entrées valides ; jamais d'exception
 */
export function loadCollection() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(entreeValide).map((entree) => ({
      // Les champs dont dépendent les calculs sont ramenés à un type sûr :
      // un prix arrivé sous forme de chaîne s'affichait mais était exclu du
      // total, ce qui donnait un écran où la somme des lignes ne fait pas le
      // total affiché.
      ...entree,
      count: Number.isFinite(entree.count) && entree.count > 0 ? Math.floor(entree.count) : 1,
      price: typeof entree.price === 'object' ? entree.price : null,
    }));
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
  ['Cote unitaire EUR', (entry) => decimal(conditionPrice(entry.price, entry.condition).value)],
  ['Exemplaires', (entry) => entry.count ?? 1],
  ['Valeur ligne EUR', (entry) => decimal(entryValue(entry))],
  ['Cote estimée', (entry) => (conditionPrice(entry.price, entry.condition).estimated ? 'oui' : 'non')],
  ['Cote de référence EUR', (entry) => decimal(entry.price?.prices?.trend ?? entry.price?.prices?.from)],
  ['Source', (entry) => entry.price?.source ?? ''],
  ['À partir de EUR', (entry) => decimal(entry.price?.prices?.from)],
  ['Moyenne 30j EUR', (entry) => decimal(entry.price?.prices?.avg30)],
  ['Moyenne 7j EUR', (entry) => decimal(entry.price?.prices?.avg7)],
  ['Exemplaires en vente', (entry) => entry.price?.prices?.available ?? ''],
  ['Type', (entry) => entry.type],
  ['Catégorie', (entry) => entry.race],
  ['Attribut', (entry) => entry.attribute],
  ['ATK', (entry) => entry.atk ?? ''],
  ['DEF', (entry) => entry.def ?? ''],
  ['Niveau', (entry) => entry.level ?? ''],

  ['Scannée le', (entry) => toIso(entry.scannedAt)],
  ['Cote relevée le', (entry) => toIso(entry.pricedAt)],
  ['ID YGOPRODeck', (entry) => entry.cardId],
  ['Lien Cardmarket', (entry) => entry.price?.productUrl ?? entry.price?.searchUrl ?? ''],
];

const toIso = (value) => (value ? new Date(value).toISOString() : '');

/**
 * Décimale à la française.
 *
 * Le fichier emploie le point-virgule comme séparateur de champ, précisément
 * parce qu'Excel francophone attend cela — configuration dans laquelle le
 * séparateur DÉCIMAL est la virgule. Sortir « 12.50 » dans un tel fichier
 * donne une colonne de texte : ni somme, ni tri, ni graphique. La conversion
 * est faite ici, une fois, pour toutes les colonnes monétaires.
 */
const decimal = (valeur) =>
  typeof valeur === 'number' && Number.isFinite(valeur) ? String(valeur).replace('.', ',') : '';

/**
 * Caractères par lesquels un tableur reconnaît une formule.
 *
 * Excel, LibreOffice et Google Sheets évaluent toute cellule commençant par
 * l'un d'eux. Une valeur comme `=HYPERLINK(...)` ou `@SUM(A1)` devient donc du
 * code exécuté à l'ouverture du fichier — l'injection de formule CSV. La donnée
 * vient d'une API tierce et d'une saisie utilisateur : on ne peut pas se fier à
 * son innocuité, même si aucun nom de carte ne commence aujourd'hui par ces
 * caractères (vérifié sur les 14 523 noms de l'index, en anglais et en
 * français). Le jeu contient l'archétype « @Ignister » ; il ne manque qu'une
 * traduction ou un renommage pour que le cas se présente.
 */
const FORMULE = /^[=+\-@\t\r]/;

/**
 * Échappement CSV.
 *
 * Deux règles distinctes, souvent confondues :
 *
 *  1. **RFC 4180** — un nom de carte contient volontiers un point-virgule ou un
 *     guillemet (« Number 39: Utopia », « Harpie's »). On entoure de guillemets
 *     et on double ceux qui sont dans la valeur.
 *  2. **Neutralisation des formules** — on préfixe d'une apostrophe simple, que
 *     les tableurs consomment en marquant la cellule comme texte. La valeur
 *     reste lisible ; elle cesse d'être exécutable.
 *
 * L'apostrophe impose le guillemetage : sans lui, certains tableurs
 * l'afficheraient telle quelle.
 */
export function csvEscape(value, separator = ';') {
  const text = value === null || value === undefined ? '' : String(value);
  const neutralise = FORMULE.test(text) ? `'${text}` : text;
  const needsQuotes =
    neutralise !== text ||
    neutralise.includes(separator) ||
    neutralise.includes('"') ||
    /[\r\n]/.test(neutralise);
  return needsQuotes ? `"${neutralise.replace(/"/g, '""')}"` : neutralise;
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
/**
 * Déclenche le téléchargement de ce qui est passé.
 *
 * L'appelant décide du périmètre : l'inventaire entier, ou le sous-ensemble
 * affiché. Le bouton d'export voisine avec un champ de filtre et un « total
 * filtré » — exporter autre chose que ce que l'utilisateur a sous les yeux
 * serait un piège.
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
  // Révoquer dans le même tour de boucle coupe l'herbe sous le pied des
  // navigateurs qui n'engagent le transfert qu'à la tâche suivante : le
  // fichier arrivait vide ou pas du tout. On laisse passer un tour.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Somme des cotes connues, pour l'en-tête de l'historique.
 * On additionne la valeur *à l'état retenu*, pas la cote de référence : sinon
 * un classeur de cartes jouées afficherait un total de cartes neuves.
 */
/**
 * Valeur d'une ligne : la cote à l'état déclaré, multipliée par le nombre
 * d'exemplaires.
 *
 * `count` compte les exemplaires, pas les scans. C'est le sens que lui donne
 * l'usage — on repasse la même carte parce qu'on en a plusieurs dans le
 * classeur — et c'est celui qu'attend quelqu'un qui lit un total. La colonne
 * de l'inventaire est intitulée « Ex. » en conséquence, et le CSV aussi.
 */
export function entryValue(entry) {
  const { value } = conditionPrice(entry.price, entry.condition);
  if (!Number.isFinite(value)) return null;
  return value * (Number.isFinite(entry.count) && entry.count > 0 ? entry.count : 1);
}

/**
 * Somme des cotes connues.
 *
 * Elle additionne la valeur **à l'état retenu et pour tous les exemplaires** :
 * sinon un classeur de cartes jouées afficherait un total de cartes neuves, et
 * trois exemplaires d'une même carte n'en vaudraient qu'un.
 */
export function totalValue(entries) {
  return entries.reduce((total, entry) => total + (entryValue(entry) ?? 0), 0);
}
