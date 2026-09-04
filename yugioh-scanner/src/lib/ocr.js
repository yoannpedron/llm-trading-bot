/**
 * Lecture du code d'extension : PP-OCRv6 dans le navigateur.
 *
 * Pourquoi plus Tesseract. Tesseract est conçu pour des scans à plat ; sur
 * une inscription de deux millimètres photographiée au téléphone, il fallait
 * quatre binarisations, une grammaire de codes, une seconde passe en chiffres
 * seuls — et il refusait encore une carte sur trois (STOR-FR040, dont le R se
 * lisait K, systématiquement, sur toutes les images). PP-OCRv6 (Baidu) est un
 * réseau entraîné sur du texte photographié ; il lit l'image brute. Mesuré sur
 * les mêmes recadrages réels : 3 cartes sur 3, aucune fausse, 360 ms par
 * passe en WebAssembly (voir `modeles.js` pour le tableau complet).
 *
 * Le moteur tourne dans un worker (`ocr.worker.js`) ; ce module en est la
 * façade côté page : chauffage au montage, une promesse par lecture, arrêt.
 */

import { TOTAL_OCTETS } from './modeles.js';

export { TOTAL_OCTETS };

/** Où sont servis les modèles : à côté de l'application, sous `modeles/`. */
export function dossierModeles() {
  const base = import.meta.env?.BASE_URL ?? '/';
  return new URL(`${base.replace(/\/?$/, '/')}modeles/`, globalThis.location?.href ?? 'http://localhost/').href;
}

let worker = null;
let pret = null;
let prochainId = 1;
const enAttente = new Map();
let etat = { provider: null };

/** Fournisseur d'exécution retenu (`webgpu` ou `wasm`), connu une fois prêt. */
export const moteur = () => etat;

function demarrer(onProgress) {
  const instance = new Worker(new URL('./ocr.worker.js', import.meta.url), { type: 'module' });
  worker = instance;

  pret = new Promise((resolve, reject) => {
    instance.onmessage = (event) => {
      const message = event.data ?? {};
      switch (message.type) {
        case 'progress':
          onProgress?.(message.fraction);
          return;
        case 'ready':
          etat = { provider: message.provider, initMs: message.ms };
          resolve(etat);
          return;
        case 'error':
          reject(new Error(message.message));
          return;
        case 'lu': {
          const attente = enAttente.get(message.id);
          enAttente.delete(message.id);
          attente?.resolve({ text: message.text, lines: message.lines, ms: message.ms });
          return;
        }
        case 'echec': {
          const attente = enAttente.get(message.id);
          enAttente.delete(message.id);
          attente?.reject(new Error(message.message));
          return;
        }
        default:
      }
    };
    instance.onerror = (event) => {
      const erreur = new Error(event?.message ?? 'Le moteur de lecture a planté');
      reject(erreur);
      for (const attente of enAttente.values()) attente.reject(erreur);
      enAttente.clear();
    };
  });

  instance.postMessage({ type: 'init', base: dossierModeles() });
  return pret;
}

/**
 * Lance le téléchargement et l'initialisation du moteur.
 *
 * Appelé dès que l'écran s'affiche, pendant que l'utilisateur autorise la
 * caméra et vise sa carte : le premier scan tombe sur un moteur déjà prêt.
 * Idempotent.
 *
 * @param {(fraction: number) => void} [onProgress] avancement dans [0, 1]
 * @returns {Promise<{provider: string, initMs: number}>}
 */
export function warmUp(onProgress) {
  return pret ?? demarrer(onProgress);
}

/**
 * Lit tout le texte d'une image.
 *
 * @param {HTMLCanvasElement|ImageBitmap|OffscreenCanvas} image recadrage brut
 * @returns {Promise<{text: string, lines: Array<{text: string, confidence: number}>, ms: number}>}
 *   `text` : les lignes lues, séparées par un saut de ligne, dans l'ordre de
 *   lecture ; `ms` : durée de la passe dans le worker.
 */
export async function recognize(image) {
  await warmUp();
  const bitmap = image instanceof ImageBitmap ? image : await createImageBitmap(image);
  const id = prochainId;
  prochainId += 1;

  return new Promise((resolve, reject) => {
    enAttente.set(id, { resolve, reject });
    worker.postMessage({ type: 'lire', id, bitmap }, [bitmap]);
  });
}

/** Libère le worker (démontage du composant, changement de page). */
export async function shutdown() {
  worker?.terminate();
  worker = null;
  pret = null;
  etat = { provider: null };
  for (const attente of enAttente.values()) attente.reject(new Error('Moteur arrêté'));
  enAttente.clear();
}
