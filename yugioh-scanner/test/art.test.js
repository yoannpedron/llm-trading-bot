import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CADRE_ART,
  CARTE_HAUTEUR,
  CARTE_LARGEUR,
  CARTE_RATIO,
  TAILLE_EMPREINTE,
  chercher,
  construireIndexArt,
  masquerCartes,
  empreinte,
  empreinteDct,
  lireIndexArt,
  reduire,
  serialiserIndexArt,
  similarite,
  vignette,
  zoneArt,
} from '../src/lib/art.js';

/** Une « illustration » synthétique : dégradé + disque, en RGBA. */
function image(largeur, hauteur, { decalage = 0, gain = 1, bruit = 0, graine = 1 } = {}) {
  const data = new Uint8ClampedArray(largeur * hauteur * 4);
  let g = graine;
  const alea = () => {
    g = (g * 1103515245 + 12345) % 2147483648;
    return g / 2147483648;
  };
  for (let y = 0; y < hauteur; y += 1) {
    for (let x = 0; x < largeur; x += 1) {
      const i = (y * largeur + x) * 4;
      const disque = Math.hypot(x - largeur * 0.6, y - hauteur * 0.4) < largeur * 0.2 ? 90 : 0;
      const base = (x / largeur) * 120 + (y / hauteur) * 60 + disque;
      const v = Math.max(0, Math.min(255, base * gain + decalage + (alea() - 0.5) * bruit));
      data[i] = v;
      data[i + 1] = v * 0.8;
      data[i + 2] = 255 - v * 0.5;
      data[i + 3] = 255;
    }
  }
  return { data, width: largeur, height: hauteur };
}

test('les proportions de la carte et le cadre de l’illustration sont ceux d’une carte réelle', () => {
  assert.ok(Math.abs(CARTE_RATIO - 59 / 86) < 1e-9);
  assert.ok(Math.abs(CARTE_LARGEUR / CARTE_HAUTEUR - CARTE_RATIO) < 0.01);
  // Le cadre standard est presque carré (relevé sur les visuels officiels).
  const carre = (CADRE_ART.standard.w * CARTE_LARGEUR) / (CADRE_ART.standard.h * CARTE_HAUTEUR);
  assert.ok(carre > 0.95 && carre < 1.05, `cadre ${carre}`);
  const z = zoneArt('standard');
  assert.ok(z.x > 0 && z.y > 0 && z.x + z.width < CARTE_LARGEUR && z.y + z.height < CARTE_HAUTEUR);
});

test('la réduction par moyenne de zone conserve la moyenne', () => {
  const pixels = new Uint8ClampedArray(40 * 30).map((_, i) => i % 256);
  const petite = reduire(pixels, 40, 30, 4, 3);
  const moyenne = (t) => t.reduce((s, v) => s + v, 0) / t.length;
  assert.ok(Math.abs(moyenne(pixels) - moyenne(petite)) < 1);
  assert.equal(petite.length, 12);
});

test('l’empreinte est déterministe, de taille fixe, et insensible à la luminosité', () => {
  const a = empreinte(image(150, 150));
  const b = empreinte(image(150, 150));
  assert.equal(a.length, TAILLE_EMPREINTE);
  assert.deepEqual(a, b);

  // Même image, plus sombre et moins contrastée : la vignette et la DCT
  // ne doivent presque pas bouger (elles sont centrées-réduites).
  const sombre = empreinte(image(150, 150, { decalage: -40, gain: 0.7 }));
  assert.ok(similarite(a, sombre) > 0.9, `similarité ${similarite(a, sombre)}`);

  // La vignette d'une image plate n'explose pas (écart-type nul).
  const plate = vignette(new Uint8ClampedArray(64 * 64).fill(77), 64, 64);
  assert.ok(plate.every((v) => v === 128));
});

