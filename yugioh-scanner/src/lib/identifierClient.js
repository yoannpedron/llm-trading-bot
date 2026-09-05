/**
 * Façade du worker d'identification, côté fil principal.
 *
 * Même contrat que `ocr.js` : `warmUpArt(onProgress)` télécharge l'index et
 * démarre le worker, `identifier(imageData)` rend une promesse, et
 * `shutdownArt()` arrête tout. Une seule identification à la fois : la boucle
 * du viseur n'en lance jamais deux, et le worker les traiterait en série de
 * toute façon.
 */

import { loadArtIndex } from './artIndex.js';
import { LARGEUR_DETECTION_APP } from './identifier.js';

let worker = null;
let pret = null;
let compteur = 0;
const enAttente = new Map();

function demarrer() {
  if (worker) return;
  worker = new Worker(new URL('./identifier.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'pret') {
      pret?.resolve(data.taille);
      return;
    }
    const attente = enAttente.get(data.id);
    if (!attente) return;
    enAttente.delete(data.id);
    if (data.type === 'erreur') attente.reject(new Error(data.message));
    else attente.resolve(data);
  };
  worker.onerror = (evenement) => {
    const erreur = new Error(evenement.message ?? 'worker d’identification en panne');
    pret?.reject(erreur);
    for (const attente of enAttente.values()) attente.reject(erreur);
    enAttente.clear();
  };
}

/**
 * Télécharge l'index (8,8 Mo, une fois) et l'installe dans le worker.
 * @param {(fraction: number) => void} [onProgress]
 * @returns {Promise<number>} nombre d'empreintes
 */
export function warmUpArt(onProgress) {
  if (pret) return pret.promesse;
  let resolve;
  let reject;
  const promesse = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  pret = { promesse, resolve, reject };
  demarrer();
  const depart = performance.now();
  promesse.then((taille) => console.debug(`[viseur] index prêt : ${taille} empreintes, ${Math.round(performance.now() - depart)} ms`)).catch(() => {});
  loadArtIndex(onProgress)
    .then((index) => {
      console.debug(`[viseur] index téléchargé en ${Math.round(performance.now() - depart)} ms`);
      // L'index est renvoyé au worker sous forme d'octets : c'est lui qui
      // cherche, le fil principal n'en a pas besoin.
      const octets = new Uint8Array(index.empreintes.buffer.slice(0));
      worker.postMessage({ type: 'init', index: octets.buffer }, [octets.buffer]);
    })
    .catch((erreur) => {
      pret.reject(erreur);
      pret = null;
    });
  return promesse;
}

/**
 * Identifie la carte visible dans une image native de la caméra.
 * @param {ImageData} image transférée au worker : ne plus l'utiliser ensuite
 */
export function identifier(image) {
  if (!worker) throw new Error('worker non démarré');
  const id = (compteur += 1);
  return new Promise((resolve, reject) => {
    enAttente.set(id, { resolve, reject });
    worker.postMessage({ type: 'identifier', id, image, largeur: LARGEUR_DETECTION_APP }, [image.data.buffer]);
  });
}

export async function shutdownArt() {
  worker?.terminate();
  worker = null;
  pret = null;
  for (const attente of enAttente.values()) attente.reject(new Error('arrêt'));
  enAttente.clear();
}
