import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSearchIndex } from '../src/lib/match.js';
import { MARGE_FERME, MARGE_SURE, SCORE_FERME, SCORE_SUR, VoteArt, resultatDepuisArt, tiragesDistincts, zoneDe } from '../src/lib/verdictArt.js';
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

test('une carte sûre n’est verrouillée qu’à la deuxième image de suite', () => {
  const vote = new VoteArt();
  const sure = [{ id: 46986414, score: SCORE_SUR + 0.01 }, { id: 1, score: SCORE_SUR + 0.01 - MARGE_SURE - 0.01 }];
  const premiere = vote.cast(sure);
  assert.equal(premiere.accepted, false);
  assert.equal(premiere.zone, 'sure');
  assert.equal(premiere.suite, 1);
  const seconde = vote.cast(sure);
  assert.equal(seconde.accepted, true);
  assert.equal(seconde.id, 46986414);
});

test('une passe sûre sur une autre carte, ou une passe moyenne, remet le compte à zéro', () => {
  const vote = new VoteArt();
  const a = [{ id: 7, score: 0.95 }, { id: 8, score: 0.5 }];
  const b = [{ id: 9, score: 0.95 }, { id: 8, score: 0.5 }];
  vote.cast(a);
  assert.equal(vote.cast(b).accepted, false, 'autre carte');
  assert.equal(vote.cast(b).accepted, true);
  vote.reset();
  vote.cast(a);
  assert.equal(vote.cast([{ id: 7, score: 0.78 }, { id: 8, score: 0.7 }]).accepted, false, 'marge serrée');
  assert.equal(vote.cast(a).accepted, false, 'il faut repartir de zéro');
  assert.equal(vote.cast(a).accepted, true);
  const large = [{ id: 7, score: SCORE_FERME }, { id: 8, score: SCORE_FERME - MARGE_FERME }];
  assert.equal(zoneDe(large).zone, 'sure');
});

test('hors zone sûre, rien : ni identifiant, ni verrouillage', () => {
  // Un score correct mais talonné par une autre carte : on continue de chercher.
  assert.equal(new VoteArt().cast([{ id: 1, score: 0.8 }, { id: 2, score: 0.76 }]).accepted, false);
  assert.equal(zoneDe([{ id: 1, score: 0.86 }, { id: 2, score: 0.8 }]).zone, 'rien', 'marge 0,06 : pas assez');
  const rien = zoneDe([{ id: 1, score: 0.69 }]);
  assert.equal(rien.zone, 'rien');
  assert.equal(rien.id, null);
  assert.equal(zoneDe([]).zone, 'rien');
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
