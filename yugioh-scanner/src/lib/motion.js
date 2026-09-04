/**
 * Détection de changement de carte.
 *
 * Faire tourner l'OCR en boucle serait à la fois lent et inutile : 95 % des
 * images d'un flux webcam sont identiques à la précédente. On calcule donc une
 * empreinte minuscule (16 x 24 pixels en niveaux de gris, soit 384 octets) du
 * cadre carte, et on ne réveille Tesseract que sur deux événements :
 *
 *   - l'image vient de se stabiliser après un mouvement (la carte est posée) ;
 *   - l'empreinte stable diffère de celle de la carte déjà identifiée.
 *
 * C'est ce qui donne la bascule instantanée : dès qu'une autre carte entre dans
 * le cadre, l'empreinte décroche, l'état repasse en « visée » et un nouveau scan
 * part dès que l'image se re-stabilise.
 */

export const SIGNATURE_WIDTH = 16;
export const SIGNATURE_HEIGHT = 24;

/** Au-delà : l'image bouge, inutile d'OCRiser une carte floue. Les trois seuils
 *  qui suivent sont les valeurs par défaut ; le réglage de sensibilité les
 *  remplace au montage de la boucle. */
export const MOTION_THRESHOLD = 0.055;

/** En deçà : c'est la même carte, on ne relance rien. */
export const SAME_CARD_THRESHOLD = 0.035;

/** Durée d'immobilité exigée avant de déclencher un scan. */
export const STABLE_MS = 220;

/** Écart moyen entre deux empreintes, ramené dans [0, 1]. */
export function meanAbsDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / (a.length * 255);
}

/**
 * Énergie de gradient : proxy bon marché de la netteté.
 * Une carte floue ou un cadre vide produisent une énergie très basse.
 */
export function gradientEnergy(pixels, width, height) {
  let total = 0;
  for (let y = 1; y < height; y += 1) {
    for (let x = 1; x < width; x += 1) {
      const index = y * width + x;
      total += Math.abs(pixels[index] - pixels[index - 1]);
      total += Math.abs(pixels[index] - pixels[index - width]);
    }
  }
  return total / (2 * (width - 1) * (height - 1) * 255);
}

/**
 * Suit l'état du cadre image par image.
 *
 * `update()` est appelé au rythme de la boucle de scan et renvoie l'état à
 * afficher ainsi qu'un booléen `shouldScan` : c'est la seule chose que le
 * composant a besoin de savoir.
 */
export class FrameWatcher {
  constructor({
    now = () => performance.now(),
    motionThreshold = MOTION_THRESHOLD,
    sameCardThreshold = SAME_CARD_THRESHOLD,
    stableMs = STABLE_MS,
  } = {}) {
    this.now = now;
    this.motionThreshold = motionThreshold;
    this.sameCardThreshold = sameCardThreshold;
    this.stableMs = stableMs;
    this.previous = null;
    this.scanned = null;
    this.stableSince = null;
  }

  /** Oublie la carte identifiée : le prochain plan stable relancera un scan. */
  reset() {
    this.scanned = null;
    this.stableSince = null;
  }

  /** Mémorise l'empreinte qui vient d'être reconnue, pour ne pas la refaire. */
  accept(signature) {
    this.scanned = signature ? Uint8ClampedArray.from(signature) : null;
  }

  /**
   * @param {Uint8ClampedArray} signature empreinte du cadre courant
   * @param {number} sharpness énergie de gradient de ce cadre
   * @returns {{state: 'moving'|'settling'|'idle'|'ready', shouldScan: boolean, drift: number}}
   */
  update(signature, sharpness = 1) {
    const time = this.now();
    const motion = meanAbsDiff(this.previous, signature);
    this.previous = Uint8ClampedArray.from(signature);

    if (motion > this.motionThreshold) {
      this.stableSince = null;
      return { state: 'moving', shouldScan: false, drift: 1 };
    }

    if (this.stableSince === null) this.stableSince = time;
    if (time - this.stableSince < this.stableMs) {
      return { state: 'settling', shouldScan: false, drift: 1 };
    }

    // Cadre vide ou hors mise au point : rien à lire, on n'use pas de CPU.
    if (sharpness < 0.02) {
      return { state: 'idle', shouldScan: false, drift: 1 };
    }

    const drift = meanAbsDiff(this.scanned, signature);
    if (this.scanned && drift < this.sameCardThreshold) {
      return { state: 'idle', shouldScan: false, drift };
    }

    return { state: 'ready', shouldScan: true, drift };
  }
}

/* ------------------------------------------------------------------ */
/* Partie navigateur                                                    */
/* ------------------------------------------------------------------ */

let signatureCanvas = null;

/**
 * Empreinte du rectangle donné d'une source vidéo.
 * Le canvas de travail est réutilisé d'un appel à l'autre : en allouer un par
 * image ferait travailler le ramasse-miettes 8 fois par seconde pour rien.
 */
export function frameSignature(source, rect) {
  if (!signatureCanvas) {
    signatureCanvas = document.createElement('canvas');
    signatureCanvas.width = SIGNATURE_WIDTH;
    signatureCanvas.height = SIGNATURE_HEIGHT;
  }

  const context = signatureCanvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(
    source,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    SIGNATURE_WIDTH,
    SIGNATURE_HEIGHT,
  );

  const { data } = context.getImageData(0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
  const pixels = new Uint8ClampedArray(SIGNATURE_WIDTH * SIGNATURE_HEIGHT);
  for (let i = 0, p = 0; p < pixels.length; i += 4, p += 1) {
    pixels[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }

  return {
    signature: pixels,
    sharpness: gradientEnergy(pixels, SIGNATURE_WIDTH, SIGNATURE_HEIGHT),
  };
}
