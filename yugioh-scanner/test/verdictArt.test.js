import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSearchIndex } from '../src/lib/match.js';
import { MARGE_FERME, MARGE_PROPOSE, MARGE_SURE, SCORE_FERME, SCORE_PROPOSE, SCORE_SUR, VoteArt, resultatDepuisArt, tiragesDistincts, zoneDe } from '../src/lib/verdictArt.js';
import { toContainerPoint, toVideoRect } from '../src/lib/viewport.js';

const index = buildSearchIndex({
  version: 1,
  sets: ['Legend of Blue Eyes', 'Structure Deck'],
  rarities: ['Ultra Rare', 'Common'],
  cards: [
    [46986414, 'Dark Magician', [[0, 'LOB-005', 0], [1, 'SDY-006', 1], [1, 'SDY-006', 1]]],
    [89631139, 'Blue-Eyes White Dragon', [[0, 'LOB-001', 0]]],
  ],
});

test('un score sûr avec une marge nette est accepté à la première image', () => {
  const vote = new VoteArt();
  const v = vote.cast([{ id: 46986414, score: SCORE_SUR }, { id: 1, score: SCORE_SUR - MARGE_SURE }]);
  assert.equal(v.accepted, true);
  assert.equal(v.id, 46986414);
  assert.equal(v.zone, 'sure');
});

test('un score moyen n’est accepté qu’avec une marge large, jamais par répétition', () => {
  const vote = new VoteArt();
  const serre = [{ id: 7, score: 0.78 }, { id: 8, score: 0.7 }];
  assert.equal(vote.cast(serre).accepted, false);
  // La même lecture une deuxième fois ne change rien : deux images d'un
  // téléphone immobile ne sont pas deux témoins.
  assert.equal(vote.cast(serre).accepted, false);
  const large = [{ id: 7, score: SCORE_FERME }, { id: 8, score: SCORE_FERME - MARGE_FERME }];
  assert.equal(vote.cast(large).accepted, true);
});

test('entre les deux, les trois meilleures cartes sont proposées ; en dessous, rien', () => {
  const proposer = zoneDe([{ id: 1, score: SCORE_PROPOSE + 0.02 }, { id: 2, score: SCORE_PROPOSE + 0.02 - MARGE_PROPOSE }, { id: 3, score: 0.5 }, { id: 4, score: 0.4 }]);
  assert.equal(proposer.zone, 'proposer');
  assert.deepEqual(proposer.propositions.map((p) => p.id), [1, 2, 3]);
  // Un score correct mais talonné par une autre carte : on propose, on ne tranche pas.
  assert.equal(new VoteArt().cast([{ id: 1, score: 0.8 }, { id: 2, score: 0.76 }]).accepted, false);
  assert.equal(new VoteArt().cast([{ id: 1, score: 0.8 }, { id: 2, score: 0.76 }]).zone, 'proposer');
  const rien = zoneDe([{ id: 1, score: SCORE_PROPOSE - 0.01 }]);
  assert.equal(rien.zone, 'rien');
  assert.equal(rien.id, null);
  assert.deepEqual(zoneDe([]).propositions, []);
});

test('le résultat a la forme d’un scan : carte, tirages distincts, choix requis', () => {
  const r = resultatDepuisArt(index, 46986414, { score: 0.9, marge: 0.2, sens: 'droite', quad: null });
  assert.equal(r.status, 'needs_user_selection');
  assert.equal(r.method, 'art');
  assert.equal(r.matchedCode, null);
  assert.equal(r.card.id, 46986414);
  assert.equal(r.card.name, 'Dark Magician');
  assert.equal(r.rarities.length, 2, 'deux tirages distincts, le doublon écarté');
  assert.equal(r.confidence, 90);

  const unique = resultatDepuisArt(index, 89631139, { score: 0.9, marge: 0.2, sens: 'droite', quad: null });
  assert.equal(unique.status, 'resolved');
  assert.equal(resultatDepuisArt(index, 123, { score: 0.9, marge: 0.2 }).status, 'no_match');
  assert.deepEqual(tiragesDistincts([]), []);
  // Les codes restent ceux publiés, dans l'ordre de l'index : la langue de
  // l'utilisateur s'applique à l'affichage (`fiche.js`), pas ici.
  const distincts = tiragesDistincts([
    { setCode: 'LOB-005', rarity: 'Ultra Rare' },
    { setCode: 'LDK2-EN001', rarity: 'Common' },
    { setCode: 'LOB-EN005', rarity: 'Ultra Rare' },
    { setCode: 'LDK2-EN001', rarity: 'Common' },
  ]);
  assert.deepEqual(distincts.map((t) => t.setCode), ['LOB-005', 'LDK2-EN001', 'LOB-EN005']);
  assert.equal(r.regionLue, '', 'aucun code lu : la préférence décidera');
});

test('toContainerPoint est l’inverse de toVideoRect', () => {
  const video = { width: 1920, height: 1080 };
  const container = { width: 390, height: 844 };
  const rect = toVideoRect({ x: 40, y: 300, width: 100, height: 50 }, video, container);
  const coin = toContainerPoint({ x: rect.x, y: rect.y }, video, container);
  assert.ok(Math.abs(coin.x - 40) < 1e-6 && Math.abs(coin.y - 300) < 1e-6);
});
