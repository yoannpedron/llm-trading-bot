/**
 * Reconnaître le TIRAGE d'une carte déjà identifiée, par son code imprimé.
 *
 * L'illustration dit quelle carte c'est ; le code sous l'illustration
 * (« LDK2-FR001 ») dit quelle édition — et c'est l'édition qui fixe le prix.
 * Comme la carte est connue, le code n'est plus à chercher parmi les 44 000
 * de l'index mais parmi ceux de CETTE carte, trois en médiane, cinquante-neuf
 * au pire. Une lecture OCR approximative suffit alors.
 *
 * Mesuré (`scripts/harness/code-bench.mjs`, borne haute sur cartes rendues) :
 * la bande du code se lit dès que la carte occupe 60 % de la hauteur de
 * l'image ; avec une similarité d'au moins 70 et une avance d'au moins 5 sur
 * le deuxième code de la carte, 100 % des appariements étaient justes pour
 * 77 % de rappel — et sur l'appareil réel, l'utilisateur n'a pas vu de faux
 * tirage. Ce module est pur : la lecture elle-même est dans `lireTirage.js`.
 */

import { codeSimilarity } from './match.js';
import { setCodeMatchKey } from './parse.js';

/** Bande du code sur une carte redressée, en fractions de sa largeur et hauteur. */
export const BANDE_CODE = { x0: 0.45, x1: 0.93, y0: 0.722, y1: 0.758 };

/**
 * Hauteur minimale de la carte, en fraction de la hauteur de l'image, pour
 * tenter une lecture. Mesuré : à 50 % le code se lit une fois sur deux,
 * et une lecture ratée ne coûte qu'une passe — on tente dès 45 %.
 */
export const HAUTEUR_LISIBLE = 0.45;

export const SIMILARITE_MINIMALE = 70;
export const AVANCE_MINIMALE = 5;

/**
 * La carte est-elle assez grande dans l'image pour que son code se lise ?
 * @param {Array<{x:number,y:number}>} coins dans le repère de l'image
 * @param {number} hauteurImage
 */
export function assezGrande(coins, hauteurImage) {
  if (!coins || coins.length !== 4 || !hauteurImage) return false;
  const ys = coins.map((p) => p.y);
  return (Math.max(...ys) - Math.min(...ys)) / hauteurImage >= HAUTEUR_LISIBLE;
}

/** Nettoie une lecture OCR de la bande : majuscules, sans espaces ni ponctuation parasite. */
export function nettoyerLecture(texte) {
  return String(texte ?? '')
    .toUpperCase()
    .replace(/[‐-―−_]/g, '-')
    .replace(/[^A-Z0-9-]/g, '');
}

/**
 * Ce qui, dans la lecture, ressemble à un code de tirage : « MP17-EN171 »
 * au milieu de « MP17-EN171ITTOTHEGY… » quand la bande a attrapé un bout de
 * texte. Sans cela, le texte parasite noyait la similarité (22 sur une
 * lecture qui contenait le code exact). À défaut de motif, la lecture
 * nettoyée entière.
 */
export function extraireCode(lecture) {
  const motif = /[A-Z0-9]{2,5}-[A-Z]{0,2}[A-Z]?[0-9]{2,4}/;
  // D'abord mot par mot (les espaces de l'OCR séparent le code du reste),
  // puis dans la lecture recollée (le texte parasite collé au code).
  const mots = String(lecture ?? '')
    .toUpperCase()
    .replace(/[‐-―−_]/g, '-')
    .split(/[^A-Z0-9-]+/)
    .filter(Boolean);
  for (const mot of mots) {
    const trouve = motif.exec(mot);
    if (trouve) return trouve[0];
  }
  const propre = nettoyerLecture(lecture);
  const trouve = motif.exec(propre);
  return trouve ? trouve[0] : propre;
}

/**
 * Le tirage de la carte dont le code ressemble le plus à la lecture.
 *
 * @param {string} lecture texte brut lu dans la bande
 * @param {Array<{setCode: string}>} printings tirages de la carte identifiée
 * @returns {{tirage: object|null, similarite: number, avance: number, lecture: string,
 *   candidats: Array<{cle: string, similarite: number}>}}
 *   `tirage` est nul si la lecture ne désigne pas un code assez sûrement
 */
export function apparierTirage(lecture, printings) {
  const lu = setCodeMatchKey(extraireCode(lecture));
  const vide = { tirage: null, similarite: 0, avance: 0, lecture: lu, candidats: [] };
  if (!lu || lu.length < 5 || !printings?.length) return vide;

  // Les codes distincts de la carte, région ignorée : « LOB-EN005 » et
  // « LOB-FR005 » sont le même tirage vu de deux pays.
  const parCle = new Map();
  for (const tirage of printings) {
    const cle = setCodeMatchKey(tirage.setCode);
    if (cle && !parCle.has(cle)) parCle.set(cle, tirage);
  }
  const candidats = [...parCle.keys()]
    .map((cle) => ({ cle, similarite: codeSimilarity(lu, cle) }))
    .sort((a, b) => b.similarite - a.similarite);
  if (!candidats.length) return vide;

  const [premier, second] = candidats;
  const avance = premier.similarite - (second?.similarite ?? 0);
  const sur = premier.similarite >= SIMILARITE_MINIMALE && (second === undefined || avance >= AVANCE_MINIMALE);
  return { tirage: sur ? parCle.get(premier.cle) : null, similarite: premier.similarite, avance, lecture: lu, candidats };
}

/**
 * Restreint les tirages d'une carte à ceux du code reconnu (toutes raretés de
 * ce code), pour l'écran de résultat et l'inventaire.
 */
export function tiragesDuCode(printings, tirage) {
  if (!tirage) return printings ?? [];
  const cle = setCodeMatchKey(tirage.setCode);
  const memes = (printings ?? []).filter((p) => setCodeMatchKey(p.setCode) === cle);
  return memes.length ? memes : [tirage];
}

