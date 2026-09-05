import test from 'node:test';
import assert from 'node:assert/strict';

import { TAILLE_EMPREINTE, construireIndexArt } from '../src/lib/art.js';
import { BANDES_ORIENTATION, COTE_ART, empreinteDepuisCoins, identifierCarte, indiceOrientation, orientationDepuisCoins } from '../src/lib/identifier.js';

/** Une carte synthétique dessinée dans une scène : liseré noir, cadre, illustration, zone de texte claire. */
function carteDansScene(largeur, hauteur, rect, { graine = 3, fond = 90 } = {}) {
  const data = new Uint8ClampedArray(largeur * hauteur * 4);
  let g = graine;
  const alea = () => {
    g = (g * 1103515245 + 12345) % 2147483648;
    return g / 2147483648;
  };
  // Illustration : un motif pseudo-aléatoire figé par la graine, 8×8 cellules.
  const cellules = Array.from({ length: 64 }, () => Math.round(alea() * 255));
  for (let y = 0; y < hauteur; y += 1) {
    for (let x = 0; x < largeur; x += 1) {
      const u = (x - rect.x) / rect.w;
      const v = (y - rect.y) / rect.h;
      let val = fond;
      let r = fond;
      let b = fond;
      if (u >= 0 && u < 1 && v >= 0 && v < 1) {
        if (u < 0.027 || u > 0.973 || v < 0.0185 || v > 0.9815) val = 8; // liseré
        else if (u > 0.096 && u < 0.904 && v > 0.166 && v < 0.723) {
          const c = cellules[Math.floor((v - 0.166) / 0.557 * 8) * 8 + Math.floor((u - 0.096) / 0.808 * 8)];
          val = c;
          r = 255 - c;
          b = c / 2;
        } else if (v > 0.75 && v < 0.92 && u > 0.08 && u < 0.92) val = 235; // zone de texte, claire
        else val = 150; // cadre
        if (val !== 8 && !(u > 0.096 && u < 0.904 && v > 0.166 && v < 0.723)) {
          r = val;
          b = val;
        }
      }
      const i = (y * largeur + x) * 4;
      data[i] = r;
      data[i + 1] = val;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width: largeur, height: hauteur };
}

const coinsDe = (rect) => [
  { x: rect.x, y: rect.y },
  { x: rect.x + rect.w, y: rect.y },
  { x: rect.x + rect.w, y: rect.y + rect.h },
  { x: rect.x, y: rect.y + rect.h },
];

function reduite(img, largeur) {
  const facteur = img.width / largeur;
  const hauteur = Math.round(img.height / facteur);
  const data = new Uint8ClampedArray(largeur * hauteur * 4);
  for (let y = 0; y < hauteur; y += 1) {
    for (let x = 0; x < largeur; x += 1) {
      const sx = Math.min(img.width - 1, Math.round(x * facteur));
      const sy = Math.min(img.height - 1, Math.round(y * facteur));
      const s = (sy * img.width + sx) * 4;
      const d = (y * largeur + x) * 4;
      data[d] = img.data[s];
      data[d + 1] = img.data[s + 1];
      data[d + 2] = img.data[s + 2];
      data[d + 3] = 255;
    }
  }
  return { data, width: largeur, height: hauteur };
}

test('l’empreinte depuis les coins a la bonne taille et ne dépend pas du cadrage global', () => {
  const rect = { x: 120, y: 160, w: 268, h: 391 };
  const img = carteDansScene(560, 760, rect);
  const e = empreinteDepuisCoins(img, coinsDe(rect));
  assert.equal(e.length, TAILLE_EMPREINTE);
  assert.ok(COTE_ART >= 64);
  // Une carte à l'envers dans l'image, lue avec `demiTour`, donne la même empreinte.
  const coinsInverses = coinsDe(rect);
  const tournee = empreinteDepuisCoins(img, [coinsInverses[2], coinsInverses[3], coinsInverses[0], coinsInverses[1]], { demiTour: true });
  let ecart = 0;
  for (let i = 8; i < 8 + 256; i += 1) ecart += Math.abs(e[i] - tournee[i]);
  assert.ok(ecart / 256 < 6, `écart moyen ${ecart / 256}`);
});

test('l’indice d’orientation est positif pour une carte à l’endroit, négatif à l’envers', () => {
  const rect = { x: 100, y: 120, w: 268, h: 391 };
  const img = carteDansScene(500, 640, rect);
  const droite = orientationDepuisCoins(img, coinsDe(rect));
  const c = coinsDe(rect);
  const envers = orientationDepuisCoins(img, [c[2], c[3], c[0], c[1]]);
  assert.ok(droite > 15, `à l'endroit ${droite}`);
  assert.ok(envers < -15, `à l'envers ${envers}`);
  assert.ok(BANDES_ORIENTATION[0][0] > 0.7, 'la zone de texte est en bas');
  const gris = new Uint8ClampedArray(48 * 70).fill(100);
  assert.equal(indiceOrientation(gris, 48, 70), 0);
});

test('identifierCarte retrouve la carte, ses coins et son sens dans une scène synthétique', () => {
  const rect = { x: 300, y: 500, w: 420, h: 612 };
  const img = carteDansScene(1080, 1920, rect, { graine: 5 });
  const autre = carteDansScene(600, 800, { x: 50, y: 60, w: 268, h: 391 }, { graine: 11 });
  // L'index : la vraie carte (empreinte de référence) et une autre.
  const reference = empreinteDepuisCoins(carteDansScene(400, 500, { x: 20, y: 30, w: 268, h: 391 }, { graine: 5 }), coinsDe({ x: 20, y: 30, w: 268, h: 391 }));
  const index = construireIndexArt([
    { id: 55, empreinte: reference },
    { id: 66, empreinte: empreinteDepuisCoins(autre, coinsDe({ x: 50, y: 60, w: 268, h: 391 })) },
  ]);
  const r = identifierCarte(img, reduite(img, 448), index);
  assert.equal(r.candidats[0]?.id, 55);
  assert.equal(r.sens, 'droite');
  const attendu = coinsDe(rect);
  const erreur = Math.max(...r.quad.map((p, i) => Math.hypot(p.x - attendu[i].x, p.y - attendu[i].y)));
  assert.ok(erreur < 20, `erreur de coin ${erreur} px`);
  assert.ok(r.ms.total >= 0 && r.evaluees > 0);
});
