import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FUZZY_CUTOFF,
  FUZZY_MARGIN,
  buildSearchIndex,
  completePasscode,
  distinctRarities,
  findCandidates,
  resolveSetCode,
  suggestSetCodes,
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

/* --- Mode sniper : résolution par le seul code ---------------------------- */

test('un code lu tel quel est une correspondance exacte', () => {
  const resolved = resolveSetCode(index, 'LOB-EN001');
  assert.equal(resolved.status, 'matched');
  assert.equal(resolved.method, 'exact');
  assert.equal(resolved.card.name, 'Blue-Eyes White Dragon');
});

test('une carte française retombe sur la donnée anglaise en affichant son code', () => {
  const resolved = resolveSetCode(index, 'LOB-FR001');
  assert.equal(resolved.method, 'region');
  assert.equal(resolved.matchedCode, 'LOB-FR001');
  assert.equal(resolved.sourceCode, 'LOB-EN001');
});

test('une erreur sur le numéro est refusée plutôt que rapprochée', () => {
  // « LOB-EN002 » est à un caractère de « LOB-EN001 » — et, dans la vraie
  // base, c'est une autre carte. Sur une clé de sept caractères, un seul
  // écart vaut 85,7 : sous le plancher. Mesuré : tolérer cet écart rendait
  // autant de mauvaises cartes que de bonnes (PASSATION.md, § 3).
  assert.ok(FUZZY_CUTOFF > 87.5, 'un écart sur huit caractères doit être refusé');
  assert.equal(resolveSetCode(index, 'LOB-EN0O2').status, 'no_match');
});

test('une correspondance approchée unique est acceptée au-delà du plancher', () => {
  // Plancher abaissé pour exercer le chemin sur les clés courtes du jeu de
  // test ; en production, seules les clés longues y passent encore.
  const resolved = resolveSetCode(index, 'MRD-FR10', { cutoff: 80 });
  assert.equal(resolved.status, 'matched');
  assert.equal(resolved.method, 'fuzzy');
  assert.equal(resolved.card.name, 'Pot of Greed');
  // Le code rendu est celui publié, pas la région lue : la lecture contient
  // l'erreur qu'on vient de rattraper. Même choix que le serveur.
  assert.equal(resolved.matchedCode, 'MRD-EN101');
  assert.equal(resolved.regional, false);
  assert.equal(resolved.confidence, 85.7);
});

test('une hésitation entre deux cartes ne désigne rien', () => {
  // « MRD-06 » est aussi proche de MRD-EN060 que de MRD-EN061.
  assert.ok(FUZZY_MARGIN > 0);
  const resolved = resolveSetCode(index, 'MRD-EN06', { cutoff: 80 });
  assert.equal(resolved.status, 'no_match');
  assert.equal(resolved.reason, 'ambiguous');
  assert.deepEqual(new Set(resolved.between), new Set(['MRD-060', 'MRD-061']));
});

test('sans marge, la première venue l’emporte — réservé aux bancs de mesure', () => {
  const resolved = resolveSetCode(index, 'MRD-EN06', { cutoff: 80, margin: 0 });
  assert.equal(resolved.status, 'matched');
  assert.equal(resolved.method, 'fuzzy');
});

test('une clé ne se fait pas concurrence à elle-même entre transpositions', () => {
  // « MRD-FR10 » engendre aussi « MR0-FR10 » : deux candidats, une seule clé
  // visée. Le second ne doit pas passer pour un rival du premier.
  const resolved = resolveSetCode(index, 'MRD-FR10', { cutoff: 80 });
  assert.equal(resolved.status, 'matched');
});

/* --- Saisie manuelle ------------------------------------------------------ */

test('la complétion propose les codes qui commencent par la saisie', () => {
  const names = (typed) => suggestSetCodes(index, typed).map((s) => s.code);
  assert.deepEqual(names('MRD-EN06'), ['MRD-EN060', 'MRD-EN061']);
  assert.deepEqual(names('mrd-en 06'), ['MRD-EN060', 'MRD-EN061']);
  assert.deepEqual(names('LOB-EN0'), ['LOB-EN001', 'LOB-EN041']);
});

test('la région tapée est conservée dans les propositions', () => {
  assert.deepEqual(
    suggestSetCodes(index, 'LOB-FR0').map((s) => s.code),
    ['LOB-FR001', 'LOB-FR041'],
  );
  // Région incomplète : on complète sur le préfixe, en forme anglaise.
  assert.deepEqual(
    suggestSetCodes(index, 'LOB-F').map((s) => s.code),
    ['LOB-EN001', 'LOB-EN041'],
  );
  assert.deepEqual(
    suggestSetCodes(index, 'LO').map((s) => s.code),
    ['LOB-EN001', 'LOB-EN041'],
  );
});

test('la complétion porte le nom de la carte et respecte la limite', () => {
  const found = suggestSetCodes(index, 'MRD', { limit: 2 });
  assert.equal(found.length, 2);
  assert.equal(found[0].name, 'Blue-Eyes Ultimate Dragon');
  assert.deepEqual(suggestSetCodes(index, 'X'), []);
  assert.deepEqual(suggestSetCodes(index, 'ZZZ-EN'), []);
  assert.deepEqual(suggestSetCodes(index, ''), []);
});

test('la complétion tient compte du numéro même sans région à deux lettres', () => {
  // Le défaut historique : « LOB-041 » retombait sur « LOB- » et proposait
  // LOB-000 à LOB-005, six cartes qui ne sont jamais la bonne. Mesuré sur
  // l'index réel : 2 332 codes imprimés sur 38 435 n'apparaissaient jamais
  // dans leurs propres propositions, tous sur des séries anciennes.
  const codes = (saisie) => suggestSetCodes(index, saisie).map((s) => s.code);

  assert.deepEqual(codes('LOB-041'), ['LOB-EN041']);
  assert.deepEqual(codes('LOB-EN041'), ['LOB-EN041']);
  assert.deepEqual(codes('LOB-FR041'), ['LOB-FR041']);

  // Une région incomplète ne peut rien resserrer : on garde le préfixe plutôt
  // que de ne rien proposer du tout.
  assert.deepEqual(codes('LOB-F'), ['LOB-EN001', 'LOB-EN041']);
  assert.deepEqual(codes('LOB-'), ['LOB-EN001', 'LOB-EN041']);
});

test('un code proposé existe toujours dans la base', () => {
  // La proposition était fabriquée en insérant « EN » après le tiret de la
  // clé, ce qui donnait des références introuvables sur les codes dont la
  // queue commence par une lettre. Toute proposition doit se résoudre.
  for (const saisie of ['LOB', 'LOB-0', 'MRD-06', 'LOB-FR0', 'MRD-EN1']) {
    for (const proposition of suggestSetCodes(index, saisie)) {
      const resolu = resolveSetCode(index, proposition.code);
      assert.equal(resolu.status, 'matched', `${proposition.code} ne se résout pas`);
      assert.equal(resolu.card.name, proposition.name);
    }
  }
});
