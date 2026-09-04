/**
 * Chaîne de prétraitement image avant OCR.
 *
 * Le fond d'une carte Yu-Gi-Oh! est tout sauf uniforme : dégradé beige des
 * monstres normaux, vert des magies, noir des Xyz, plus le vernis qui renvoie
 * la lumière de la pièce. Un seuil fixe échoue donc systématiquement sur au
 * moins une famille de cartes. On enchaîne :
 *
 *   luma -> étirement de contraste avec écrêtage -> seuil d'Otsu -> auto-inversion
 *
 * Les fonctions du coeur travaillent sur des tableaux d'octets bruts : elles
 * n'ont besoin ni du DOM ni d'un canvas, ce qui les rend testables sous Node.
 */

/** Facteur de sur-échantillonnage : Tesseract veut ~30 px de hauteur de capitale. */
export const UPSCALE = 3;

/**
 * Luma perceptuelle. Le rouge du bandeau des magies et le magenta des pièges
 * ressortent très différemment selon la pondération : celle de la Rec. 601
 * garde le texte noir bien séparé dans les deux cas.
 * @param {{data: Uint8ClampedArray, width: number, height: number}} imageData
 * @returns {Uint8ClampedArray} un octet par pixel
 */
export function toGrayscale(imageData) {
  const { data, width, height } = imageData;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; p < gray.length; i += 4, p += 1) {
    gray[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }
  return gray;
}

/**
 * Étirement linéaire de l'histogramme après écrêtage des queues.
 *
 * L'écrêtage est le point clé : un seul pixel de reflet spéculaire à 255 et un
 * seul pixel d'ombre à 0 suffisent à annuler un étirement naïf min/max. On
 * ignore donc `clip` (2 % par défaut) de la masse de chaque côté.
 *
 * @param {Uint8ClampedArray} gray
 * @param {number} clip fraction de pixels ignorée à chaque extrémité
 * @returns {Uint8ClampedArray} nouveau tableau
 */
export function stretchContrast(gray, clip = 0.02) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 1) histogram[gray[i]] += 1;

  const cutoff = Math.floor(gray.length * clip);

  let low = 0;
  for (let seen = 0; low < 255; low += 1) {
    seen += histogram[low];
    if (seen > cutoff) break;
  }

  let high = 255;
  for (let seen = 0; high > low; high -= 1) {
    seen += histogram[high];
    if (seen > cutoff) break;
  }

  const out = new Uint8ClampedArray(gray.length);
  // Image plate (fond uni sans texte) : l'étirement diviserait par zéro.
  if (high <= low) {
    out.set(gray);
    return out;
  }

  const scale = 255 / (high - low);
  for (let i = 0; i < gray.length; i += 1) {
    out[i] = (gray[i] - low) * scale;
  }
  return out;
}

/**
 * Seuil d'Otsu : maximise la variance inter-classe du couple (fond, encre).
 * @param {Uint8ClampedArray} gray
 * @returns {number} seuil dans [0, 255]
 */
export function otsuThreshold(gray) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 1) histogram[gray[i]] += 1;

  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t += 1) sum += t * histogram[t];

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let threshold = 127;

  for (let t = 0; t < 256; t += 1) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const between =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (between > best) {
      best = between;
      threshold = t;
    }
  }

  return threshold;
}

/**
 * @param {Uint8ClampedArray} gray
 * @param {number} threshold
 * @returns {Uint8ClampedArray} 0 ou 255
 */
export function binarize(gray, threshold) {
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i += 1) {
    out[i] = gray[i] > threshold ? 255 : 0;
  }
  return out;
}

/** Fraction de pixels noirs — sert à décider de l'inversion. */
export function darkRatio(binary) {
  let dark = 0;
  for (let i = 0; i < binary.length; i += 1) {
    if (binary[i] === 0) dark += 1;
  }
  return dark / binary.length;
}

export function invert(binary) {
  const out = new Uint8ClampedArray(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = 255 - binary[i];
  return out;
}

/**
 * Chaîne complète sur un canal unique.
 *
 * L'auto-inversion couvre les cartes Xyz (titre blanc sur noir) et les codes
 * d'extension imprimés en blanc sur les bordures foncées : du texte occupe
 * toujours une minorité de la surface, donc si le noir domine c'est que
 * l'encre et le fond sont intervertis.
 *
 * @returns {{pixels: Uint8ClampedArray, threshold: number, inverted: boolean}}
 */
export function preprocessGray(gray, { clip = 0.02, autoInvert = true } = {}) {
  const stretched = stretchContrast(gray, clip);
  const threshold = otsuThreshold(stretched);
  let pixels = binarize(stretched, threshold);
  let inverted = false;

  if (autoInvert && darkRatio(pixels) > 0.5) {
    pixels = invert(pixels);
    inverted = true;
  }

  return { pixels, threshold, inverted };
}

/**
 * Réécrit un canal unique dans un ImageData RGBA (opaque, gris).
 */
export function grayToImageData(pixels, width, height, target) {
  const out = target ?? { data: new Uint8ClampedArray(width * height * 4), width, height };
  for (let p = 0, i = 0; p < pixels.length; p += 1, i += 4) {
    out.data[i] = pixels[p];
    out.data[i + 1] = pixels[p];
    out.data[i + 2] = pixels[p];
    out.data[i + 3] = 255;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Partie navigateur : recadrage + rendu sur canvas                     */
/* ------------------------------------------------------------------ */

/**
 * Recadre une zone de la source, la sur-échantillonne et lui applique la chaîne.
 *
 * Le recadrage se fait sur la résolution *native* de la vidéo, jamais sur sa
 * taille CSS : sur un téléphone la vidéo est souvent affichée deux fois plus
 * petite qu'elle n'est capturée, et recadrer sur l'affichage jetterait la
 * moitié des pixels utiles.
 *
 * @param {CanvasImageSource} source
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {{scale?: number, autoInvert?: boolean}} options
 * @returns {{canvas: HTMLCanvasElement, threshold: number, inverted: boolean}}
 */
export function cropAndPreprocess(source, rect, { scale = UPSCALE, autoInvert = true } = {}) {
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    source,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    width,
    height,
  );

  const imageData = context.getImageData(0, 0, width, height);
  const { pixels, threshold, inverted } = preprocessGray(toGrayscale(imageData), { autoInvert });
  grayToImageData(pixels, width, height, imageData);
  context.putImageData(imageData, 0, 0);

  return { canvas, threshold, inverted };
}

/**
 * Capture l'image courante d'une vidéo dans un canvas hors écran, à sa
 * résolution native.
 * @param {HTMLVideoElement} video
 */
export function grabFrame(video) {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return canvas;
}
