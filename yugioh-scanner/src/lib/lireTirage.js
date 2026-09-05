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

import { recognize, warmUp } from './ocr.js';
import { redresser } from './quad.js';
import { BANDE_CODE, apparierTirage, assezGrande } from './tirage.js';

const LARGEUR = 813;
const HAUTEUR = 1185;
const ZOOM = 2;

/** Démarre le moteur OCR en avance (facultatif). */
export const preparerLecture = (onProgress) => warmUp(onProgress);

/**
 * @param {ImageData} image l'image native où la carte a été reconnue
 * @param {Array<{x:number,y:number}>} coins de la carte, dans le repère de `image`
 * @param {Array<{setCode: string}>} printings tirages de la carte identifiée
 * @returns {Promise<{tirage: object|null, lecture: string, similarite: number, avance: number,
 *   raison: string|null, ms: number}>}
 */
export async function lireTirage(image, coins, printings) {
  const t0 = performance.now();
  const fini = (resultat, raison = null) => ({ ...resultat, raison, ms: Math.round(performance.now() - t0) });
  const distincts = new Set((printings ?? []).map((p) => p.setCode));
  if (distincts.size < 2) return fini({ tirage: printings?.[0] ?? null, lecture: '', similarite: 0, avance: 0 }, 'tirage unique');
  if (!assezGrande(coins, image.height)) return fini({ tirage: null, lecture: '', similarite: 0, avance: 0 }, 'carte trop petite');

  const carte = redresser(image, coins, LARGEUR, HAUTEUR);
  const x = Math.round(BANDE_CODE.x0 * LARGEUR);
  const y = Math.round(BANDE_CODE.y0 * HAUTEUR);
  const w = Math.round((BANDE_CODE.x1 - BANDE_CODE.x0) * LARGEUR);
  const h = Math.round((BANDE_CODE.y1 - BANDE_CODE.y0) * HAUTEUR);

  const source = new OffscreenCanvas(LARGEUR, HAUTEUR);
  source.getContext('2d').putImageData(new ImageData(carte.data, carte.width, carte.height), 0, 0);
  const bande = new OffscreenCanvas(w * ZOOM, h * ZOOM);
  const bx = bande.getContext('2d');
  bx.imageSmoothingQuality = 'high';
  bx.drawImage(source, x, y, w, h, 0, 0, w * ZOOM, h * ZOOM);

  const { text } = await recognize(bande);
  const appariement = apparierTirage(text, printings);
  return fini(
    { tirage: appariement.tirage, lecture: appariement.lecture, similarite: appariement.similarite, avance: appariement.avance },
    appariement.tirage ? null : 'code illisible',
  );
}
