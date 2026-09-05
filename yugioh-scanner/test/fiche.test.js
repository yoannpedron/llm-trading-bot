import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSearchIndex, resolveSetCode } from '../src/lib/match.js';
import { codeRetenu, entreeDepuisScan, ficheDepuisScan } from '../src/lib/fiche.js';
import { resultatDepuisArt } from '../src/lib/verdictArt.js';

const index = buildSearchIndex({
  version: 1,
  sets: ['Legend of Blue Eyes', 'Legend of Blue Eyes (Europe)', 'OTS 13', 'Structure Deck'],
  rarities: ['Ultra Rare', 'Common'],
  cards: [
    [
      46986414,
      'Dark Magician',
      [[0, 'LOB-005', 0], [1, 'LOB-E003', 0], [2, 'OP13-EN006', 1], [2, 'OP13-PT006', 1], [3, 'SDY-EN006', 1]],
    ],
    [89631139, 'Blue-Eyes White Dragon', [[0, 'LOB-EN001', 0]]],
  ],
});

const art = () => resultatDepuisArt(index, 46986414, { score: 0.9, marge: 0.2, sens: 'droite', quad: null });

/* --- Identification par l'illustration ------------------------------------ */

test('reconnue par l’illustration : les tirages sont dans la langue préférée, région en tête', () => {
  const fiche = ficheDepuisScan(art(), null, 'FR');
  assert.equal(fiche.code, null, 'aucun code lu');
  assert.equal(fiche.region, 'FR');
  assert.equal(fiche.regionale, false);
  assert.deepEqual(
    fiche.raretes.map((t) => t.setCode),
    ['LOB-F003', 'OP13-FR006', 'SDY-FR006', 'LOB-005'],
    'EN et PT se confondent une fois en français, le code américain reste en queue',
  );
  assert.deepEqual(
    fiche.raretes.map((t) => t.setCodePublie),
    ['LOB-E003', 'OP13-EN006', 'SDY-EN006', 'LOB-005'],
  );

  const allemande = ficheDepuisScan(art(), null, 'DE');
  assert.deepEqual(
    allemande.raretes.map((t) => t.setCode),
    ['LOB-G003', 'OP13-DE006', 'SDY-DE006', 'LOB-005'],
  );
  // Sans préférence valable, le français.
  assert.equal(ficheDepuisScan(art(), null, 'DK').raretes[0].setCode, 'LOB-F003');
  assert.equal(ficheDepuisScan(art(), null).raretes[0].setCode, 'LOB-F003');
});

test('le code retenu et l’entrée d’inventaire suivent la langue, même si le tirage a été choisi dans une autre', () => {
  const scan = art();
  const francaise = ficheDepuisScan(scan, null, 'FR');
  const choisi = francaise.raretes[1]; // OP13-FR006
  assert.equal(codeRetenu(francaise, choisi), 'OP13-FR006');
  assert.equal(codeRetenu(francaise, null), null);

  // La préférence passe à l'italien après le choix : le code enregistré est
  // italien, reconstruit depuis le code publié.
  const entree = entreeDepuisScan(scan, null, choisi, 'IT');
  assert.equal(entree.tirage.setCode, 'OP13-IT006');
  assert.equal(entree.tirage.setName, 'OTS 13');
  assert.equal(entree.tirage.rarity, 'Common');
  assert.equal(entree.carte.id, 46986414);

  // Un tirage brut de l'index (rareté unique retenue d'office) se convertit aussi.
  assert.equal(entreeDepuisScan(scan, null, { setCode: 'SDY-EN006', rarity: 'Common' }, 'SP').tirage.setCode, 'SDY-SP006');
  // Et un code sans région reste ce qu'il est.
  assert.equal(entreeDepuisScan(scan, null, { setCode: 'LOB-005', rarity: 'Ultra Rare' }, 'FR').tirage.setCode, 'LOB-005');
  assert.equal(entreeDepuisScan(scan, null, null, 'FR'), null);
});

/* --- Code saisi ------------------------------------------------------------ */

test('un code tapé avec sa région garde cette région, quelle que soit la préférence', () => {
  const anglais = ficheDepuisScan(resolveSetCode(index, 'LOB-EN001'), null, 'FR');
  assert.equal(anglais.code, 'LOB-EN001');
  assert.equal(anglais.region, 'EN');
  assert.equal(anglais.regionale, false);
  assert.equal(codeRetenu(anglais, anglais.raretes[0]), 'LOB-EN001');

  const francais = ficheDepuisScan(resolveSetCode(index, 'LOB-FR001'), null, 'DE');
  assert.equal(francais.code, 'LOB-FR001');
  assert.equal(francais.codePublie, 'LOB-EN001');
  assert.equal(francais.regionale, true);
  assert.equal(entreeDepuisScan(resolveSetCode(index, 'LOB-FR001'), null, francais.raretes[0], 'DE').tirage.setCode, 'LOB-FR001');
});

test('un code tapé sans région est montré et enregistré dans la langue préférée', () => {
  const scan = resolveSetCode(index, 'LOB-001');
  assert.equal(scan.regionLue, '');
  const fiche = ficheDepuisScan(scan, null, 'DE');
  assert.equal(fiche.code, 'LOB-DE001');
  assert.equal(fiche.codePublie, 'LOB-EN001');
  assert.equal(fiche.regionale, true, 'le code montré n’est pas celui publié');
  assert.equal(entreeDepuisScan(scan, null, fiche.raretes[0], 'DE').tirage.setCode, 'LOB-DE001');
  // La préférence anglaise ne change rien au code publié.
  const anglaise = ficheDepuisScan(scan, null, 'EN');
  assert.equal(anglaise.code, 'LOB-EN001');
  assert.equal(anglaise.regionale, false);
});
