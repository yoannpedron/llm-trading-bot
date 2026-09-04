/**
 * Préparation de l'image avant lecture.
 *
 * Le moteur (PP-OCRv6, voir `ocr.js`) est entraîné sur du texte photographié :
 * il lit l'image **brute**, en couleur, avec son reflet et son grain. L'ancienne
 * chaîne — luma, étirement, Otsu, Sauvola, polarités inverses, rognage de la
 * bande de texte, effacement du liseré — existait pour Tesseract, conçu pour
 * des scans à plat ; elle a été mesurée inutile avec le nouveau moteur (les
 * trois recadrages réels se lisent sans elle) et retirée.
 *
 * Il reste deux choses : le recadrage à la résolution native de la vidéo, et
 * la mesure de netteté qui évite de payer une lecture sur une image vide.
 *
 * Les fonctions du coeur travaillent sur des tableaux d'octets bruts : elles
 * n'ont besoin ni du DOM ni d'un canvas, ce qui les rend testables sous Node.
 */

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
 * Seuil de magnitude Sobel en deçà duquel un contour est tenu pour du bruit.
 *
 * Un vrai bord d'encre sur fond clair produit une magnitude de plusieurs
 * centaines ; le bruit d'un capteur de téléphone, quelques dizaines. Ce seuil
 * est toute la différence entre une mesure de netteté et une mesure de bruit.
 */
export const EDGE_THRESHOLD = 100;

/**
 * Netteté, par la méthode de Tenengrad seuillée.
 *
 * Attention au piège : la simple énergie de gradient — la somme des écarts
 * entre voisins — **mesure le bruit autant que la netteté**. Un capteur de
 * téléphone en lumière faible ajoute un grain qui crée d'énormes variations
 * locales, si bien qu'une image floue et bruitée obtient une note plus élevée
 * qu'une image nette et propre. Mesuré ici :
 *
 *     énergie brute   net 0,057 · net+bruit 0,094 · flou+bruit 0,064
 *     Tenengrad       net 2,53  · net+bruit 2,54   · flou+bruit 0,38
 *
 * On ne retient donc que les contours dont la magnitude Sobel dépasse
 * `EDGE_THRESHOLD` : le bruit n'y arrive pas, l'encre oui. La note s'effondre
 * dès que la mise au point se perd — ce qu'on cherche à détecter.
 *
 * @returns {number} 0 pour une image sans contour franc, quelques unités pour
 *   du texte net occupant une bonne part de l'image
 */
export function sharpness(pixels, width, height, { threshold = EDGE_THRESHOLD } = {}) {
  if (width < 3 || height < 3) return 0;

  let total = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const top = (y - 1) * width + x;
      const middle = y * width + x;
      const bottom = (y + 1) * width + x;

      const gx =
        pixels[top + 1] + 2 * pixels[middle + 1] + pixels[bottom + 1] -
        pixels[top - 1] - 2 * pixels[middle - 1] - pixels[bottom - 1];
      const gy =
        pixels[bottom - 1] + 2 * pixels[bottom] + pixels[bottom + 1] -
        pixels[top - 1] - 2 * pixels[top] - pixels[top + 1];

      const magnitude = Math.hypot(gx, gy);
      if (magnitude > threshold) total += magnitude * magnitude;
    }
  }

  return total / ((width - 2) * (height - 2)) / (255 * 255);
}

/**
 * Réécrit un canal unique dans un ImageData RGBA (opaque, gris).

/* ------------------------------------------------------------------ */
/* Partie navigateur : recadrage sur canvas                             */
/* ------------------------------------------------------------------ */

/**
 * Netteté d'une zone, mesurée sans agrandissement.
 *
 * Sur un recadrage **1:1**, jamais sur un agrandissement : l'interpolation
 * adoucit précisément les contours dont on mesure la vigueur, et la note
 * dépendrait alors de la résolution du capteur — plus comparable d'un
 * appareil à l'autre.
 *
 * Après étirement du contraste : le garde-fou doit mesurer la mise au point,
 * pas le contraste. Sur une carte sombre au code gris sur fond noir, les
 * contours nets ne dépassent pas `EDGE_THRESHOLD` en valeur brute, et
 * l'image était déclarée « trop floue » alors qu'elle se lisait à l'œil (vu
 * sur un vrai téléphone, MAMA-FR113).
 */
export function measureSharpness(source, rect) {
  const width = Math.max(3, Math.round(rect.width));
  const height = Math.max(3, Math.round(rect.height));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);

  const gray = stretchContrast(toGrayscale(context.getImageData(0, 0, width, height)));
  return sharpness(gray, width, height);
}

/**
 * Largeur maximale envoyée au moteur.
 *
 * Le viseur recadre dans l'image native : sur un capteur 4K, la fenêtre fait
 * jusqu'à 1 500 px de large pour une inscription de dix caractères. Le moteur
 * redimensionne de toute façon en interne ; on plafonne ici pour borner le
 * transfert vers le worker, sans perte mesurable de lecture.
 */
export const LARGEUR_MAX = 1200;

/**
 * Recadre une zone de la source, telle quelle, à la résolution native.
 *
 * Le recadrage se fait sur la résolution *native* de la vidéo, jamais sur sa
 * taille CSS : sur un téléphone la vidéo est souvent affichée deux fois plus
 * petite qu'elle n'est capturée, et recadrer sur l'affichage jetterait la
 * moitié des pixels utiles.
 *
 * Aucune marge autour de la fenêtre : mesuré sur les recadrages réels, une
 * bordure grise de 24 px fait perdre une carte sur trois au modèle « small »
 * (le détecteur y accroche la bordure).
 *
 * @param {CanvasImageSource} source
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @returns {{canvas: HTMLCanvasElement, sharpness: number}}
 */
export function cropZone(source, rect) {
  const focus = measureSharpness(source, rect);

  const scale = Math.min(1, LARGEUR_MAX / Math.max(1, rect.width));
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);

  return { canvas, sharpness: focus };
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
