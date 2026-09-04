/**
 * Page du banc de lecture : le VRAI moteur de l'application, servi par Vite.
 *
 * `scripts/ocr-bench.mjs` la pilote avec Playwright. Elle expose sur `window`
 * ce dont le banc a besoin, et rien de plus : le moteur, la résolution, et un
 * générateur d'images bruitées qui imite ce qui change d'une image de viseur
 * à la suivante.
 */
import { buildSearchIndex, resolveSetCode } from '../../../src/lib/match.js';
import { moteur, recognize, warmUp } from '../../../src/lib/ocr.js';

window.__pret = warmUp().then(() => moteur());

const depuisBase64 = async (b64) => {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  return img;
};

const surCanvas = (source, largeur, hauteur) => {
  const canvas = document.createElement('canvas');
  canvas.width = largeur;
  canvas.height = hauteur;
  const contexte = canvas.getContext('2d', { willReadFrequently: true });
  return { canvas, contexte };
};

let index = null;
window.__index = (cartes) => {
  index = buildSearchIndex(cartes);
  return index.byCode.size;
};

/** Lit une image et la résout, comme la boucle du viseur. */
window.__lire = async (b64) => {
  const img = await depuisBase64(b64);
  const { canvas, contexte } = surCanvas(img, img.naturalWidth, img.naturalHeight);
  contexte.drawImage(img, 0, 0);
  const { text, ms } = await recognize(canvas);
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return { text: trimmed, ms, resolu: resolveSetCode(index, trimmed) };
};

/**
 * Images successives simulées : tremblement sous le pixel, mise au point qui
 * respire, grain neuf à chaque image. Générateur déterministe.
 */
window.__bruiter = async (b64, images) => {
  const img = await depuisBase64(b64);
  const L = img.naturalWidth;
  const H = img.naturalHeight;
  let graine = 12345;
  const alea = () => {
    graine = (graine * 1103515245 + 12345) % 2147483648;
    return graine / 2147483648;
  };
  const sortie = [];
  for (let n = 0; n < images; n += 1) {
    const { canvas, contexte } = surCanvas(img, L, H);
    const dx = (alea() - 0.5) * 3;
    const dy = (alea() - 0.5) * 2;
    const flou = n === 0 ? 0 : alea() * 0.7;
    contexte.filter = flou > 0.05 ? `blur(${flou.toFixed(2)}px)` : 'none';
    contexte.drawImage(img, dx, dy, L, H);
    contexte.filter = 'none';
    const donnees = contexte.getImageData(0, 0, L, H);
    const amplitude = 10 + alea() * 14;
    for (let i = 0; i < donnees.data.length; i += 4) {
      const bruit = (alea() - 0.5) * amplitude;
      donnees.data[i] += bruit;
      donnees.data[i + 1] += bruit;
      donnees.data[i + 2] += bruit;
    }
    contexte.putImageData(donnees, 0, 0);
    sortie.push(canvas.toDataURL('image/png').split(',')[1]);
  }
  return sortie;
};
