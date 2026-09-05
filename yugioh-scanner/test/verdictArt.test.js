import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSearchIndex } from '../src/lib/match.js';
import { MARGE_SURE, SCORE_MINIMAL, SCORE_SUR, VoteArt, resultatDepuisArt, tiragesDistincts } from '../src/lib/verdictArt.js';
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
});

test('un score moyen exige deux images d’accord, un score faible ne compte pas', () => {
  let temps = 0;
  const vote = new VoteArt({ now: () => temps });
  const candidats = [{ id: 7, score: 0.78 }, { id: 8, score: 0.7 }];
  assert.equal(vote.cast(candidats).accepted, false);
  temps += 500;
  assert.equal(vote.cast(candidats).accepted, true);
  // Une autre carte entre-temps ne cumule pas avec la première.
  vote.reset();
  assert.equal(vote.cast([{ id: 7, score: 0.78 }]).accepted, false);
  assert.equal(vote.cast([{ id: 9, score: 0.78 }]).accepted, false);
  const faible = vote.cast([{ id: 7, score: SCORE_MINIMAL - 0.01 }]);
  assert.equal(faible.accepted, false);
  assert.equal(faible.id, null);
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
  const tries = tiragesDistincts([
    { setCode: 'LOB-005', rarity: 'Ultra Rare' },
    { setCode: 'LDK2-FR001', rarity: 'Common' },
    { setCode: 'LOB-EN005', rarity: 'Ultra Rare' },
    { setCode: 'SDY-FR006', rarity: 'Common' },
  ]);
  assert.deepEqual(tries.map((t) => t.setCode), ['LDK2-FR001', 'SDY-FR006', 'LOB-005', 'LOB-EN005']);
});

test('toContainerPoint est l’inverse de toVideoRect', () => {
  const video = { width: 1920, height: 1080 };
  const container = { width: 390, height: 844 };
  const rect = toVideoRect({ x: 40, y: 300, width: 100, height: 50 }, video, container);
  const coin = toContainerPoint({ x: rect.x, y: rect.y }, video, container);
  assert.ok(Math.abs(coin.x - 40) < 1e-6 && Math.abs(coin.y - 300) < 1e-6);
});
