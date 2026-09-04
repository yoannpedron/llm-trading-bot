import test from 'node:test';
import assert from 'node:assert/strict';

import {
  csvEscape,
  csvFilename,
  entryKey,
  makeEntry,
  removeEntry,
  toCsv,
  totalValue,
  upsertEntry,
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

test('supprime une ligne sans toucher aux autres', () => {
  let entries = upsertEntry([], makeEntry(card, printing));
  entries = upsertEntry(entries, makeEntry({ ...card, id: 2 }, printing));
  assert.equal(removeEntry(entries, entries[0].key).length, 1);
});

test('échappe ce qui casserait le CSV', () => {
  assert.equal(csvEscape('simple'), 'simple');
  assert.equal(csvEscape('Number 39; Utopia'), '"Number 39; Utopia"');
  assert.equal(csvEscape('Dit "bonjour"'), '"Dit ""bonjour"""');
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

  assert.equal(header.split(';')[0], 'Nom');
  assert.match(row, /^Blue-Eyes White Dragon;LOB-EN001;/);
  assert.match(row, /;cardmarket;/);
  assert.match(row, /;4\.5;/);
  assert.match(row, /https:\/\/cm\.test\/p$/);
  // Une seule ligne de données pour une seule entrée.
  assert.equal(csv.split('\r\n').length, 2);
});

test('le nom de fichier porte la date et reste valide', () => {
  const name = csvFilename(new Date('2026-09-04T10:20:30Z'));
  assert.equal(name, 'cartes-yugioh-2026-09-04-10-20-30.csv');
  assert.doesNotMatch(name, /[:/\\]/);
});
