import test from 'node:test';
import assert from 'node:assert/strict';

import { makeEntry, retirerUn, upsertEntry, withTirage } from '../src/lib/collection.js';
import { AntiDoublon, DELAI_DOUBLON_MS, ecrireSerie, lireSerie, tirageProbable } from '../src/lib/serie.js';

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

test('le tirage probable est le premier dans la langue choisie, code converti', () => {
  const t = tirageProbable(tirages, 'FR');
  assert.equal(t.setCode, 'LOB-FR005');
  assert.equal(t.setCodePublie, 'LOB-EN005');
  assert.equal(tirageProbable([], 'FR'), null);
});

test('la même carte devant l’objectif n’est pas ajoutée deux fois en huit secondes', () => {
  let temps = 0;
  const garde = new AntiDoublon({ now: () => temps });
  assert.equal(garde.dejaVu(1), false);
  garde.noter(1);
  temps += 1000;
  assert.equal(garde.dejaVu(1), true, 'même carte, une seconde après');
  garde.noter(2);
  assert.equal(garde.dejaVu(1), false, 'une autre carte est passée');
  garde.noter(1);
  temps += DELAI_DOUBLON_MS;
  assert.equal(garde.dejaVu(1), false, 'le délai est écoulé : doublon voulu');
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