test('la similarité distingue une image de sa voisine bruitée et d’une autre', () => {
  const a = empreinte(image(150, 150));
  const bruitee = empreinte(image(150, 150, { bruit: 40, graine: 9 }));
  const autre = empreinte(image(150, 150, { gain: -1, decalage: 255 })); // inversée
  assert.ok(similarite(a, a) > 0.999);
  assert.ok(similarite(a, bruitee) > 0.85, `bruitée ${similarite(a, bruitee)}`);
  assert.ok(similarite(a, autre) < similarite(a, bruitee));
  assert.ok(similarite(a, autre) >= 0 && similarite(a, autre) <= 1);
});

test('l’empreinte DCT tient sur 64 bits et change avec la structure', () => {
  const disque = new Uint8ClampedArray(64 * 64).map((_, i) => (Math.hypot((i % 64) - 32, Math.floor(i / 64) - 32) < 16 ? 220 : 30));
  const rayures = new Uint8ClampedArray(64 * 64).map((_, i) => (Math.floor((i % 64) / 8) % 2 ? 220 : 30));
  const h1 = empreinteDct(disque, 64, 64);
  const h2 = empreinteDct(rayures, 64, 64);
  assert.equal(h1.length, 8);
  let hamming = 0;
  for (let i = 0; i < 8; i += 1) hamming += (h1[i] ^ h2[i]).toString(2).replace(/0/g, '').length;
  assert.ok(hamming > 10, `Hamming ${hamming}`);
  assert.deepEqual(empreinteDct(disque, 64, 64), h1);
});

test('l’index se sérialise et se relit à l’identique, et la recherche retrouve la carte', () => {
  const entrees = [1, 2, 3, 4, 5].map((n) => ({ id: 1000 + n, empreinte: empreinte(image(120, 120, { graine: n, bruit: 200 })) }));
  const index = construireIndexArt(entrees);
  const octets = serialiserIndexArt(index);
  const relu = lireIndexArt(octets.buffer.slice(octets.byteOffset, octets.byteOffset + octets.byteLength));
  assert.equal(relu.taille, 5);
  assert.deepEqual(Array.from(relu.ids), [1001, 1002, 1003, 1004, 1005]);
  assert.deepEqual(relu.empreintes, index.empreintes);

  const requete = empreinte(image(120, 120, { graine: 3, bruit: 200, decalage: 10 }));
  const resultats = chercher(relu, requete, 3, undefined, 0);
  assert.equal(resultats[0].id, 1003);
  assert.ok(resultats[0].score > resultats[1].score);
});

test('une carte présente plusieurs fois dans l’index ne sort qu’une fois', () => {
  const e = empreinte(image(100, 100));
  const index = construireIndexArt([
    { id: 7, empreinte: e },
    { id: 7, empreinte: empreinte(image(100, 100, { bruit: 30 })) },
    { id: 8, empreinte: empreinte(image(100, 100, { gain: -1, decalage: 255 })) },
  ]);
  const r = chercher(index, e, 5, undefined, 0);
  assert.deepEqual(r.map((x) => x.id), [7, 8]);
});

test('une carte masquée ne sort plus de la recherche, avec ou sans présélection', () => {
  const entrees = [1, 2, 3, 4, 5].map((n) => ({ id: 1000 + n, empreinte: empreinte(image(120, 120, { graine: n, bruit: 200 })) }));
  const index = construireIndexArt(entrees);
  const requete = empreinte(image(120, 120, { graine: 3, bruit: 200, decalage: 10 }));
  assert.equal(chercher(index, requete, 3, undefined, 0)[0].id, 1003);

  const masque = masquerCartes(index, [1003]);
  assert.equal(masque.taille, 5);
  assert.deepEqual(Array.from(index.ids), [1001, 1002, 1003, 1004, 1005], 'l’index d’origine est intact');
  for (const preselection of [0, 2]) {
    const r = chercher(masque, requete, 5, undefined, preselection);
    assert.ok(r.length > 0);
    assert.ok(r.every((x) => x.id !== 1003 && x.id > 0), `présélection ${preselection}`);
  }
});
