import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSetCode,
  extractSetCodes,
  extractTitle,
  normalizeOcrText,
  setCodeMatchKey,
  titleSimilarity,
} from '../src/lib/parse.js';

test('normalise le bruit typographique autour du code', () => {
  assert.equal(normalizeOcrText('  ¥ lob — en001 ~ '), 'LOB-EN001');
});

test('lit les formats de code courants', () => {
  const cases = [
    ['LOB-EN001', 'LOB-EN001'],
    ['MP21-EN001', 'MP21-EN001'],
    ['RA01-EN001', 'RA01-EN001'],
    ['BLAR-EN001', 'BLAR-EN001'],
    ['SS01-ENA01', 'SS01-ENA01'],
    ['LDK2-ENJ01', 'LDK2-ENJ01'],
    ['LOB-001', 'LOB-001'],
    ['DUDE-FR001', 'DUDE-FR001'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(extractSetCode(input)?.code, expected, input);
  }
});

test('corrige les confusions de glyphes selon la position', () => {
  // Chiffres lus à la place de lettres dans le préfixe et la région.
  assert.equal(extractSetCode('L0B-EN0O1').code, 'LOB-EN001');
  assert.equal(extractSetCode('5R13-ENOO4').code, 'SR13-EN004');
  // Lettre lue à la place d'un chiffre dans le numéro.
  assert.equal(extractSetCode('MP21-ENOI2').code, 'MP21-EN012');
});

test('recale une région à un caractère près quand elle est sans ambiguïté', () => {
  assert.equal(extractSetCode('BLAR-EM001').code, 'BLAR-EN001');
});

test('retrouve le code même sans tiret', () => {
  assert.equal(extractSetCode('LOBEN001').code, 'LOB-EN001');
});

test('extrait le code au milieu du bruit de la bordure', () => {
  const raw = '~ ©1996 KAZUKI TAKAHASHI  LOB-EN001 |';
  assert.equal(extractSetCode(raw).code, 'LOB-EN001');
});

test('préfère le code bien formé quand plusieurs candidats sortent', () => {
  const codes = extractSetCodes('AB-12 LOB-EN001');
  assert.equal(codes[0].code, 'LOB-EN001');
});

test('rejette ce qui ne peut pas être un code', () => {
  assert.equal(extractSetCode('DARK MAGICIAN'), null);
  assert.equal(extractSetCode(''), null);
  assert.equal(extractSetCode('ATK/2500 DEF/2100'), null);
});

test('la clé de rapprochement ignore la région des deux côtés', () => {
  assert.equal(setCodeMatchKey('LOB-FR001'), setCodeMatchKey('LOB-EN001'));
  assert.equal(extractSetCode('LOB-FR001').matchKey, setCodeMatchKey('LOB-EN001'));
  assert.equal(setCodeMatchKey('SS01-ENA01'), 'SS01-A01');
  // Sans région, il n'y a rien à retirer.
  assert.equal(setCodeMatchKey('LOB-001'), 'LOB-001');
});

test('isole la première ligne comme titre', () => {
  assert.equal(extractTitle('Dark Magician\nSPELLCASTER / NORMAL'), 'Dark Magician');
  assert.equal(extractTitle('  |Blue-Eyes White Dragon| \n'), 'IBlue-Eyes White DragonI');
  assert.equal(extractTitle('\n\n  Number 39: Utopia  \n'), 'Number 39: Utopia');
});

test('ignore les lignes sans texte exploitable', () => {
  assert.equal(extractTitle('~\n.\nPot of Greed'), 'Pot of Greed');
  assert.equal(extractTitle('   \n~~~'), '');
});

test('mesure la ressemblance de titres malgré l’OCR', () => {
  assert.ok(titleSimilarity('Blue-Eyes VVhite Dragon', 'Blue-Eyes White Dragon') > 0.9);
  assert.ok(titleSimilarity('Dark Magician', 'Pot of Greed') < 0.5);
});
