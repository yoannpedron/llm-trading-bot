import test from 'node:test';
import assert from 'node:assert/strict';

import {
  binarize,
  darkRatio,
  integralImages,
  invert,
  otsuThreshold,
  preprocessGray,
  preprocessVariants,
  sauvolaThreshold,
  stretchContrast,
  toGrayscale,
} from '../src/lib/preprocess.js';

const WIDTH = 60;
const HEIGHT = 20;

/**
 * Fabrique une image en niveaux de gris : fond `background`, barres verticales
 * de largeur 2 en `ink` tous les 6 pixels. `gradient` ajoute un dégradé de
 * gauche à droite pour simuler un éclairage inégal.
 */
function texte({ background = 220, ink = 40, gradient = 0 } = {}) {
  const pixels = new Uint8ClampedArray(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const isInk = y > 3 && y < HEIGHT - 4 && x % 6 < 2;
      const lift = (gradient * x) / WIDTH;
      pixels[y * WIDTH + x] = Math.min(255, (isInk ? ink : background) + lift);
    }
  }
  return pixels;
}

/** Proportion de pixels correctement classés par rapport à la vérité terrain. */
function accuracy(result, truth) {
  let good = 0;
  for (let i = 0; i < result.length; i += 1) if (result[i] === truth[i]) good += 1;
  return good / result.length;
}

const truth = binarize(texte(), 128);

test('la luma pondère selon la perception', () => {
  const luma = (r, g, b) =>
    toGrayscale({ data: new Uint8ClampedArray([r, g, b, 255]), width: 1, height: 1 })[0];

  // Rec. 601 : 29,9 % rouge, 58,7 % vert, 11,4 % bleu.
  assert.equal(luma(255, 0, 0), 76);
  assert.equal(luma(0, 255, 0), 150);
  assert.equal(luma(0, 0, 255), 29);
  // Un vert pur ressort donc bien plus clair qu'un bleu pur, à intensité égale.
  assert.ok(luma(0, 255, 0) > luma(0, 0, 255) * 5);
});

test('l’étirement de contraste ignore les valeurs extrêmes isolées', () => {
  // Deux populations serrées — encre à 90, fond à 150 — plus quatre pixels
  // parasites : une ombre à 0 et un reflet à 255.
  const pixels = new Uint8ClampedArray(1000).fill(150);
  pixels.fill(90, 0, 400);
  pixels[998] = 0;
  pixels[999] = 255;

  const stretched = stretchContrast(pixels, 0.02);
  // Après écrêtage, les deux populations occupent toute la plage.
  assert.equal(stretched[0], 0);
  assert.equal(stretched[500], 255);

  // Sans écrêtage, les quatre parasites suffisent à tout figer.
  const naive = stretchContrast(pixels, 0);
  assert.equal(naive[0], 90);
  assert.equal(naive[500], 150);
});

test('une image plate ne provoque pas de division par zéro', () => {
  const flat = new Uint8ClampedArray(100).fill(77);
  const stretched = stretchContrast(flat);
  assert.ok(stretched.every((value) => value === 77));
});

test('le seuil d’Otsu sépare exactement l’encre du fond', () => {
  const gray = texte();
  const threshold = otsuThreshold(gray);

  // Sur un histogramme franchement bimodal, tout seuil de l'intervalle vaut :
  // ce qui compte est que la binarisation retrouve l'image d'origine.
  assert.ok(threshold >= 40 && threshold < 220, `seuil ${threshold}`);
  assert.deepEqual(binarize(gray, threshold), truth);
});

test('l’auto-inversion remet le texte en noir sur blanc', () => {
  // Texte clair sur fond sombre : majorité de pixels noirs après binarisation.
  const inverse = texte({ background: 30, ink: 230 });
  const { pixels, inverted } = preprocessGray(inverse);
  assert.equal(inverted, true);
  assert.ok(darkRatio(pixels) < 0.5);
});

test('les images intégrales donnent la bonne somme de fenêtre', () => {
  const gray = Uint8ClampedArray.from({ length: 9 }, (_, i) => i + 1); // 1..9, 3x3
  const { sum, squares, stride } = integralImages(gray, 3, 3);
  // Somme du carré complet : 1+2+...+9 = 45
  assert.equal(sum[3 * stride + 3], 45);
  assert.equal(squares[3 * stride + 3], 285); // 1+4+9+...+81
  // Sous-rectangle en haut à gauche (1,2,4,5) = 12
  assert.equal(sum[2 * stride + 2], 12);
});

test('Sauvola sépare le texte aussi bien qu’Otsu en éclairage uniforme', () => {
  const local = sauvolaThreshold(texte(), WIDTH, HEIGHT);
  assert.ok(accuracy(local, truth) > 0.9);
});

test('sous éclairage inégal, Sauvola tient là où Otsu lâche', () => {
  // Dégradé de 160 niveaux : la droite de l'image est bien plus claire.
  const uneven = texte({ gradient: 160 });

  const global = preprocessGray(uneven, { autoInvert: false }).pixels;
  const local = sauvolaThreshold(uneven, WIDTH, HEIGHT);

  assert.ok(accuracy(local, truth) > 0.9, `Sauvola ${accuracy(local, truth)}`);
  assert.ok(
    accuracy(local, truth) > accuracy(global, truth),
    `Sauvola ${accuracy(local, truth)} doit dépasser Otsu ${accuracy(global, truth)}`,
  );
});

test('les variantes couvrent les deux polarités, sans doublon', () => {
  const variants = preprocessVariants(texte(), WIDTH, HEIGHT);
  assert.deepEqual(
    variants.map((entry) => entry.label),
    ['otsu', 'sauvola', 'otsu-inverse', 'sauvola-inverse'],
  );
  // Une variante et son inverse ne peuvent pas être identiques.
  assert.notDeepEqual(variants[0].pixels, variants[2].pixels);
  assert.deepEqual(invert(variants[0].pixels), variants[2].pixels);
});
