import test from 'node:test';
import assert from 'node:assert/strict';

import {
  csvEscape,
  csvFilename,
  entryKey,
  entryValue,
  loadCollection,
  makeEntry,
  removeEntry,
  toCsv,
  totalValue,
  upsertEntry,
  withCondition,
  withPrice,
} from '../src/lib/collection.js';

const card = {
  id: 89631139,
  name: 'Blue-Eyes White Dragon',
  type: 'Normal Monster',
  race: 'Dragon',
  attribute: 'LIGHT',
  atk: 3000,
  def: 2500,
  level: 8,
  image: 'https://example.test/89631139.jpg',
  images: [{ small: 'https://example.test/small.jpg' }],
};

const printing = {
  setCode: 'LOB-EN001',
  setName: 'Legend of Blue Eyes White Dragon',
  rarity: 'Ultra Rare',
  rarityCode: '(UR)',
};

test('une carte dans deux raretés fait deux lignes distinctes', () => {
  assert.notEqual(
    entryKey(1, 'LOB-EN041', 'Common'),
    entryKey(1, 'LOB-EN041', 'Short Print'),
  );
});

test('rescanner la même carte incrémente au lieu de dupliquer', () => {
  const first = makeEntry(card, printing, { at: 1000 });
  let entries = upsertEntry([], first);
  entries = upsertEntry(entries, makeEntry(card, printing, { at: 2000 }));

  assert.equal(entries.length, 1);
  assert.equal(entries[0].count, 2);
  // La date du premier scan est conservée.
  assert.equal(entries[0].scannedAt, 1000);
});

test('la carte rescannée remonte en tête', () => {
  const other = makeEntry({ ...card, id: 2, name: 'Pot of Greed' }, printing);
  let entries = upsertEntry([], makeEntry(card, printing));
  entries = upsertEntry(entries, other);
  entries = upsertEntry(entries, makeEntry(card, printing));

  assert.equal(entries[0].name, 'Blue-Eyes White Dragon');
  assert.equal(entries.length, 2);
});

test('la cote se pose sur la bonne ligne', () => {
  const entries = upsertEntry([], makeEntry(card, printing));
  const priced = withPrice(entries, entries[0].key, { source: 'cardmarket', prices: { trend: 4.5 } }, { at: 42 });

  assert.equal(priced[0].price.prices.trend, 4.5);
  assert.equal(priced[0].pricedAt, 42);
  assert.equal(totalValue(priced), 4.5);
});

test('le total suit l’état retenu, pas la cote neuve', () => {
  const entries = withPrice(
    upsertEntry([], makeEntry(card, printing)),
    entryKey(card.id, printing.setCode, printing.rarity),
    { source: 'ygoprodeck', prices: { trend: 10 } },
  );

  // Near Mint par défaut : la cote de référence s'applique telle quelle.
  assert.equal(totalValue(entries), 10);
  // Light Played : coefficient 0,55.
  assert.equal(totalValue(withCondition(entries, entries[0].key, 'LP')), 5.5);
});

test('supprime une ligne sans toucher aux autres', () => {
  let entries = upsertEntry([], makeEntry(card, printing));
  entries = upsertEntry(entries, makeEntry({ ...card, id: 2 }, printing));
  assert.equal(removeEntry(entries, entries[0].key).length, 1);
});

test('échappe ce qui casserait le CSV', () => {
  assert.equal(csvEscape('simple'), 'simple');
  assert.equal(csvEscape('Number 39; Utopia'), '"Number 39; Utopia"');
  assert.equal(csvEscape('Dit "bonjour"'), '"Dit ""bonjour"""');

  // Injection de formule : un tableur exécute toute cellule commençant par
  // « = », « + », « - » ou « @ ». On préfixe d'une apostrophe, que le tableur
  // consomme en marquant la cellule comme texte.
  assert.equal(csvEscape('=1+1'), `"'=1+1"`);
  assert.equal(csvEscape('@Ignister'), `"'@Ignister"`);
  assert.equal(csvEscape('+33 6 00 00 00 00'), `"'+33 6 00 00 00 00"`);
  // Un nombre négatif passe par le même chemin : lisible, plus exécutable.
  assert.equal(csvEscape(-5), `"'-5"`);
  // Rien d'anodin n'est touché.
  assert.equal(csvEscape('Blue-Eyes White Dragon'), 'Blue-Eyes White Dragon');
  assert.equal(csvEscape(12.5), '12.5');
  assert.equal(csvEscape('deux\nlignes'), '"deux\nlignes"');
  assert.equal(csvEscape(null), '');
});

