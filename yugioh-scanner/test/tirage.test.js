import test from 'node:test';
import assert from 'node:assert/strict';

import { AVANCE_MINIMALE, SIMILARITE_MINIMALE, apparierTirage, assezGrande, nettoyerLecture, tiragesDuCode } from '../src/lib/tirage.js';

const tirages = [
  { setCode: 'LOB-EN005', rarity: 'Ultra Rare', setName: 'Legend of Blue Eyes' },
  { setCode: 'LOB-EN005', rarity: 'Ultra Rare', setName: 'Legend of Blue Eyes' },
  { setCode: 'SDY-EN006', rarity: 'Common', setName: 'Starter Deck Yugi' },
  { setCode: 'LDK2-ENY10', rarity: 'Common', setName: 'Legendary Decks II' },
  { setCode: 'MVP1-ENG54', rarity: 'Gold Rare', setName: 'Movie Pack' },
];

test('une lecture propre désigne son tirage, région comprise ou non', () => {
  assert.equal(apparierTirage('LDK2-FRY10', tirages).tirage.setCode, 'LDK2-ENY10');
  assert.equal(apparierTirage('SDY-EN006', tirages).tirage.setCode, 'SDY-EN006');
  assert.equal(apparierTirage(' lob-en005 ', tirages).tirage.setCode, 'LOB-EN005');
});

test('une lecture abîmée est rapprochée du code le plus proche, si l’avance est nette', () => {
  const r = apparierTirage('LDK2-FRYI0', tirages); // 1 lu I
  assert.equal(r.tirage?.setCode, 'LDK2-ENY10');
  assert.ok(r.similarite >= SIMILARITE_MINIMALE);
  assert.ok(r.avance >= AVANCE_MINIMALE);
});

test('sans ressemblance suffisante, aucun tirage n’est retenu', () => {
  const r = apparierTirage('ZZZZ-999', tirages);
  assert.equal(r.tirage, null);
  assert.ok(r.candidats.length > 0);
  assert.equal(apparierTirage('', tirages).tirage, null);
  assert.equal(apparierTirage('LOB-EN005', []).tirage, null);
});

test('deux codes à égalité ne tranchent pas', () => {
  const jumeaux = [{ setCode: 'ABC-EN001' }, { setCode: 'ABD-EN001' }];
  // La lecture est à mi-chemin : même similarité pour les deux.
  const r = apparierTirage('AB-EN001', jumeaux);
  assert.equal(r.tirage, null);
  assert.ok(r.avance < AVANCE_MINIMALE);
});

test('la carte doit être assez grande dans l’image', () => {
  const coins = (h) => [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: h }, { x: 0, y: h }];
  assert.equal(assezGrande(coins(1200), 1920), true);
  assert.equal(assezGrande(coins(800), 1920), false);
  assert.equal(assezGrande(null, 1920), false);
});

test('nettoyerLecture et tiragesDuCode', () => {
  assert.equal(nettoyerLecture(' ldk2–fr 001 '), 'LDK2-FR001');
  const memes = tiragesDuCode(tirages, tirages[0]);
  assert.equal(memes.length, 2);
  assert.ok(memes.every((t) => t.setCode === 'LOB-EN005'));
  assert.deepEqual(tiragesDuCode(tirages, null), tirages);
});
