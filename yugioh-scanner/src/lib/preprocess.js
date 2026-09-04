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

/* ------------------------------------------------------------------ */
/* Seuil adaptatif                                                      */
/* ------------------------------------------------------------------ */

/**
 * Images intégrales des valeurs et de leurs carrés.
 *
 * Elles permettent d'obtenir la moyenne et l'écart-type de n'importe quelle
 * fenêtre en temps constant, quatre lectures suffisent. Sans elles, un seuil
 * local coûterait `fenêtre²` opérations par pixel — inutilisable.
 */
export function integralImages(gray, width, height) {
  const stride = width + 1;
  const sum = new Float64Array(stride * (height + 1));
  const squares = new Float64Array(stride * (height + 1));

  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    let rowSquares = 0;
    for (let x = 0; x < width; x += 1) {
      const value = gray[y * width + x];
      rowSum += value;
      rowSquares += value * value;
      const index = (y + 1) * stride + (x + 1);
      sum[index] = sum[index - stride] + rowSum;
      squares[index] = squares[index - stride] + rowSquares;
    }
  }

  return { sum, squares, stride };
}

/**
 * Binarisation de Sauvola.
 *
 * Le seuil d'Otsu est global : un seul reflet sur la moitié droite du code
 * d'extension et cette moitié bascule entièrement en blanc. Sauvola calcule un
 * seuil par pixel à partir de la moyenne et de l'écart-type de son voisinage —
 *
 *     T = m * (1 + k * (s / R - 1))
 *
 * — donc une zone localement claire relève son propre seuil au lieu d'être
 * emportée par le reste de l'image. C'est le remède aux vernis brillants et aux
 * éclairages inégaux, exactement ce qui met l'OCR en échec sur une carte.
 */
export function sauvolaThreshold(gray, width, height, { window, k = 0.2, range = 128 } = {}) {
  // Une fenêtre de l'ordre de la demi-hauteur de la ligne couvre le fût d'une
  // lettre et un peu de fond, ce qu'il faut pour estimer les deux populations.
  const size = window ?? Math.max(15, Math.round(height / 2) | 1);
  const radius = Math.max(1, (size - 1) >> 1);

  const { sum, squares, stride } = integralImages(gray, width, height);
  const out = new Uint8ClampedArray(gray.length);

  for (let y = 0; y < height; y += 1) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height - 1, y + radius);

    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      const count = (bottom - top + 1) * (right - left + 1);

      const a = top * stride + left;
      const b = top * stride + right + 1;
      const c = (bottom + 1) * stride + left;
      const d = (bottom + 1) * stride + right + 1;

      const total = sum[d] - sum[b] - sum[c] + sum[a];
      const totalSquares = squares[d] - squares[b] - squares[c] + squares[a];

      const mean = total / count;
      // La variance peut sortir très légèrement négative en virgule flottante.
      const variance = Math.max(0, totalSquares / count - mean * mean);
      const threshold = mean * (1 + k * (Math.sqrt(variance) / range - 1));

      out[y * width + x] = gray[y * width + x] > threshold ? 255 : 0;
    }
  }

  return out;
}

/**
 * Les variantes de binarisation d'une même image, de la plus probable à la
 * plus improbable.
 *
 * Aucune ne gagne à tous les coups : Otsu est net sur une carte bien éclairée,
 * Sauvola sauve les reflets, et la polarité inverse rattrape les cartes à texte
 * clair sur fond sombre quand l'heuristique d'auto-inversion se trompe — ce
 * qu'elle fait d'autant plus facilement que la zone est petite. On les essaie
 * dans l'ordre et on s'arrête dès qu'une lecture tombe sur une carte réelle.
 */
export function preprocessVariants(gray, width, height, { autoInvert = true } = {}) {
  const otsu = preprocessGray(gray, { autoInvert });
  const local = sauvolaThreshold(gray, width, height);
  const localDark = darkRatio(local) > 0.5 ? invert(local) : local;

  return [
    { label: 'otsu', pixels: otsu.pixels },
    { label: 'sauvola', pixels: localDark },
    { label: 'otsu-inverse', pixels: invert(otsu.pixels) },
    { label: 'sauvola-inverse', pixels: invert(localDark) },
  ];
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
 * Recadre une zone et renvoie ses variantes binarisées, prêtes pour l'OCR.
 *
 * @param {CanvasImageSource} source
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @returns {Array<{label: string, canvas: HTMLCanvasElement}>}
 */
export function cropVariants(source, rect, { scale = UPSCALE, autoInvert = true } = {}) {
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));

  const base = document.createElement('canvas');
  base.width = width;
  base.height = height;

  const context = base.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);

  const gray = toGrayscale(context.getImageData(0, 0, width, height));

  return preprocessVariants(gray, width, height, { autoInvert }).map(({ label, pixels }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const target = canvas.getContext('2d');
    const imageData = target.createImageData(width, height);
    grayToImageData(pixels, width, height, imageData);
    target.putImageData(imageData, 0, 0);
    return { label, canvas };
  });
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