test('exporte un CSV lisible par un tableur', () => {
  const entries = withPrice(
    upsertEntry([], makeEntry(card, printing, { at: 0 })),
    entryKey(card.id, printing.setCode, printing.rarity),
    { source: 'cardmarket', prices: { trend: 4.5, from: 3.2 }, productUrl: 'https://cm.test/p' },
    { at: 0 },
  );

  const csv = toCsv(entries);
  const [header, row] = csv.split('\r\n');
  const columns = header.split(';');

  assert.equal(columns[0], 'Nom');
  assert.match(row, /^Blue-Eyes White Dragon;LOB-EN001;/);
  assert.match(row, /;cardmarket;/);
  assert.match(row, /https:\/\/cm\.test\/p$/);

  // L'état et la nature de la cote voyagent avec la ligne.
  const cells = row.split(';');
  assert.equal(cells[columns.indexOf('État')], 'NM');
  assert.equal(cells[columns.indexOf('Cote estimée')], 'non');

  // Décimale à la française : le fichier emploie le point-virgule comme
  // séparateur de champ pour Excel francophone, configuration où la virgule
  // est le séparateur décimal. Un point donnerait une colonne de texte,
  // insommable et intriable.
  assert.equal(cells[columns.indexOf('Cote unitaire EUR')], '4,5');

  // La valeur de la ligne tient compte des exemplaires : c'est elle qui
  // s'additionne pour faire le total affiché.
  assert.equal(cells[columns.indexOf('Exemplaires')], '1');
  assert.equal(cells[columns.indexOf('Valeur ligne EUR')], '4,5');
  // Une seule ligne de données pour une seule entrée.
  assert.equal(csv.split('\r\n').length, 2);
});

test('le nom de fichier porte la date et reste valide', () => {
  const name = csvFilename(new Date('2026-09-04T10:20:30Z'));
  assert.equal(name, 'cartes-yugioh-2026-09-04-10-20-30.csv');
  assert.doesNotMatch(name, /[:/\\]/);
});

test('un rescan ajoute un exemplaire sans écraser ce que l’utilisateur a déclaré', () => {
  const cle = entryKey(card.id, printing.setCode, printing.rarity);
  let entrees = upsertEntry([], makeEntry(card, printing, { at: 1000 }));
  entrees = withCondition(entrees, cle, 'PL');
  entrees = withPrice(entrees, cle, { source: 'cardmarket', prices: { trend: 10 } }, { at: 1000 });

  // La même carte repasse : l'entrée neuve porte « NM » et aucun prix.
  entrees = upsertEntry(entrees, makeEntry(card, printing, { at: 2000 }));
  const [entree] = entrees;

  // L'état déclaré survit : sans cela, rescanner un classeur de cartes jouées
  // le remettait à neuf et gonflait le total en silence.
  assert.equal(entree.condition, 'PL');
  // La cote déjà relevée aussi, ce qui évite une requête inutile.
  assert.equal(entree.price.prices.trend, 10);
  // La date de première rencontre ne se réécrit pas.
  assert.equal(entree.scannedAt, 1000);
  // Et l'exemplaire supplémentaire est compté.
  assert.equal(entree.count, 2);
});

test('le total compte les exemplaires et l’état déclaré', () => {
  const cle = entryKey(card.id, printing.setCode, printing.rarity);
  let entrees = upsertEntry([], makeEntry(card, printing, { at: 0 }));
  entrees = withPrice(entrees, cle, { source: 'cardmarket', prices: { trend: 10 } }, { at: 0 });

  assert.equal(totalValue(entrees), 10);

  // Trois exemplaires valent trois fois.
  entrees = upsertEntry(entrees, makeEntry(card, printing, { at: 1 }));
  entrees = upsertEntry(entrees, makeEntry(card, printing, { at: 2 }));
  assert.equal(entrees[0].count, 3);
  assert.equal(totalValue(entrees), 30);

  // Et l'état déclaré décote l'ensemble : « Played » vaut 0,4 fois la référence.
  entrees = withCondition(entrees, cle, 'PL');
  assert.equal(totalValue(entrees), 12);
});

test('une donnée corrompue en stockage n’emporte pas l’application', () => {
  const valides = [
    { key: 'a', name: 'Carte A', count: 2, price: null },
    { key: 'b', name: 'Carte B' },
  ];
  const corrompues = [
    null,
    'texte',
    42,
    {},
    { key: 'c' },
    { name: 'sans clé' },
    { key: '', name: 'clé vide' },
  ];

  globalThis.localStorage = {
    getItem: () => JSON.stringify([...corrompues, ...valides]),
    setItem: () => {},
  };

  const relues = loadCollection();
  assert.deepEqual(
    relues.map((entree) => entree.key),
    ['a', 'b'],
  );
  // Les champs dont dépendent les calculs sont ramenés à un type sûr.
  assert.equal(relues[0].count, 2);
  assert.equal(relues[1].count, 1);
  assert.equal(relues[1].price, null);
  // Et le total se calcule sans lever.
  assert.equal(totalValue(relues), 0);

  // Un contenu qui n'est même pas un tableau rend un inventaire vide.
  globalThis.localStorage = { getItem: () => '{"pas":"un tableau"}', setItem: () => {} };
  assert.deepEqual(loadCollection(), []);

  globalThis.localStorage = { getItem: () => 'ceci n’est pas du JSON', setItem: () => {} };
  assert.deepEqual(loadCollection(), []);

  delete globalThis.localStorage;
});
