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
  /**
   * Deuxième passe, sur le seul numéro : CHIFFRES ET RIEN D'AUTRE.
   *
   * C'est la parade la plus efficace mesurée contre les confusions du moteur.
   * Sur la police à empattements des cartes, il lit « 113 » comme « IIZ » et
   * « 040 » comme « O40 » — de façon systématique, à chaque image, si bien que
   * ni le vote entre images ni l'appariement approché n'y peuvent rien.
   * Retirer les lettres de l'alphabet rend la classe d'erreurs *impossible*,
   * exactement comme pour le passcode.
   *
   * Mesuré sur les trois recadrages réels (`scripts/ocr-strategies.mjs`) :
   * une passe → 1 bonne carte sur 3, et une fausse ; deux passes → 2 sur 3,
   * aucune fausse. Coût : 22 ms, et seulement quand la première passe a échoué.
   */
  setCodeNumber: {
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    tessedit_char_whitelist: '0123456789',
  },
  passcode: {
    // Huit chiffres et rien d'autre. Retirer les lettres de l'alphabet supprime
    // d'un coup toute la classe d'erreurs qui plombe le code d'extension : il
    // devient impossible de lire « O » à la place de « 0 ».
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    tessedit_char_whitelist: '0123456789',
  },
};

/**
 * Grammaire d'un code d'extension, pour `user_patterns` de Tesseract.
 *
 * Syntaxe des motifs : `\\n` alphanumérique, `\\A` majuscule, `\\d` chiffre.
 * Les formes viennent d'un recensement des 44 499 codes de l'index :
 *
 *     préfixe-RR999    41 000   région de deux lettres, trois chiffres
 *     préfixe-RRL99     2 400   lettre de série, puis DEUX chiffres (« ENA01 »)
 *     préfixe-999       1 800   codes anciens sans région (« LOB-001 »)
 *     préfixe-A999        730   codes anciens à région d'une lettre (« PSV-E088 »)
 *
 * Le préfixe fait de deux à cinq caractères alphanumériques (« LOB », « RA03 »,
 * « LC5D »). Aucune forme « lettre de série + trois chiffres » : un premier
 * jeu de motifs l'admettait, et le « O » que le moteur insère après la région
 * (« ENO002 ») y trouvait refuge. La forme à deux chiffres seuls (« AA-RR99 »,
 * 14 codes) est laissée de côté pour la même raison.
 *
 * Pourquoi c'est la parade la plus rentable : le moteur insérait un « O »
 * entre la région et le numéro sur un quart des lectures d'une image nette, et
 * lisait « 3 » comme « Z » qu'une table de transposition changeait en « 2 » —
 * une autre carte, valide. Contraint à un chiffre à cette position, il choisit
 * le chiffre le plus proche de la forme. Mesuré sur 120 images du banc :
 * lecture exacte 87 → 111, bonnes cartes 105 → 117, fausses 1 → 0.
 *
 * Un premier jeu de motifs n'admettait pas de chiffre au milieu du préfixe :
 * « LC5D » devenait « LCSD ». D'où `\\n` partout dans le préfixe.
 */
export function setCodePatterns() {
  const lines = [];
  for (let length = 2; length <= 5; length += 1) {
    const prefix = '\\n'.repeat(length);
    lines.push(`${prefix}-\\A\\A\\d\\d\\d`);
    lines.push(`${prefix}-\\A\\A\\A\\d\\d`);
    lines.push(`${prefix}-\\d\\d\\d`);
    lines.push(`${prefix}-\\A\\d\\d\\d`);
  }
  return `${lines.join('\n')}\n`;
}

const PATTERNS_PATH = '/setcode-patterns.txt';

/**
 * Applique le profil « code d'extension » à un worker fraîchement créé.
 *
 * `user_patterns_file` est un réglage d'initialisation, pas un paramètre : il
 * faut écrire le fichier dans le système de fichiers du worker puis
 * réinitialiser le moteur avec. Partagé par l'application et les bancs de
 * mesure, pour que ce qui est mesuré soit ce qui tourne.
 */
export async function configureSetCodeWorker(worker) {
  await worker.writeText(PATTERNS_PATH, setCodePatterns());
  await worker.reinitialize('eng', 1, { user_patterns_file: PATTERNS_PATH });
  await worker.setParameters(PROFILES.setCode);
  return worker;
}

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
    if (profile === 'setCode') return configureSetCodeWorker(worker);
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
  // Le worker « numéro » est chauffé lui aussi : il sert dès la première
  // lecture difficile, et l'attendre à ce moment-là coûterait une seconde.
  return Promise.all([
    getWorker('setCode', onProgress),
    getWorker('setCodeNumber'),
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

/**
 * Part droite de la bande relue en chiffres seuls.
 *
 * Le numéro occupe la fin du code. Balayé de 0,28 à 0,52 sur les recadrages
 * réels : en deçà de 0,40 le premier chiffre est coupé (« 13 » pour « 113 »),
 * au-delà de 0,46 on n'y gagne rien et l'on ramène des lettres du préfixe.
 */
export const PART_NUMERO = 0.42;

/**
 * Relit le numéro d'un code, en chiffres seuls.
 * @param {HTMLCanvasElement} canvas bande complète, déjà binarisée
 * @returns {Promise<string>} les chiffres lus, sans rien d'autre
 */
export async function recognizeNumber(canvas, { fraction = PART_NUMERO } = {}) {
  const worker = await getWorker('setCodeNumber');
  // Tesseract sait restreindre sa lecture à un rectangle : inutile de
  // fabriquer un canvas intermédiaire à chaque tour.
  const { data } = await worker.recognize(canvas, { rectangle: numberRectangle(canvas, fraction) }, TEXT_ONLY);
  return (data.text ?? '').replace(/\D/g, '');
}

/**
 * Rectangle du numéro dans une bande, en pixels.
 * Exporté pour que les bancs de mesure découpent exactement comme
 * l'application — un banc qui cadre autrement mesure autre chose.
 */
export function numberRectangle({ width, height }, fraction = PART_NUMERO) {
  const largeur = Math.max(1, Math.round(width * fraction));
  return { left: Math.max(0, width - largeur), top: 0, width: largeur, height };
}

/**
 * Remplace la fin d'une lecture par les chiffres relus.
 *
 * On ne substitue que trois caractères, et seulement si la deuxième passe en a
 * rendu au moins trois : sans cette garde, un numéro à deux chiffres — quatorze
 * codes dans tout l'index — verrait son préfixe amputé.
 *
 * Le résultat est proposé **en plus** de la lecture d'origine, jamais à sa
 * place : la boucle essaie les deux, et l'on ne peut donc rien perdre de ce
 * qui fonctionnait.
 *
 * @returns {string|null} la lecture corrigée, ou `null` s'il n'y a rien à faire
 */
export function spliceNumber(texte, chiffres) {
  const lu = String(texte ?? '');
  const numero = String(chiffres ?? '').slice(-3);
  if (numero.length < 3 || lu.length < 4) return null;
  const corrige = lu.slice(0, -3) + numero;
  return corrige === lu ? null : corrige;
}

/** Libère les workers (démontage du composant, changement de page). */
export async function shutdown() {
  const running = [...workers.values()];
  workers.clear();
  await Promise.all(
    running.map((promise) => promise.then((worker) => worker.terminate()).catch(() => {})),
  );
}
