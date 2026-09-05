import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLE_STOCKAGE,
  REGIONS,
  REGION_DEFAUT,
  codePourRegion,
  ecrireRegion,
  libelleRegion,
  lireRegion,
  regionConnue,
  regionDuCode,
  tiragesPourRegion,
  trierParRegion,
} from '../src/lib/region.js';

/** Un `localStorage` de poche, pour ne pas dépendre du navigateur. */
function stockage(initial = {}) {
  const memoire = new Map(Object.entries(initial));
  return {
    getItem: (cle) => (memoire.has(cle) ? memoire.get(cle) : null),
    setItem: (cle, valeur) => memoire.set(cle, String(valeur)),
    memoire,
  };
}

/* --- Liste ------------------------------------------------------------- */

test('les régions qui existent sont listées, le français en premier', () => {
  assert.deepEqual(
    REGIONS.map((r) => r.code),
    ['FR', 'EN', 'DE', 'IT', 'SP', 'PT', 'JP', 'KR', 'AE', 'TC', 'SC'],
  );
  assert.equal(REGION_DEFAUT, 'FR');
  // Pas de cartes danoises : c'est l'édition anglaise, et le libellé le dit.
  assert.match(libelleRegion('EN'), /^Anglais \(EN\) — .*Danemark/);
  assert.equal(libelleRegion('FR'), 'Français (FR) — France, Belgique, Suisse, Québec');
  assert.equal(libelleRegion('XX'), 'XX');
  assert.equal(regionConnue(' fr '), 'FR');
  assert.equal(regionConnue('DK'), null);
});

/* --- Préférence -------------------------------------------------------- */

test('la préférence se lit et s’écrit dans localStorage, avec le français par défaut', () => {
  const s = stockage();
  assert.equal(lireRegion(s), 'FR');
  assert.equal(ecrireRegion('de', s), 'DE');
  assert.equal(s.memoire.get(CLE_STOCKAGE), 'DE');
  assert.equal(lireRegion(s), 'DE');
  // Une valeur inconnue n'est ni enregistrée ni rendue.
  assert.equal(ecrireRegion('DK', s), 'DE');
  assert.equal(lireRegion(stockage({ [CLE_STOCKAGE]: 'zz' })), 'FR');
});

test('sans localStorage, ou avec un stockage qui lève, la préférence vaut le défaut', () => {
  assert.equal(lireRegion(undefined), 'FR');
  assert.equal(ecrireRegion('EN', undefined), 'EN');
  const casse = {
    getItem() {
      throw new Error('accès interdit');
    },
    setItem() {
      throw new Error('quota dépassé');
    },
  };
  assert.equal(lireRegion(casse), 'FR');
  assert.equal(ecrireRegion('IT', casse), 'IT');
});

/* --- Codes ------------------------------------------------------------- */

test('un code anglais se met dans la région choisie, lettre de série comprise', () => {
  assert.equal(codePourRegion('LOB-EN005', 'FR'), 'LOB-FR005');
  assert.equal(codePourRegion('LOB-EN005', 'DE'), 'LOB-DE005');
  assert.equal(codePourRegion('LOB-EN005', 'EN'), 'LOB-EN005');
  assert.equal(codePourRegion('LEHD-ENA26', 'FR'), 'LEHD-FRA26');
  assert.equal(codePourRegion('SOI-ENSE1', 'IT'), 'SOI-ITSE1');
  assert.equal(codePourRegion('RA03-EN001', 'SP'), 'RA03-SP001');
  assert.equal(codePourRegion('OP13-PT006', 'FR'), 'OP13-FR006');
  assert.equal(codePourRegion('LDK2-FR001', 'EN'), 'LDK2-EN001');
  assert.equal(codePourRegion('lob-en005', 'fr'), 'LOB-FR005');
});

test('les anciens codes à une lettre suivent la lettre de leur époque', () => {
  assert.equal(codePourRegion('PSV-E088', 'FR'), 'PSV-F088');
  assert.equal(codePourRegion('LOB-E003', 'DE'), 'LOB-G003');
  assert.equal(codePourRegion('LOB-E003', 'IT'), 'LOB-I003');
  assert.equal(codePourRegion('LOB-E003', 'SP'), 'LOB-S003');
  assert.equal(codePourRegion('LOB-E003', 'PT'), 'LOB-P003');
  assert.equal(codePourRegion('LOB-E003', 'EN'), 'LOB-E003');
  // Le japonais n'a pas existé sous cette forme : le code reste tel quel.
  assert.equal(codePourRegion('PSV-E088', 'JP'), 'PSV-E088');
});

