/**
 * Lire le code de tirage sur la carte, dans l'image où elle a été reconnue.
 *
 * On redresse la carte en haute résolution (813×1185, la définition des
 * visuels officiels) depuis ses coins, on découpe la bande du code, on
 * l'agrandit deux fois et on la donne au moteur OCR (`ocr.js`, PP-OCRv6),
 * puis `apparierTirage` la rapproche des codes de la carte.
 *
 * Le moteur OCR pèse 31 Mo : il ne se charge qu'à la première lecture, pas au
 * démarrage — l'identification par illustration n'en a pas besoin. Une carte
 * à tirage unique ne déclenche rien.
 */

import { recognize } from './ocr.js';
import { redresser } from './quad.js';
import { BANDE_CODE, apparierTirage, assezGrande } from './tirage.js';

const LARGEUR = 813;
const HAUTEUR = 1185;
/** Hauteur visée de la bande donnée au moteur : mesuré, il lit mieux vers 80 px de haut (100 : pareil). */
const HAUTEUR_BANDE = 80;
/**
 * Étirer le contraste de la bande avant lecture. Mesuré sur 216 bandes
 * rendues : 84 % de tirages justes contre 71 % sans, toujours 0 faux ; le
 * gain est surtout sur les petites cartes et les images floues.
 */
const CONTRASTE = true;
/**
 * Si la bande étirée ne donne pas de lecture exacte, lire aussi la bande
 * telle quelle et garder la meilleure. Mesuré : lectures exactes de 81 à
 * 87 % des bandes (une image suffit alors, au lieu de deux d'accord), pour
 * une seconde passe du moteur dans un quart des cas.
 */
const SECONDE_LECTURE = true;

/**
 * @param {ImageData} image l'image native où la carte a été reconnue
 * @param {Array<{x:number,y:number}>} coins de la carte, dans le repère de `image`
 * @param {Array<{setCode: string}>} printings tirages de la carte identifiée
 * @returns {Promise<{tirage: object|null, lecture: string, similarite: number, avance: number,
 *   raison: string|null, ms: number}>}
 */
export async function lireTirage(image, coins, printings, { bande = BANDE_CODE, hauteurBande = HAUTEUR_BANDE, contraste = CONTRASTE, secondeLecture = SECONDE_LECTURE } = {}) {
  const t0 = performance.now();
  const fini = (resultat, raison = null) => ({ ...resultat, raison, ms: Math.round(performance.now() - t0) });
  const distincts = new Set((printings ?? []).map((p) => p.setCode));
  if (distincts.size < 2) return fini({ tirage: printings?.[0] ?? null, lecture: '', similarite: 0, avance: 0 }, 'tirage unique');
  if (!assezGrande(coins, image.height)) return fini({ tirage: null, lecture: '', similarite: 0, avance: 0 }, 'carte trop petite');

  const carte = redresser(image, coins, LARGEUR, HAUTEUR);
  const x = Math.round(bande.x0 * LARGEUR);
  const y = Math.round(bande.y0 * HAUTEUR);
  const w = Math.round((bande.x1 - bande.x0) * LARGEUR);
  const h = Math.round((bande.y1 - bande.y0) * HAUTEUR);

  const source = new OffscreenCanvas(LARGEUR, HAUTEUR);
  source.getContext('2d').putImageData(new ImageData(carte.data, carte.width, carte.height), 0, 0);
  const zoom = Math.max(2, Math.round(hauteurBande / h));
  const lireBande = async (etirer) => {
    const vue = new OffscreenCanvas(w * zoom, h * zoom);
    const bx = vue.getContext('2d');
    bx.imageSmoothingQuality = 'high';
    bx.drawImage(source, x, y, w, h, 0, 0, w * zoom, h * zoom);
    if (etirer) etirerContraste(bx, vue.width, vue.height);
    const { text } = await recognize(vue);
    return { ...apparierTirage(text, printings), brut: text };
  };

  // La bande au contraste étiré d'abord ; si la lecture n'est pas exacte,
  // la bande telle quelle aussi, et l'on garde la meilleure des deux.
  let appariement = await lireBande(contraste);
  if (!appariement.exact && contraste && secondeLecture) {
    const brute = await lireBande(false);
    if (brute.exact || (!appariement.tirage && brute.tirage) || (Boolean(brute.tirage) === Boolean(appariement.tirage) && brute.similarite > appariement.similarite)) appariement = brute;
  }
  return fini(
    { tirage: appariement.tirage, exact: appariement.exact, ambigu: appariement.ambigu, lecture: appariement.lecture, brut: appariement.brut, similarite: appariement.similarite, avance: appariement.avance },
    appariement.tirage ? null : 'code illisible',
  );
}

/**
 * Étire le contraste de la bande (2e et 98e centiles → 0 et 255), en gris.
 * Le code est une encre sombre sur un cadre clair ; sous une lampe ou dans
 * l'ombre, la bande est terne et le moteur hésite.
 */
function etirerContraste(cx, largeur, hauteur) {
  const img = cx.getImageData(0, 0, largeur, hauteur);
  const d = img.data;
  const histo = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = g;
    histo[Math.round(g)] += 1;
  }
  const total = d.length / 4;
  let bas = 0;
  let cumul = 0;
  while (bas < 255 && cumul + histo[bas] < total * 0.02) cumul += histo[bas++];
  let haut = 255;
  cumul = 0;
  while (haut > 0 && cumul + histo[haut] < total * 0.02) cumul += histo[haut--];
  const etendue = Math.max(1, haut - bas);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - bas) * 255) / etendue));
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
  }
  cx.putImageData(img, 0, 0);
}
