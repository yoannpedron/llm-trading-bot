import test from 'node:test';
import assert from 'node:assert/strict';

import { makeEntry, retirerUn, upsertEntry, withTirage } from '../src/lib/collection.js';
import { AntiDoublon, PASSES_ABSENCE, ecrireSerie, lireSerie } from '../src/lib/serie.js';

const carte = { id: 46986414, name: 'Dark Magician', image: null, images: [] };
const tirages = [
  { setCode: 'LOB-EN005', rarity: 'Ultra Rare', setName: 'Legend of Blue Eyes' },
  { setCode: 'SDY-EN006', rarity: 'Common', setName: 'Starter Deck Yugi' },
  { setCode: 'LDK2-ENY10', rarity: 'Common', setName: 'Legendary Decks II' },
];

test('la préférence série est activée par défaut, mémorisée, et coupée par ?serie=0', () => {
  const memoire = new Map();
  const stockage = { getItem: (k) => (memoire.has(k) ? memoire.get(k) : null), setItem: (k, v) => memoire.set(k, v) };
  assert.equal(lireSerie(stockage, ''), true);
  ecrireSerie(false, stockage);
  assert.equal(lireSerie(stockage, ''), false);
  assert.equal(lireSerie(stockage, '?serie=1'), true);
  ecrireSerie(true, stockage);
  assert.equal(lireSerie(stockage, '?x=1&serie=0'), false);
  assert.equal(lireSerie(null, ''), true);
});

test('la même carte devant l’objectif n’est pas ré-ajoutée tant qu’elle n’a pas disparu', () => {
  const garde = new AntiDoublon();
  assert.equal(garde.dejaVu(1), false);
  garde.noter(1);
  for (let i = 0; i < 50; i += 1) garde.voir(1);
  assert.equal(garde.dejaVu(1), true, 'toujours là, même longtemps après');
  // Elle disparaît le temps de quelques passes : la revoir est un doublon voulu.
  for (let i = 0; i < PASSES_ABSENCE; i += 1) garde.voir(null);
  assert.equal(garde.dejaVu(1), false);
  // Une autre carte passe : la première peut revenir.
  garde.noter(1);
  garde.noter(2);
  assert.equal(garde.dejaVu(1), false);
  assert.equal(garde.dejaVu(2), true);
  // Une absence trop courte ne compte pas.
  garde.voir(null);
  garde.voir(2);
  assert.equal(garde.dejaVu(2), true);
});

test('une entrée ajoutée en série porte « tirage à préciser », qu’un ajout précis efface', () => {
  const serie = makeEntry(carte, tirages[0], { tirageAPreciser: true });
  assert.equal(serie.tirageAPreciser, true);
  assert.equal('tirageAPreciser' in makeEntry(carte, tirages[0]), false);
  let entrees = upsertEntry([], serie);
  entrees = upsertEntry(entrees, makeEntry(carte, tirages[0], { tirageAPreciser: true }));
  assert.equal(entrees[0].count, 2);
  assert.equal(entrees[0].tirageAPreciser, true);
  entrees = upsertEntry(entrees, makeEntry(carte, tirages[0]));
  assert.equal(entrees[0].count, 3);
  assert.equal('tirageAPreciser' in entrees[0], false);
});

test('withTirage remplace le tirage en gardant les exemplaires, et fusionne avec une ligne existante', () => {
  let entrees = upsertEntry([], makeEntry(carte, tirages[0], { tirageAPreciser: true, condition: 'PL' }));
  entrees = upsertEntry(entrees, makeEntry(carte, tirages[0], { tirageAPreciser: true }));
  const cle = entrees[0].key;
  entrees = withTirage(entrees, cle, tirages[2]);
  assert.equal(entrees.length, 1);
  assert.equal(entrees[0].setCode, 'LDK2-ENY10');
  assert.equal(entrees[0].count, 2);
  assert.equal(entrees[0].condition, 'PL');
  assert.equal('tirageAPreciser' in entrees[0], false);
  // Fusion avec une ligne qui existe déjà pour ce tirage.
  entrees = upsertEntry(entrees, makeEntry(carte, tirages[1]));
  const cleSdy = entrees.find((e) => e.setCode === 'SDY-EN006').key;
  entrees = withTirage(entrees, cleSdy, tirages[2]);
  assert.equal(entrees.length, 1);
  assert.equal(entrees[0].count, 3);
  assert.deepEqual(withTirage(entrees, 'inconnue', tirages[0]), entrees);
});

test('retirerUn décrémente puis supprime', () => {
  let entrees = upsertEntry([], makeEntry(carte, tirages[0]));
  entrees = upsertEntry(entrees, makeEntry(carte, tirages[0]));
  const cle = entrees[0].key;
  entrees = retirerUn(entrees, cle);
  assert.equal(entrees[0].count, 1);
  entrees = retirerUn(entrees, cle);
  assert.equal(entrees.length, 0);
  assert.deepEqual(retirerUn(entrees, cle), entrees);
});
