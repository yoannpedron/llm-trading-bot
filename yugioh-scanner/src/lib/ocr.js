/**
 * Pilotage de Tesseract.js.
 *
 * Deux choix dictent la réactivité de l'application :
 *
 * 1. **Un worker par configuration.** Changer `tessedit_char_whitelist` entre
 *    deux appels force Tesseract à reconstruire son moteur de reconnaissance.
 *    On dédie donc un worker au code d'extension (chiffres + majuscules, ligne
 *    unique) et un autre au titre (texte libre) : chacun est paramétré une fois
 *    pour toutes, et une reconnaissance ne coûte plus que la reconnaissance.
 *
 * 2. **Chauffage au montage.** Le modèle `eng.traineddata` pèse quelques Mo. On
 *    lance son téléchargement dès que l'écran s'affiche, pendant que
 *    l'utilisateur autorise la caméra et vise sa carte : le premier scan tombe
 *    donc sur un worker déjà prêt.
 */

import { createWorker, PSM } from 'tesseract.js';

/** Les chemins par défaut de Tesseract pointent vers un CDN ; surchargeables. */
const PATHS = {
  workerPath: import.meta.env?.VITE_TESSERACT_WORKER_PATH || undefined,
  corePath: import.meta.env?.VITE_TESSERACT_CORE_PATH || undefined,
  langPath: import.meta.env?.VITE_TESSERACT_LANG_PATH || undefined,
};

const cleanPaths = Object.fromEntries(
  Object.entries(PATHS).filter(([, value]) => Boolean(value)),
);

const PROFILES = {
  setCode: {
    // Le code est une ligne unique, en capitales, sans le moindre caractère
    // accentué : restreindre l'alphabet supprime d'un coup l'essentiel des
    // hallucinations de Tesseract sur le bruit de la bordure.
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-',
  },
  title: {
    // Le titre peut contenir des chiffres (« Number 39: Utopia ») et de la
    // ponctuation ; on garde donc un alphabet large, mais toujours une ligne.
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -'#&,.:!?()@",
  },
};

/** Ne demander que le texte : le HOCR et les blocs coûtent une sérialisation inutile. */
const TEXT_ONLY = { text: true, blocks: false, hocr: false, tsv: false };

const workers = new Map();

function startWorker(profile, onProgress) {
  const promise = createWorker('eng', 1, {
    ...cleanPaths,
    logger: onProgress
      ? (message) => {
          if (message.status === 'loading tesseract core' || message.status.startsWith('loading lang')) {
            onProgress(message.progress ?? 0);
          }
        }
      : undefined,
  }).then(async (worker) => {
    await worker.setParameters(PROFILES[profile]);
    return worker;
  });

  workers.set(profile, promise);
  return promise;
}

/** Récupère (ou démarre) le worker d'un profil. */
export function getWorker(profile, onProgress) {
  return workers.get(profile) ?? startWorker(profile, onProgress);
}

/** Lance le téléchargement du modèle sans attendre le premier scan. */
export function warmUp(onProgress) {
  return Promise.all([getWorker('setCode', onProgress), getWorker('title')]);
}

/**
 * Reconnaît une image déjà prétraitée.
 * @param {'setCode'|'title'} profile
 * @param {CanvasImageSource|Blob|string} image
 * @returns {Promise<{text: string, confidence: number}>}
 */
export async function recognize(profile, image) {
  const worker = await getWorker(profile);
  const { data } = await worker.recognize(image, {}, TEXT_ONLY);
  return { text: data.text ?? '', confidence: data.confidence ?? 0 };
}

/** Libère les workers (démontage du composant, changement de page). */
export async function shutdown() {
  const running = [...workers.values()];
  workers.clear();
  await Promise.all(
    running.map((promise) => promise.then((worker) => worker.terminate()).catch(() => {})),
  );
}
