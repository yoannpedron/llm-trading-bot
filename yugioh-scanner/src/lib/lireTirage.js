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
 * Si la bande étirée ne donne pas de lecture nette, lire aussi la bande
 * telle quelle et garder la meilleure. Mesuré : tirages justes de 96 à
 * 97 %, lectures exactes de 81 à 83 %, pour une seconde passe du moteur
 * dans 12 % des cas (le moteur prend une à deux secondes sur téléphone).
 */
const SECONDE_LECTURE = true;
/**
 * Rayon (px de la bande agrandie) de la moyenne glissante qui lisse le grain
 * avant l'étirement du contraste. Mesuré sur le banc de nuit (luminosité
 * 0,35, grain 32) : 45 % de tirages justes sans, 53 % au rayon 1, 58 % au
 * rayon 2 ; de jour, 97 → 98 %. Le grain du capteur monte avec le gain la
 * nuit ; l'étirement du contraste, seul, l'amplifiait.
 */
const LISSAGE = 1.5;

/**
 * @param {ImageData} image l'image native où la carte a été reconnue
 * @param {Array<{x:number,y:number}>} coins de la carte, dans le repère de `image`
 * @param {Array<{setCode: string}>} printings tirages de la carte identifiée
 * @returns {Promise<{tirage: object|null, lecture: string, similarite: number, avance: number,
 *   raison: string|null, ms: number}>}
 */
export async function lireTirage(image, coins, printings, { bande = BANDE_CODE, hauteurBande = HAUTEUR_BANDE, contraste = CONTRASTE, secondeLecture = SECONDE_LECTURE, lissage = LISSAGE } = {}) {
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
    if (etirer || lissage > 0) preparerBande(bx, vue.width, vue.height, { contraste: etirer, lissage });
    const { text } = await recognize(vue);
    return { ...apparierTirage(text, printings), brut: text };
  };

  // La bande au contraste étiré d'abord ; si la lecture n'est pas nette,
  // la bande telle quelle aussi, et l'on garde la meilleure des deux.
  let appariement = await lireBande(contraste);
  if (!appariement.net && contraste && secondeLecture) {
    const brute = await lireBande(false);
    if (brute.exact || (!appariement.tirage && brute.tirage) || (Boolean(brute.tirage) === Boolean(appariement.tirage) && brute.similarite > appariement.similarite)) appariement = brute;
  }
  return fini(
    { tirage: appariement.tirage, exact: appariement.exact, net: appariement.net, ambigu: appariement.ambigu, lecture: appariement.lecture, brut: appariement.brut, similarite: appariement.similarite, avance: appariement.avance },
    appariement.tirage ? null : 'code illisible',
  );
}

/**
 * Étire le contraste de la bande (2e et 98e centiles → 0 et 255), en gris.
 * Le code est une encre sombre sur un cadre clair ; sous une lampe ou dans
 * l'ombre, la bande est terne et le moteur hésite.
 */
export function etirerContraste(cx, largeur, hauteur) {
  preparerBande(cx, largeur, hauteur, { contraste: true, lissage: 0 });
}

/**
 * Prépare la bande pour le moteur : gris, grain lissé (moyenne glissante de
 * rayon `lissage`, séparable), puis contraste étiré entre le 2e et le 98e
 * centile. L'ordre compte : étirer d'abord amplifierait le grain.
 */
export function preparerBande(cx, largeur, hauteur, { contraste = true, lissage = 0 } = {}) {
  const img = cx.getImageData(0, 0, largeur, hauteur);
  const d = img.data;
  let gris = new Float32Array(largeur * hauteur);
  for (let i = 0, p = 0; i < d.length; i += 4, p += 1) gris[p] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  if (lissage > 0) gris = lisser(gris, largeur, hauteur, lissage);
  let bas = 0;
  let etendue = 255;
  if (contraste) {
    const histo = new Uint32Array(256);
    for (let p = 0; p < gris.length; p += 1) histo[Math.round(gris[p])] += 1;
    const total = gris.length;
    let cumul = 0;
    while (bas < 255 && cumul + histo[bas] < total * 0.02) cumul += histo[bas++];
    let haut = 255;
    cumul = 0;
    while (haut > 0 && cumul + histo[haut] < total * 0.02) cumul += histo[haut--];
    etendue = Math.max(1, haut - bas);
  }
  for (let i = 0, p = 0; i < d.length; i += 4, p += 1) {
    const v = contraste ? Math.max(0, Math.min(255, ((gris[p] - bas) * 255) / etendue)) : gris[p];
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
  }
  cx.putImageData(img, 0, 0);
}

/** Moyenne glissante séparable de rayon `r` (entier ≥ 1) sur un tableau gris. */
function lisser(gris, largeur, hauteur, r) {
  const rayon = Math.max(1, Math.round(r));
  const tmp = new Float32Array(gris.length);
  const out = new Float32Array(gris.length);
  for (let y = 0; y < hauteur; y += 1) {
    const l = y * largeur;
    for (let x = 0; x < largeur; x += 1) {
      let somme = 0;
      let n = 0;
      for (let k = -rayon; k <= rayon; k += 1) {
        const xx = x + k;
        if (xx < 0 || xx >= largeur) continue;
        somme += gris[l + xx];
        n += 1;
      }
      tmp[l + x] = somme / n;
    }
  }
  for (let x = 0; x < largeur; x += 1) {
    for (let y = 0; y < hauteur; y += 1) {
      let somme = 0;
      let n = 0;
      for (let k = -rayon; k <= rayon; k += 1) {
        const yy = y + k;
        if (yy < 0 || yy >= hauteur) continue;
        somme += tmp[yy * largeur + x];
        n += 1;
      }
      out[y * largeur + x] = somme / n;
    }
  }
  return out;
}
