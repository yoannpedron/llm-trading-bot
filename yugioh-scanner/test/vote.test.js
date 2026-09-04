import test from 'node:test';
import assert from 'node:assert/strict';

import { ReadingVote } from '../src/lib/vote.js';

const horloge = () => {
  const state = { value: 0 };
  return { state, now: () => state.value };
};

test('une correspondance certaine est acceptée sans confirmation', () => {
  const vote = new ReadingVote();
  assert.deepEqual(vote.cast('LOB-EN001', { certain: true }), { accepted: true, count: 2 });
});

test('une correspondance approchée exige une deuxième lecture', () => {
  const { state, now } = horloge();
  const vote = new ReadingVote({ now });

  assert.equal(vote.cast('LOB-EN001').accepted, false);
  state.value += 400;
  assert.equal(vote.cast('LOB-EN001').accepted, true);
});

test('deux codes différents ne se confirment pas l’un l’autre', () => {
  const { state, now } = horloge();
  const vote = new ReadingVote({ now });

  vote.cast('LOB-EN001');
  state.value += 300;
  assert.equal(vote.cast('MRD-EN101').accepted, false);
  state.value += 300;
  assert.equal(vote.cast('MRD-EN101').accepted, true);
});

test('une lecture trop ancienne ne compte plus', () => {
  const { state, now } = horloge();
  const vote = new ReadingVote({ now, windowMs: 1000 });

  vote.cast('LOB-EN001');
  state.value += 1500;
  // Hors fenêtre : cette lecture repart de zéro.
  assert.deepEqual(vote.cast('LOB-EN001'), { accepted: false, count: 1 });
  state.value += 100;
  assert.equal(vote.cast('LOB-EN001').accepted, true);
});

test('la table ne garde pas les codes périmés', () => {
  const { state, now } = horloge();
  const vote = new ReadingVote({ now, windowMs: 1000 });

  vote.cast('AAA-EN001');
  state.value += 1500;
  vote.cast('BBB-EN001');
  assert.equal(vote.seen.has('AAA-EN001'), false);
  assert.equal(vote.count('BBB-EN001'), 1);
});

test('une lecture vide n’est jamais comptée', () => {
  const vote = new ReadingVote();
  assert.deepEqual(vote.cast(''), { accepted: false, count: 0 });
  assert.deepEqual(vote.cast(null), { accepted: false, count: 0 });
});

test('la remise à zéro efface tout', () => {
  const vote = new ReadingVote();
  vote.cast('LOB-EN001');
  vote.reset();
  assert.equal(vote.count('LOB-EN001'), 0);
});
