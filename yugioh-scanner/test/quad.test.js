import test from 'node:test';
import assert from 'node:assert/strict';

import { CARTE_RATIO } from '../src/lib/art.js';
import {
  affiner,
  aire,
  carteDepuisArt,
  convexe,
  deformer,
  dilater,
  droitesHough,
  homographie,
  intersection,
  ordonner,
  projeter,
  redresser,
  sobel,
  trouverQuad,
} from '../src/lib/quad.js';

const carre = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

/** Une scène : fond uni, rectangle clair à liseré sombre, en RGBA. */
function scene(largeur, hauteur, rect, { fond = 60, liseré = 10, interieur = 200 } = {}) {
  const data = new Uint8ClampedArray(largeur * hauteur * 4);
  for (let y = 0; y < hauteur; y += 1) {
    for (let x = 0; x < largeur; x += 1) {
      const dedans = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const bord = dedans && (x < rect.x + rect.b || x >= rect.x + rect.w - rect.b || y < rect.y + rect.b || y >= rect.y + rect.h - rect.b);
      // Un peu de « dessin » à l'intérieur, pour que la carte ne soit pas plate.
      const motif = dedans && !bord && (x + y) % 9 < 3 ? 60 : 0;
      const v = bord ? liseré : dedans ? interieur - motif : fond;
      const i = (y * largeur + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width: largeur, height: hauteur };
}

test('l’homographie envoie exactement les quatre points, et l’inverse revient', () => {
  const cible = [
    { x: 10, y: 10 },
    { x: 30, y: 12 },
    { x: 28, y: 40 },
    { x: 8, y: 38 },
  ];
  const h = homographie(carre, cible);
  cible.forEach((p, i) => {
    const q = projeter(h, carre[i]);
    assert.ok(Math.hypot(q.x - p.x, q.y - p.y) < 1e-9);
  });
  const retour = homographie(cible, carre);
  const p = projeter(retour, projeter(h, { x: 0.3, y: 0.7 }));
  assert.ok(Math.hypot(p.x - 0.3, p.y - 0.7) < 1e-9);
  assert.throws(() => homographie(carre, [cible[0], cible[0], cible[0], cible[0]]), /dégénérés/);
});

test('ordonner rend haut-gauche, haut-droit, bas-droit, bas-gauche, en portrait', () => {
  const melange = [
    { x: 28, y: 40 },
    { x: 10, y: 10 },
    { x: 8, y: 38 },
    { x: 30, y: 12 },
  ];
  assert.deepEqual(ordonner(melange), [
    { x: 10, y: 10 },
    { x: 30, y: 12 },
    { x: 28, y: 40 },
    { x: 8, y: 38 },
  ]);
  // Une carte en paysage est ramenée en portrait : le petit côté en haut.
  const paysage = ordonner([
    { x: 0, y: 0 },
    { x: 86, y: 0 },
    { x: 86, y: 59 },
    { x: 0, y: 59 },
  ]);
  const haut = Math.hypot(paysage[1].x - paysage[0].x, paysage[1].y - paysage[0].y);
  const gauche = Math.hypot(paysage[3].x - paysage[0].x, paysage[3].y - paysage[0].y);
  assert.ok(haut < gauche);
});

test('convexité, aire et intersection de droites', () => {
  assert.equal(convexe(carre), true);
  assert.equal(convexe([carre[0], carre[2], carre[1], carre[3]]), false);
  assert.equal(aire(carre), 1);
  const p = intersection({ theta: 0, rho: 5 }, { theta: Math.PI / 2, rho: 7 });
  assert.ok(Math.abs(p.x - 5) < 1e-9 && Math.abs(p.y - 7) < 1e-9);
  assert.equal(intersection({ theta: 0, rho: 1 }, { theta: 0, rho: 2 }), null);
});

test('dilater écarte chaque côté de la largeur demandée, sur les quatre côtés', () => {
  const rect = [
    { x: 100, y: 100 },
    { x: 200, y: 100 },
    { x: 200, y: 246 },
    { x: 100, y: 246 },
  ];
  const d = dilater(rect, 0.02); // 2 % de 100 px = 2 px
  assert.ok(Math.abs(d[0].x - 98) < 0.01 && Math.abs(d[0].y - 98) < 0.01);
  assert.ok(Math.abs(d[2].x - 202) < 0.01 && Math.abs(d[2].y - 248) < 0.01);
  const c = dilater(rect, -0.02);
  assert.ok(Math.abs(c[0].x - 102) < 0.01);
});

test('carteDepuisArt reconstruit les coins de la carte depuis ceux de son cadre', () => {
  // Une carte de 268×391 posée en (50, 80) : son cadre standard, puis retour.
  const L = 268;
  const H = 391;
  const { x, y, w, h } = { x: 0.096, y: 0.166, w: 0.808, h: 0.557 };
  const cadre = [
    { x: 50 + x * L, y: 80 + y * H },
    { x: 50 + (x + w) * L, y: 80 + y * H },
    { x: 50 + (x + w) * L, y: 80 + (y + h) * H },
    { x: 50 + x * L, y: 80 + (y + h) * H },
  ];
  const [carte] = carteDepuisArt(cadre);
  assert.ok(Math.hypot(carte[0].x - 50, carte[0].y - 80) < 0.5);
  assert.ok(Math.hypot(carte[2].x - (50 + L), carte[2].y - (80 + H)) < 0.5);
});

test('deformer et redresser rééchantillonnent à travers l’homographie', () => {
  const src = scene(60, 80, { x: 10, y: 10, w: 40, h: 60, b: 0 }, { fond: 0, interieur: 255 });
  const coins = [
    { x: 10, y: 10 },
    { x: 49, y: 10 },
    { x: 49, y: 69 },
    { x: 10, y: 69 },
  ];
  const carte = redresser(src, coins, 20, 30);
  assert.equal(carte.width, 20);
  assert.equal(carte.height, 30);
  // L'intérieur du rectangle est clair (blanc à motif) : la carte redressée
  // l'est aussi, partout — un décalage d'homographie ramènerait du fond noir.
  for (const [x, y] of [[10, 15], [1, 1], [18, 28], [1, 28], [18, 1]]) {
    assert.ok(carte.data[(y * 20 + x) * 4] >= 190, `pixel (${x}, ${y}) = ${carte.data[(y * 20 + x) * 4]}`);
  }
  const h = homographie(carre, coins);
  const hors = deformer(src, homographie([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], [{ x: -5, y: -5 }, { x: -4, y: -5 }, { x: -4, y: -4 }, { x: -5, y: -4 }]), 2, 2);
  assert.equal(hors.data[0], 0);
  assert.ok(h.length === 9);
});

test('les droites de Hough retrouvent les quatre bords d’un rectangle', () => {
  const img = scene(200, 260, { x: 40, y: 50, w: 100, h: 146, b: 3 });
  const gray = new Uint8ClampedArray(200 * 260).map((_, i) => img.data[i * 4]);
  const { magnitude, orientation } = sobel(gray, 200, 260);
  const droites = droitesHough(magnitude, orientation, 200, 260, { n: 8 });
  const verticales = droites.filter((d) => Math.abs(Math.sin(d.theta)) < 0.1).map((d) => Math.abs(d.rho));
  const horizontales = droites.filter((d) => Math.abs(Math.cos(d.theta)) < 0.1).map((d) => Math.abs(d.rho));
  const proche = (liste, v) => liste.some((r) => Math.abs(r - v) <= 3);
  assert.ok(proche(verticales, 40) && proche(verticales, 140), `verticales ${verticales}`);
  assert.ok(proche(horizontales, 50) && proche(horizontales, 196), `horizontales ${horizontales}`);
});

test('trouverQuad localise une carte au liseré sombre sur fond uni, aux proportions près', () => {
  const img = scene(240, 320, { x: 60, y: 70, w: 118, h: 172, b: 4 });
  const q = trouverQuad(img);
  assert.ok(q, 'un quadrilatère');
  const attendu = [
    { x: 60, y: 70 },
    { x: 177, y: 70 },
    { x: 177, y: 241 },
    { x: 60, y: 241 },
  ];
  const erreur = Math.max(...q.coins.map((p, i) => Math.hypot(p.x - attendu[i].x, p.y - attendu[i].y)));
  assert.ok(erreur < 8, `erreur ${erreur} px`);
  const ratio = 118 / 172;
  assert.ok(Math.abs(ratio - CARTE_RATIO) < 0.03);
});

test('affiner ramène des coins approximatifs sur le bord du liseré', () => {
  const img = scene(300, 400, { x: 80, y: 90, w: 130, h: 190, b: 4 });
  const approx = [
    { x: 84, y: 86 },
    { x: 206, y: 94 },
    { x: 213, y: 283 },
    { x: 77, y: 276 },
  ];
  const fins = affiner(img, approx, { bande: 0.06 });
  const attendu = [
    { x: 80, y: 90 },
    { x: 209, y: 90 },
    { x: 209, y: 279 },
    { x: 80, y: 279 },
  ];
  const erreur = Math.max(...fins.map((p, i) => Math.hypot(p.x - attendu[i].x, p.y - attendu[i].y)));
  assert.ok(erreur < 2.5, `erreur ${erreur} px : ${JSON.stringify(fins.map((p) => [Math.round(p.x), Math.round(p.y)]))}`);
});
