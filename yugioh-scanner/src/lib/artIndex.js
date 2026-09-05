/**
 * Index des empreintes d'illustration, embarqué.
 *
 * `art-index.bin` est produit par `scripts/build-art-index.mjs` : 14 523
 * cartes × deux cadrages × 312 octets, soit 8,8 Mo — téléchargé une fois,
 * gardé par le cache du navigateur. Avec lui, l'identification d'une carte par
 * son illustration se fait entièrement sur l'appareil, sans réseau ni modèle.
 *
 * Le chargement rend la progression, comme pour les modèles : 8,8 Mo sur un
 * réseau mobile, ça se voit, et l'utilisateur doit savoir ce qu'il attend.
 */

import { lireIndexArt } from './art.js';

const BASE = import.meta.env?.BASE_URL ?? '/';

let promesse = null;

/**
 * Télécharge l'index et le rend prêt pour `chercher`.
 *
 * @param {(fraction: number) => void} [onProgress] avancement dans [0, 1]
 * @returns {Promise<{ids: Int32Array, empreintes: Uint8Array, taille: number}>}
 */
export function loadArtIndex(onProgress) {
  promesse ??= (async () => {
    const response = await fetch(`${BASE}art-index.bin`);
    if (!response.ok) throw new Error(`index d’illustrations absent (${response.status})`);
    const total = Number(response.headers.get('content-length')) || 0;
    // Lecture par morceaux pour rendre la progression ; sans `body` (vieux
    // navigateur, réponse opaque) on se contente d'attendre.
    if (!response.body || !total) {
      onProgress?.(0);
      const octets = await response.arrayBuffer();
      onProgress?.(1);
      return lireIndexArt(octets);
    }
    // `content-length` est la taille sur le réseau — COMPRESSÉE quand le
    // serveur gzippe (GitHub Pages le fait) — alors que le flux rend les
    // octets décompressés. Elle ne sert donc qu'à la progression, bornée à 1 ;
    // les morceaux sont accumulés puis assemblés, sans présumer de la taille.
    // Une première version allouait la taille annoncée et refusait le reste :
    // « index plus long qu'annoncé », sur le vrai site.
    const lecteur = response.body.getReader();
    const morceaux = [];
    let recu = 0;
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      morceaux.push(value);
      recu += value.length;
      onProgress?.(Math.min(1, recu / total));
    }
    const tampon = new Uint8Array(recu);
    let position = 0;
    for (const morceau of morceaux) {
      tampon.set(morceau, position);
      position += morceau.length;
    }
    onProgress?.(1);
    return lireIndexArt(tampon.buffer);
  })().catch((erreur) => {
    promesse = null;
    throw erreur;
  });
  return promesse;
}
