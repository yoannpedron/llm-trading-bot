import test from 'node:test';
import assert from 'node:assert/strict';

import {
  binarize,
  darkRatio,
  sharpness,
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

test('la netteté distingue le net du flou, et résiste au bruit', () => {
  const flouter = (source, rayon) => {
    const out = new Uint8ClampedArray(source.length);
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        let somme = 0;
        let n = 0;
        for (let dy = -rayon; dy <= rayon; dy += 1) {
          for (let dx = -rayon; dx <= rayon; dx += 1) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy < 0 || yy >= HEIGHT || xx < 0 || xx >= WIDTH) continue;
            somme += source[yy * WIDTH + xx];
            n += 1;
          }
        }
        out[y * WIDTH + x] = somme / n;
      }
    }
    return out;
  };

  // Bruit déterministe : le test ne doit pas dépendre du tirage.
  const bruiter = (source, amplitude) => {
    const out = new Uint8ClampedArray(source.length);
    let graine = 1;
    for (let i = 0; i < source.length; i += 1) {
      graine = (graine * 1103515245 + 12345) % 2147483648;
      out[i] = source[i] + (graine / 2147483648 - 0.5) * amplitude;
    }
    return out;
  };

  const mesure = (image) => sharpness(image, WIDTH, HEIGHT);

  const net = texte();
  const netBruite = bruiter(net, 30);
  const flou = flouter(net, 2);
  const flouBruite = bruiter(flou, 30);

  // Le flou fait chuter la note.
  assert.ok(mesure(net) > mesure(flou) * 3, `${mesure(net)} vs ${mesure(flou)}`);

  // Et surtout : le bruit ne la gonfle pas. C'est tout l'intérêt du seuil —
  // une simple énergie de gradient classerait « flou + bruit » au-dessus de
  // « net », et un garde-fou de netteté rejetterait alors les bonnes images.
  assert.ok(
    mesure(netBruite) > mesure(flouBruite) * 3,
    `net+bruit ${mesure(netBruite)} doit dominer flou+bruit ${mesure(flouBruite)}`,
  );
  assert.ok(Math.abs(mesure(net) - mesure(netBruite)) / mesure(net) < 0.2, 'le bruit seul déplace peu la note');

  // Un aplat n'a aucun contour ; une image minuscule ne fait pas planter.
  assert.equal(mesure(new Uint8ClampedArray(WIDTH * HEIGHT).fill(128)), 0);
  assert.equal(sharpness(new Uint8ClampedArray(4), 2, 2), 0);
});