test('ce qui ne se convertit pas reste tel quel', () => {
  // Édition nord-américaine sans région : « LOB-005 » et « LOB-E003 » sont
  // la même carte sous deux numérotations, fabriquer « LOB-F005 » désignerait
  // une autre carte.
  assert.equal(codePourRegion('LOB-005', 'FR'), 'LOB-005');
  assert.equal(codePourRegion('AST-070', 'DE'), 'AST-070');
  // Tête inconnue, code sans tiret, valeurs vides.
  assert.equal(codePourRegion('XXX-SE1', 'FR'), 'XXX-SE1');
  assert.equal(codePourRegion('DB49', 'FR'), 'DB49');
  assert.equal(codePourRegion('', 'FR'), '');
  assert.equal(codePourRegion(null, 'FR'), null);
  // Région cible inconnue : rien ne change.
  assert.equal(codePourRegion('LOB-EN005', 'DK'), 'LOB-EN005');
  assert.equal(codePourRegion('LOB-EN005', ''), 'LOB-EN005');
});

test('la région d’un code se lit sous sa forme à deux lettres', () => {
  assert.equal(regionDuCode('LDK2-FR001'), 'FR');
  assert.equal(regionDuCode('LEHD-ENA26'), 'EN');
  assert.equal(regionDuCode('PSV-E088'), 'EN');
  assert.equal(regionDuCode('PSV-F088'), 'FR');
  assert.equal(regionDuCode('AST-070'), '');
  assert.equal(regionDuCode(''), '');
});

/* --- Tirages ----------------------------------------------------------- */

test('le tri met en tête les tirages de la région choisie, sans changer l’ordre du reste', () => {
  const tirages = [
    { setCode: 'LOB-005', rarity: 'Ultra Rare' },
    { setCode: 'LDK2-DE001', rarity: 'Common' },
    { setCode: 'LOB-EN005', rarity: 'Ultra Rare' },
    { setCode: 'SDY-DE006', rarity: 'Common' },
    { setCode: 'PSV-G088', rarity: 'Rare' },
  ];
  assert.deepEqual(
    trierParRegion(tirages, 'DE').map((t) => t.setCode),
    ['LDK2-DE001', 'SDY-DE006', 'PSV-G088', 'LOB-005', 'LOB-EN005'],
  );
  assert.deepEqual(
    trierParRegion(tirages, 'EN').map((t) => t.setCode),
    ['LOB-EN005', 'LOB-005', 'LDK2-DE001', 'SDY-DE006', 'PSV-G088'],
  );
  assert.deepEqual(trierParRegion([], 'FR'), []);
  assert.deepEqual(trierParRegion(tirages, 'XX'), tirages);
});

test('les tirages pour une région sont convertis, dédoublonnés, la région en tête', () => {
  const tirages = tiragesPourRegion(
    [
      { setCode: 'LOB-005', rarity: 'Ultra Rare', setName: 'LOB (Amérique)' },
      { setCode: 'LOB-EN005', rarity: 'Ultra Rare', setName: 'LOB' },
      { setCode: 'OP13-EN006', rarity: 'Common', setName: 'OTS 13' },
      { setCode: 'OP13-PT006', rarity: 'Common', setName: 'OTS 13' },
      { setCode: 'LOB-EN005', rarity: 'Ultra Rare', setName: 'LOB' },
    ],
    'FR',
  );
  assert.deepEqual(
    tirages.map((t) => [t.setCode, t.setCodePublie]),
    [
      ['LOB-FR005', 'LOB-EN005'],
      ['OP13-FR006', 'OP13-EN006'],
      ['LOB-005', 'LOB-005'],
    ],
  );
  // Le nom de série et la rareté suivent le tirage.
  assert.equal(tirages[1].setName, 'OTS 13');
  assert.equal(tirages[1].rarity, 'Common');

  // Une seconde conversion repart du code publié, pas du code déjà converti.
  const allemands = tiragesPourRegion(tirages, 'DE');
  assert.deepEqual(allemands.map((t) => t.setCode), ['LOB-DE005', 'OP13-DE006', 'LOB-005']);
  assert.deepEqual(tiragesPourRegion(undefined, 'FR'), []);
});
