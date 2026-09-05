import test from 'node:test';
import assert from 'node:assert/strict';

import { AVANCE_MINIMALE, ConcordanceTirage, DISTANCE_EXACTE, LECTURES_AMBIGUES, LECTURES_CONCORDANTES, SIMILARITE_MINIMALE, apparierTirage, assezGrande, corrigerSelon, extraireCode, lecturesPossibles, nettoyerLecture, tiragesDuCode } from '../src/lib/tirage.js';

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
  const tronquee = apparierTirage('MP17-17', [{ setCode: 'MP17-EN171' }, { setCode: 'MP17-EN132' }]);
  assert.equal(tronquee.tirage?.setCode, 'MP17-EN171', 'numéro tronqué mais sans ambiguïté');
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
  assert.equal(assezGrande(coins(900), 1920), true);
  assert.equal(assezGrande(coins(700), 1920), false);
  assert.equal(assezGrande(null, 1920), false);
});

test('le code est extrait d’une lecture qui a attrapé du texte autour', () => {
  assert.equal(extraireCode('MP17-EN171ITTOTHEGYONCEPORCHOINWHENE'), 'MP17-EN171');
  assert.equal(extraireCode('xx LDK2-FR001 1st'), 'LDK2-FR001');
  assert.equal(extraireCode('bouillie'), 'BOUILLIE');
  const r = apparierTirage('MP17-EN171ITTOTHEGYONCEPORCHOINWHENE', [{ setCode: 'MP17-EN171' }, { setCode: 'MP17-EN132' }]);
  assert.equal(r.tirage?.setCode, 'MP17-EN171');
});

test('une lecture exacte se suffit ; une lecture approchée attend une jumelle', () => {
  assert.equal(apparierTirage('LDK2-FRY10', tirages).exact, true);
  assert.equal(apparierTirage('LDK2-FRY70', tirages).exact, false, '7 pour 1 : chiffre pour chiffre, rien ne le corrige');
  const c = new ConcordanceTirage();
  assert.equal(LECTURES_CONCORDANTES, 2);
  assert.equal(c.ajouter(apparierTirage('LDK2-FRY70', tirages)), null, 'approchée, première fois');
  assert.equal(apparierTirage('SDY-EN086', tirages).tirage?.setCode, 'SDY-EN006');
  assert.equal(c.ajouter(apparierTirage('SDY-EN086', tirages)), null, 'approchée, autre code : remise à zéro');
  assert.equal(c.ajouter(apparierTirage('SDY-EN086', tirages))?.setCode, 'SDY-EN006', 'deux approchées d’accord');
  assert.equal(c.ajouter(apparierTirage('LDK2-FRY10', tirages))?.setCode, 'LDK2-ENY10', 'exacte : tout de suite');
  assert.equal(c.ajouter({ tirage: null }), null);
});

test('nettoyerLecture et tiragesDuCode', () => {
  assert.equal(nettoyerLecture(' ldk2–fr 001 '), 'LDK2-FR001');
  const memes = tiragesDuCode(tirages, tirages[0]);
  assert.equal(memes.length, 2);
  assert.ok(memes.every((t) => t.setCode === 'LOB-EN005'));
  assert.deepEqual(tiragesDuCode(tirages, null), tirages);
});

test('tout séparateur vaut tiret, et un tiret oublié est réinséré', () => {
  assert.ok(lecturesPossibles('MP25EN051').includes('MP25-EN051'));
  assert.ok(lecturesPossibles('DPRP:EN008').includes('DPRP-EN008'));
  assert.ok(lecturesPossibles('FOTB·ENO6O').includes('FOTB-ENO6O'));
  assert.ok(lecturesPossibles('Y\n4\nMP16=EN004\n1\n1').includes('MP16-EN004'));
  assert.deepEqual(lecturesPossibles(''), []);
  assert.equal(apparierTirage('MP25EN051', [{ setCode: 'MP25-EN051' }, { setCode: 'LDS3-EN012' }]).exact, true);
});

test('les confusions lettre↔chiffre sont corrigées là où la forme du code le dit', () => {
  assert.equal(corrigerSelon('FOTB-ENO6O', 'FOTB-060'), 'FOTB-060');
  assert.equal(corrigerSelon('BLRR-ENOSA', 'BLRR-054'), 'BLRR-054');
  assert.equal(corrigerSelon('KCO1-OOD', 'KC01-008'), 'KC01-000', 'un D vaut 0 : le 8 lu D reste faux');
  assert.equal(corrigerSelon('LDK2-YI0', 'LDK2-Y10'), 'LDK2-Y10');
  assert.equal(corrigerSelon('MP17-17', 'MP17-171'), 'MP17-17', 'longueurs différentes : rien à aligner');
  assert.equal(corrigerSelon('bouillie', 'MP17-171'), 'bouillie');
  const r = apparierTirage('FOTB·ENO6O', [{ setCode: 'FOTB-EN060' }, { setCode: 'SDY-EN006' }]);
  assert.equal(r.tirage?.setCode, 'FOTB-EN060');
  assert.equal(r.exact, true);
  assert.equal(r.lecture, 'FOTB-060');
});

test('à un caractère d’un autre code de la carte, une lecture n’est jamais exacte', () => {
  assert.equal(DISTANCE_EXACTE, 2);
  const jumeaux = [{ setCode: 'MP18-EN064' }, { setCode: 'MP18-EN004' }, { setCode: 'LDK2-EN012' }];
  const r = apparierTirage('MP18-EN004', jumeaux);
  assert.equal(r.tirage?.setCode, 'MP18-EN004');
  assert.equal(r.exact, false);
  assert.equal(r.ambigu, true);
  assert.equal(apparierTirage('LDK2-EN012', jumeaux).exact, true);
  const c = new ConcordanceTirage();
  assert.equal(LECTURES_AMBIGUES, 3);
  assert.equal(c.ajouter(apparierTirage('MP18-EN0O4', jumeaux)), null, 'corrigée : compte comme le code tel quel');
  assert.equal(c.ajouter(apparierTirage('MP18-EN004', jumeaux)), null, 'deux fois : pas encore');
  assert.equal(c.ajouter(apparierTirage('MP18-EN004', jumeaux))?.setCode, 'MP18-EN004', 'trois fois : retenu');
  const approchee = apparierTirage('MP18-EN007', jumeaux);
  assert.equal(approchee.ambigu, false, 'à deux caractères de l’autre code : approchée ordinaire');
  const seule = new ConcordanceTirage();
  assert.equal(seule.ajouter({ tirage: jumeaux[1], ambigu: true, similarite: 87.5 }), null, 'ambiguë et approchée : ignorée');
  assert.equal(seule.ajouter({ tirage: jumeaux[1], ambigu: true, similarite: 87.5 }), null);
});
