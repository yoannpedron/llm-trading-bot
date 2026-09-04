import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FrameWatcher,
  MOTION_THRESHOLD,
  SIGNATURE_HEIGHT,
  SIGNATURE_WIDTH,
  STABLE_MS,
  gradientEnergy,
  meanAbsDiff,
} from '../src/lib/motion.js';

const SIZE = SIGNATURE_WIDTH * SIGNATURE_HEIGHT;

const flat = (value) => Uint8ClampedArray.from({ length: SIZE }, () => value);
const striped = (offset = 0) =>
  Uint8ClampedArray.from({ length: SIZE }, (_, i) => ((i + offset) % 2 ? 255 : 0));

test('l’écart de deux empreintes identiques est nul', () => {
  assert.equal(meanAbsDiff(flat(120), flat(120)), 0);
});

test('l’écart est maximal entre le noir et le blanc', () => {
  assert.equal(meanAbsDiff(flat(0), flat(255)), 1);
});

test('une empreinte manquante compte comme un écart total', () => {
  assert.equal(meanAbsDiff(null, flat(10)), 1);
});

test('un aplat n’a aucune netteté, un damier en a beaucoup', () => {
  assert.ok(gradientEnergy(flat(128), SIGNATURE_WIDTH, SIGNATURE_HEIGHT) < 0.01);
  assert.ok(gradientEnergy(striped(), SIGNATURE_WIDTH, SIGNATURE_HEIGHT) > 0.4);
});

test('ne scanne qu’après la durée de stabilité exigée', () => {
  let clock = 0;
  const watcher = new FrameWatcher({ now: () => clock });
  const frame = striped();

  // Première image : rien à comparer, l'écart vaut 1 -> mouvement.
  assert.equal(watcher.update(frame, 0.5).state, 'moving');

  clock += 50;
  assert.equal(watcher.update(frame, 0.5).state, 'settling');

  clock += STABLE_MS;
  const settled = watcher.update(frame, 0.5);
  assert.equal(settled.state, 'ready');
  assert.equal(settled.shouldScan, true);
});

/**
 * Joue la séquence complète : une image de découverte, une qui amorce le
 * compteur de stabilité, puis une après le délai exigé.
 */
const settle = (watcher, frame, clock, sharpness = 0.5) => {
  watcher.update(frame, sharpness);
  watcher.update(frame, sharpness);
  clock.value += STABLE_MS + 10;
  return watcher.update(frame, sharpness);
};

test('ne relance pas l’OCR sur la carte déjà identifiée', () => {
  const clock = { value: 0 };
  const watcher = new FrameWatcher({ now: () => clock.value });
  const frame = striped();

  assert.equal(settle(watcher, frame, clock).shouldScan, true);
  watcher.accept(frame);

  clock.value += 200;
  assert.equal(watcher.update(frame, 0.5).shouldScan, false);
});

test('repart au quart de tour quand une autre carte entre dans le cadre', () => {
  const clock = { value: 0 };
  const watcher = new FrameWatcher({ now: () => clock.value });
  const first = striped();

  settle(watcher, first, clock);
  watcher.accept(first);

  // La main passe : l'image bouge.
  const moving = watcher.update(flat(0), 0.5);
  assert.equal(moving.state, 'moving');
  assert.ok(meanAbsDiff(first, flat(0)) > MOTION_THRESHOLD);

  // Une autre carte se pose : nouveau scan sans intervention.
  const second = striped(1);
  assert.equal(settle(watcher, second, clock).shouldScan, true);
});

test('ignore un cadre vide ou flou', () => {
  const clock = { value: 0 };
  const watcher = new FrameWatcher({ now: () => clock.value });
  const blank = flat(128);

  const result = settle(watcher, blank, clock, 0);
  assert.equal(result.state, 'idle');
  assert.equal(result.shouldScan, false);
});
