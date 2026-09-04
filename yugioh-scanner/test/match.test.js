import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSearchIndex,
  completePasscode,
  distinctRarities,
  findCandidates,
  trigrams,
  zoneSatisfied,
} from '../src/lib/match.js';

/** Index réduit mais représentatif : des noms proches, une carte multi-raretés. */
const RAW = {
  version: '2026-09-04',
  sets: ['Legend of Blue Eyes White Dragon', 'Metal Raiders', 'Legend of Blue Eyes White Dragon (25th Anniversary Edition)'],
  rarities: ['Ultra Rare', 'Common', 'Short Print', 'Secret Rare'],
  cards: [
    [89631139, 'Blue-Eyes White Dragon', [[0, 'LOB-EN001', 0]]],
    [23995346, 'Blue-Eyes Ultimate Dragon', [[1, 'MRD-EN060', 3]]],
    [38517737, 'Deep-Eyes White Dragon', [[1, 'MRD-EN061', 1]]],
    [46052923, 'Beast Fangs', [[0, 'LOB-EN041', 2], [2, 'LOB-EN041', 1]]],
    [55144522, 'Pot of Greed', [[1, 'MRD-EN101', 1]]],
  ],
};

const index = buildSearchIndex(RAW);

test('les trigrammes bornent le texte pour marquer débuts et fins', () => {
  const found = trigrams('ab');
  assert.ok(found.has('  a'));
  assert.ok(found.has(' ab'));
  assert.ok(found.has('ab '));
});

test('l’index résout le dictionnaire des séries et des raretés', () => {
  const card = index.cards.find((entry) => entry.id === 89631139);
  assert.equal(card.printings[0].setName, 'Legend of Blue Eyes White Dragon');
  assert.equal(card.printings[0].rarity, 'Ultra Rare');
});

test('le passcode tranche seul et sans ambiguïté', () => {
  const [best] = findCandidates(index, { passcode: '89631139' });
  assert.equal(best.card.name, 'Blue-Eyes White Dragon');
  assert.equal(best.score, 1);
  assert.deepEqual(best.reasons, ['passcode']);
});

test('un passcode inconnu ne renvoie pas une carte au hasard', () => {
  assert.deepEqual(findCandidates(index, { passcode: '00000000' }), []);
});

test('un titre bruité retrouve quand même la bonne carte', () => {
  const cases = ['Biue-Eves Whlte Dragan', 'B1ue-Eyes Wh1te Draqon', 'Blue-Eyes Whi1e Dragon'];
  for (const title of cases) {
    assert.equal(findCandidates(index, { title })[0].card.name, 'Blue-Eyes White Dragon', title);
  }
});

test('les cartes voisines sont proposées derrière, pas écartées', () => {
  const names = findCandidates(index, { title: 'Blue-Eyes White Dragon' }).map((c) => c.card.name);
  assert.equal(names[0], 'Blue-Eyes White Dragon');
  assert.ok(names.includes('Deep-Eyes White Dragon'));
});

test('le code d’extension prime sur un titre approchant', () => {
  // Le titre penche vers « Blue-Eyes White Dragon », le code désigne Beast Fangs.
  const [best] = findCandidates(index, {
    setCode: { matchKey: 'LOB-041' },
    title: 'Beast Fanqs',
  });
  assert.equal(best.card.name, 'Beast Fangs');
  assert.ok(best.codeMatched);
  assert.ok(best.score > 0.9);
});

test('un code seul suffit à désigner une carte', () => {
  const [best] = findCandidates(index, { setCode: { matchKey: 'LOB-001' } });
  assert.equal(best.card.name, 'Blue-Eyes White Dragon');
  assert.deepEqual(best.reasons, ['code']);
  // Seul indice disponible et il colle : la confiance est pleine.
  assert.equal(best.score, 1);
});

test('la note ne compte que les indices réellement lus', () => {
  // Titre parfait et rien d'autre : la carte est certaine, la note doit le dire.
  const [parTitre] = findCandidates(index, { title: 'Blue-Eyes White Dragon' });
  assert.equal(parTitre.score, 1);

  // Code seul et il colle : pleine confiance également.
  const [parCode] = findCandidates(index, { setCode: { matchKey: 'MRD-101' } });
  assert.equal(parCode.score, 1);
});

