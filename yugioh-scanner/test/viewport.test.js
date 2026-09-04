import test from 'node:test';
import assert from 'node:assert/strict';

import { coverOffset, coverScale, reticleRect, toVideoRect } from '../src/lib/viewport.js';

const VIDEO = { width: 1920, height: 1080 }; // 16:9
const PHONE = { width: 390, height: 844 }; // portrait, bien plus étroit

test('cover retient le plus grand des deux rapports', () => {
  // En portrait, c'est la largeur qui contraint : 844/1080 dépasse 390/1920.
  assert.equal(coverScale(VIDEO, PHONE), 844 / 1080);
  // Sur un conteneur au même rapport que la vidéo, rien ne déborde.
  const same = { width: 960, height: 540 };
  assert.equal(coverScale(VIDEO, same), 0.5);
  assert.deepEqual(coverOffset(VIDEO, same), { x: 0, y: 0 });
});

test('le débordement est symétrique', () => {
  const offset = coverOffset(VIDEO, PHONE);
  // L'image agrandie est plus large que le téléphone : elle déborde à gauche
  // et à droite d'autant.
  assert.ok(offset.x > 0);
  assert.equal(offset.y, 0);
  assert.equal(offset.x, (1920 * (844 / 1080) - 390) / 2);
});

test('le centre du viseur tombe sur le centre de l’image', () => {
  const reticle = reticleRect(PHONE);
  const rect = toVideoRect(reticle, VIDEO, PHONE);
  assert.ok(Math.abs(rect.x + rect.width / 2 - VIDEO.width / 2) < 1e-6);
  assert.ok(Math.abs(rect.y + rect.height / 2 - VIDEO.height / 2) < 1e-6);
});

test('le rectangle converti garde son rapport', () => {
  const reticle = reticleRect(PHONE);
  const rect = toVideoRect(reticle, VIDEO, PHONE);
  assert.ok(Math.abs(rect.width / rect.height - reticle.width / reticle.height) < 1e-9);
});

test('le viseur est plus grand en pixels vidéo qu’à l’écran quand l’image est réduite', () => {
  // La vidéo 1920 de large est affichée sur 390 : le recadrage porte donc sur
  // bien plus de pixels que ce que mesure le viseur à l'écran. C'est ce qui
  // donne à l'OCR de la matière.
  const reticle = reticleRect(PHONE);
  const rect = toVideoRect(reticle, VIDEO, PHONE);
  assert.ok(rect.width > reticle.width * 1.2, `${rect.width} vs ${reticle.width}`);
});

test('un viseur qui déborde est ramené dans l’image', () => {
  const huge = { x: -500, y: -500, width: 5000, height: 5000 };
  const rect = toVideoRect(huge, VIDEO, PHONE);
  assert.ok(rect.x >= 0 && rect.y >= 0);
  assert.ok(rect.x + rect.width <= VIDEO.width + 1e-9);
  assert.ok(rect.y + rect.height <= VIDEO.height + 1e-9);
});

test('le viseur reste très allongé et borné en largeur', () => {
  const small = reticleRect({ width: 320, height: 640 });
  assert.ok(Math.abs(small.width / small.height - 6) < 1e-9);
  // Sur un grand écran, il ne s'étire pas indéfiniment.
  const large = reticleRect({ width: 1600, height: 900 });
  assert.equal(large.width, 420);
});
