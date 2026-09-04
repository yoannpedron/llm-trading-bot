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

export const PROFILES = {
  setCode: {
    // Bloc unique, et non « ligne unique ».
    //
    // PSM 7 suppose que l'image ne contient *que* la ligne à lire. Or la taille
    // du viseur en pixels vidéo dépend de la hauteur de l'écran : sur un
    // téléphone au conteneur court, le même cadre à l'écran couvre une bande
    // 1,5 fois plus haute de l'image, et embarque la bordure du cadre de la
    // carte. PSM 7 rend alors du vide, avec une confiance de zéro et sans la
    // moindre erreur — une panne parfaitement silencieuse.
    //
    // Mesuré sur les deux cadrages : PSM 6 lit « RA03-FR001 » dans les deux,
    // PSM 7 seulement dans le cadrage serré, PSM 3 et 11 dans aucun des deux.
    tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    // Le code n'a ni minuscule ni accent : restreindre l'alphabet supprime
    // l'essentiel des hallucinations sur le décor de la carte.
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-',
  },
  title: {
    // Le titre peut contenir des chiffres (« Number 39: Utopia ») et de la
    // ponctuation ; on garde donc un alphabet large, mais toujours une ligne.
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -'#&,.:!?()@",
  },
  passcode: {
    // Huit chiffres et rien d'autre. Retirer les lettres de l'alphabet supprime
    // d'un coup toute la classe d'erreurs qui plombe le code d'extension : il
    // devient impossible de lire « O » à la place de « 0 ».
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    tessedit_char_whitelist: '0123456789',
  },
};

/** Ne demander que le texte : le HOCR et les blocs coûtent une sérialisation inutile. */
const TEXT_ONLY = { text: true, blocks: false, hocr: false, tsv: false };

const workers = new Map();

function startWorker(profile, onProgress) {
  const options = { ...cleanPaths };

  // La clé `logger` n'est ajoutée que s'il y a vraiment quelque chose à
  // journaliser : la passer à `undefined` écraserait le logger par défaut de
  // Tesseract, qu'il appelle ensuite sans vérifier — et le worker meurt à la
  // première image sur « logger is not a function ».
  if (onProgress) {
    options.logger = (message) => {
      // Tesseract appelle ce rappel depuis son propre gestionnaire de messages.
      // Une exception ici ne remonte donc pas à l'appelant : elle casse la
      // réception, et la reconnaissance se met à rendre du vide sans erreur.
      // D'où la valeur par défaut et le filet — tous les paquets ne portent pas
      // de `status`.
      try {
        const status = message?.status ?? '';
        if (status === 'loading tesseract core' || status.startsWith('loading lang')) {
          onProgress(message.progress ?? 0);
        }
      } catch {
        // Un défaut de journalisation ne doit jamais coûter une lecture.
      }
    };
  }

  const promise = createWorker('eng', 1, options).then(async (worker) => {
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
  return Promise.all([
    getWorker('setCode', onProgress),
    getWorker('title'),
    getWorker('passcode'),
  ]);
}

/**
 * Reconnaît une image déjà prétraitée.
 * @param {'setCode'|'title'|'passcode'} profile
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