test('des indices qui se contredisent laissent l’utilisateur trancher', () => {
  // Le titre dit Blue-Eyes, le code dit Pot of Greed.
  const results = findCandidates(index, {
    title: 'Blue-Eyes White Dragon',
    setCode: { matchKey: 'MRD-101' },
  });
  const noms = results.map((entry) => entry.card.name);

  // Les deux sont proposés, aucun ne prétend à la certitude.
  assert.ok(noms.includes('Pot of Greed'), 'la carte du code doit être proposée');
  assert.ok(noms.includes('Blue-Eyes White Dragon'), 'la carte du titre doit être proposée');
  assert.ok(
    results.every((entry) => entry.score < 0.8),
    'aucun candidat ne doit atteindre la pleine confiance',
  );
  // Le code pèse plus lourd que le titre : c'est lui qui mène.
  assert.equal(results[0].card.name, 'Pot of Greed');
});

test('un passcode amputé d’un chiffre est reconstitué s’il est le seul possible', () => {
  // 89631139 privé de son premier chiffre.
  assert.equal(completePasscode(index.byPasscode, '9631139'), 89631139);
  const [best] = findCandidates(index, { passcode: '9631139' });
  assert.equal(best.card.name, 'Blue-Eyes White Dragon');
  assert.deepEqual(best.reasons, ['passcode']);
});

test('une reconstitution ambiguë est refusée plutôt que devinée', () => {
  // Deux cartes ne différant que par un chiffre : aucune complétion unique.
  const ambigu = buildSearchIndex({
    version: 'test',
    sets: ['S'],
    rarities: ['Common'],
    cards: [
      [11111111, 'Carte A', [[0, 'S-EN001', 0]]],
      [11111112, 'Carte B', [[0, 'S-EN002', 0]]],
    ],
  });
  assert.equal(completePasscode(ambigu.byPasscode, '1111111'), null);
  assert.deepEqual(findCandidates(ambigu, { passcode: '1111111' }), []);
});

test('une zone n’est réglée que si sa valeur existe dans la base', () => {
  // Bien formé mais absent : la lecture doit être retentée.
  assert.equal(
    zoneSatisfied(index, { setCode: { matchKey: 'IOR-001' }, title: '', passcode: '' }, 'setCode'),
    false,
  );
  assert.equal(
    zoneSatisfied(index, { setCode: { matchKey: 'LOB-001' }, title: '', passcode: '' }, 'setCode'),
    true,
  );
  assert.equal(zoneSatisfied(index, { passcode: '00000000', title: '' }, 'passcode'), false);
  assert.equal(zoneSatisfied(index, { passcode: '89631139', title: '' }, 'passcode'), true);
  assert.equal(zoneSatisfied(index, { title: 'Blue' }, 'title'), true);
  assert.equal(zoneSatisfied(index, { title: 'ab' }, 'title'), false);
});

test('le code filtre les tirages proposés', () => {
  const [best] = findCandidates(index, { setCode: { matchKey: 'LOB-041' } });
  // Beast Fangs existe en Short Print et en Common sous le même code.
  assert.equal(best.printings.length, 2);
  assert.deepEqual(
    distinctRarities(best.printings).map((p) => p.rarity),
    ['Short Print', 'Common'],
  );
});

test('sans code lu, tous les tirages restent proposés', () => {
  const [best] = findCandidates(index, { title: 'Beast Fangs' });
  assert.equal(best.printings.length, 2);
});

test('un texte sans rapport ne propose rien', () => {
  assert.deepEqual(findCandidates(index, { title: 'zzz qqq xxx' }), []);
  assert.deepEqual(findCandidates(index, {}), []);
});

test('la liste est bornée et ordonnée par note décroissante', () => {
  const results = findCandidates(index, { title: 'Blue-Eyes Dragon' }, { limit: 2 });
  assert.ok(results.length <= 2);
  assert.ok(results[0].score >= (results[1]?.score ?? 0));
});
