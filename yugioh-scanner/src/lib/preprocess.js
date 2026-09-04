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
/**
 * Lissage par boîte séparable, en deux passes (≈ gaussien).
 *
 * Pourquoi lisser une image qu'on veut nette : à la distance du mode sniper,
 * le capteur résout la **trame d'impression** de la carte. Les points de
 * demi-teinte deviennent, après seuillage, une poussière noire que Tesseract
 * lit comme des lettres — « REREEEEEEAEREEELARE » sur un code parfaitement
 * lisible à l'œil. Un rayon d'un centième de la hauteur du recadrage efface
 * la trame sans toucher aux traits, dix fois plus larges.
 *
 * Mesuré sur un vrai viseur (`scripts/harness/real-crops.mjs`) : sans lissage
 * aucune binarisation ne lit « STOR-FR040 » ; avec, Sauvola le rend.
 *
 * @param {Uint8ClampedArray} gray
 * @param {number} radius 0 pour ne rien faire
 * @returns {Uint8ClampedArray} nouveau tableau
 */
export function smooth(gray, width, height, radius) {
  if (radius <= 0) return Uint8ClampedArray.from(gray);

  let source = Float32Array.from(gray);
  for (let pass = 0; pass < 2; pass += 1) {
    const rows = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let count = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const xx = x + k;
          if (xx < 0 || xx >= width) continue;
          sum += source[y * width + xx];
          count += 1;
        }
        rows[y * width + x] = sum / count;
      }
    }
    const columns = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let count = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const yy = y + k;
          if (yy < 0 || yy >= height) continue;
          sum += rows[yy * width + x];
          count += 1;
        }
        columns[y * width + x] = sum / count;
      }
    }
    source = columns;
  }

  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < out.length; i += 1) out[i] = Math.round(source[i]);
  return out;
}

/** Taux d'encre en deçà et au-delà desquels une ligne n'est pas du texte. */
const TEXT_ROW_MIN = 0.02;
const TEXT_ROW_MAX = 0.6;

/**
 * Efface l'encre qui touche le bord gauche ou droit de la bande.
 *
 * POURQUOI. Le viseur ne tombe jamais exactement sur le code : il mord sur ce
 * qui l'entoure, et le liseré de la carte laisse un fragment vertical au bord
 * du recadrage. Tesseract le lit comme une lettre. Mesuré sur un vrai
 * recadrage : « MAMA-FR113 » devient « COMAMA-FRIIZ » — le « CO » vient
 * entièrement du bord gauche. Or un préfixe de six caractères sort de la
 * grammaire d'un code d'extension, et la lecture est perdue alors que tout le
 * reste était juste.
 *
 * COMMENT. Un parcours en largeur depuis chaque pixel d'encre des colonnes
 * extrêmes efface la composante connexe à laquelle il appartient.
 *
 * LA GARDE QUI COMPTE. On n'efface QUE les composantes plus étroites qu'un
 * vrai caractère. Un fragment de bordure est un trait fin et haut ; une lettre
 * est large d'environ la moitié de sa hauteur. Sans cette garde, un code
 * légèrement décadré perdrait son premier ou son dernier caractère — on
 * remplacerait un faux positif par un autre.
 *
 * @param {Uint8ClampedArray} binary 0 pour l'encre, 255 pour le fond
 * @param {{largeurMax?: number}} options largeur maximale d'une composante
 *   effaçable, en fraction de la hauteur de la bande
 * @returns {Uint8ClampedArray} nouveau tableau
 */
export function stripEdgeInk(binary, width, height, { largeurMax = 0.34 } = {}) {
  const out = Uint8ClampedArray.from(binary);
  if (width < 3 || height < 3) return out;

  const seuilLargeur = Math.max(2, Math.round(height * largeurMax));
  const vus = new Uint8Array(width * height);

  const composante = (departX, departY) => {
    const pile = [departY * width + departX];
    const pixels = [];
    let minX = departX;
    let maxX = departX;

    while (pile.length > 0) {
      const index = pile.pop();
      if (vus[index]) continue;
      vus[index] = 1;
      if (out[index] !== 0) continue;

      const x = index % width;
      const y = (index - x) / width;
      pixels.push(index);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;

      // Huit voisins : un liseré en diagonale reste une seule composante.
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const vx = x + dx;
          const vy = y + dy;
          if (vx < 0 || vx >= width || vy < 0 || vy >= height) continue;
          const voisin = vy * width + vx;
          if (!vus[voisin] && out[voisin] === 0) pile.push(voisin);
        }
      }
    }

    // Assez étroite pour n'être pas un caractère : on l'efface.
    if (maxX - minX + 1 <= seuilLargeur) {
      for (const index of pixels) out[index] = 255;
    }
  };

  for (let y = 0; y < height; y += 1) {
    if (out[y * width] === 0) composante(0, y);
    if (out[y * width + width - 1] === 0) composante(width - 1, y);
  }
  return out;
}

/**
 * Bande de lignes qui porte le texte, dans une image binarisée.
 *
 * Le viseur est plus haut que le code : sur un téléphone au conteneur court,
 * il embarque la bordure du cadre de la carte, qui devient après seuillage un
 * bloc noir de la moitié de l'image. PSM 6 s'obstine alors à y lire des
 * lettres et rend du bruit. On ne garde que la plus longue suite de lignes
 * dont le taux d'encre est celui d'un texte : ni vide, ni aplat.
 *
 * C'est aussi un premier pas vers le redressement par profil de projection.
 *
 * @param {Uint8ClampedArray} binary 0 pour l'encre, 255 pour le fond
 * @param {{pad?: number}} options marge ajoutée de part et d'autre, en
 *   fraction de la hauteur de la bande
 * @returns {{top: number, bottom: number}} lignes incluses ; l'image entière
 *   si rien ne ressemble à du texte
 */
export function textBand(binary, width, height, { pad = 0.2 } = {}) {
  const ratios = new Float32Array(height);
  for (let y = 0; y < height; y += 1) {
    let ink = 0;
    for (let x = 0; x < width; x += 1) if (binary[y * width + x] === 0) ink += 1;
    ratios[y] = ink / width;
  }

  let best = null;
  let start = null;
  for (let y = 0; y <= height; y += 1) {
    const textual = y < height && ratios[y] > TEXT_ROW_MIN && ratios[y] < TEXT_ROW_MAX;
    if (textual && start === null) start = y;
    if (!textual && start !== null) {
      if (best === null || y - start > best.bottom - best.top + 1) best = { top: start, bottom: y - 1 };
      start = null;
    }
  }
  if (best === null) return { top: 0, bottom: height - 1 };

  const margin = Math.round((best.bottom - best.top + 1) * pad);
  return { top: Math.max(0, best.top - margin), bottom: Math.min(height - 1, best.bottom + margin) };
}

export function preprocessVariants(
  gray,
  width,
  height,
  {
    autoInvert = true,
    smoothRadius = Math.round(height / 120),
    smoothOtsu = false,
    /**
     * Gris déjà lissé, fourni par l'appelant.
     *
     * `cropVariants` obtient ce lissage du canvas, dont le flou est natif :
     * mesuré 9 ms là où la double passe en JavaScript en coûte 30 sur la même
     * image. Quand il est absent — les tests appellent cette fonction
     * directement — on retombe sur `smooth()`.
     */
    smoothed = null,
    /** Variantes à produire. Les autres ne sont pas calculées du tout. */
    only = null,
  } = {},
) {
  // Le lissage ne sert qu'à Sauvola. Otsu ne lit de toute façon pas une vraie
  // carte de près (bordure et trame ruinent un seuil global), mais il lit une
  // image propre mieux que quiconque — et le lissage lui coûte alors un
  // caractère (« RA03 » devient « RAO03 » sur la caméra simulée). Chaque
  // binarisation garde donc le terrain où elle gagne.
  const veut = (label) => !only || only.includes(label);
  const besoinSauvola = veut('sauvola') || veut('sauvola-inverse');
  const besoinOtsu = veut('otsu') || veut('otsu-inverse');

  const lisse = besoinSauvola || smoothOtsu ? (smoothed ?? smooth(gray, width, height, smoothRadius)) : gray;
  const otsu = besoinOtsu ? preprocessGray(smoothOtsu ? lisse : gray, { autoInvert }) : null;
  const local = besoinSauvola ? sauvolaThreshold(lisse, width, height) : null;
  const localDark = local ? (darkRatio(local) > 0.5 ? invert(local) : local) : null;

  // `trim` : la variante accepte d'être rognée à sa ligne de texte. Réservé à
  // Sauvola, pour la même raison que le lissage : Otsu reste la lecture de
  // référence d'une image propre, et le rognage lui a fait perdre le
  // verrouillage sur la caméra simulée alors qu'il sauve Sauvola sur une
  // vraie carte dont la bordure entre dans le viseur.
  //
  // L'ORDRE EST CELUI DE LA MESURE, PAS DE L'HABITUDE.
  //
  // `scripts/ocr-bench.mjs`, sur les trois recadrages réels de
  // `scripts/fixtures/` : Sauvola retrouve la carte dans deux cas sur trois et
  // coûte 50 ms de reconnaissance ; Otsu n'en retrouve AUCUN et coûte 230 à
  // 361 ms — cinq à sept fois plus, parce que Tesseract passe son temps à
  // tenter de segmenter du bruit. Otsu reste néanmoins utile sur une image
  // très propre et très contrastée, où il est excellent : on le garde, mais
  // en dernier recours et seulement s'il reste du temps dans le tour.
  const toutes = [
    { label: 'sauvola', pixels: localDark, trim: true },
    { label: 'sauvola-inverse', pixels: localDark ? invert(localDark) : null, trim: true },
    { label: 'otsu', pixels: otsu?.pixels ?? null, trim: false },
    { label: 'otsu-inverse', pixels: otsu ? invert(otsu.pixels) : null, trim: false },
  ];
  return toutes.filter((variante) => variante.pixels !== null && veut(variante.label));
}

/**
 * Hauteur de bande visée avant reconnaissance, en pixels.
 *
 * Tesseract lit le mieux une ligne dont les capitales font trente à cinquante
 * pixels ; au-delà, il ne gagne rien et paie chaque pixel. Le réglage
 * précédent visait 240 px de bande, soit environ 120 px de capitale — mesuré :
 * la configuration la PLUS LENTE et la MOINS fiable des quatre essayées.
 *
 *     bande   agrandissement   reconnaissance   cartes retrouvées
 *      102          ×1,5            50 ms             2/3
 *      136          ×2              41 ms             1/3
 *      170          ×2,5            72 ms             2/3
 *      238          ×3,5           109 ms             1/3
 *
 * On vise donc 110, et l'on ne réduit jamais en deçà de la taille native :
 * jeter des pixels que le capteur a réellement produits ne se rattrape pas.
 */
export const BANDE_VISEE = 110;

/** Agrandissement à appliquer à un recadrage pour viser cette bande. */
export const echelleDeLecture = (hauteurRecadrage) =>
  Math.max(1, Math.min(4, BANDE_VISEE / Math.max(1, hauteurRecadrage)));

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
 * @returns {Array<{label: string, canvas: HTMLCanvasElement}>} porte aussi une
 *   propriété `sharpness`, mesurée avant binarisation.
 */
export function cropVariants(
  source,
  rect,
  {
    scale = UPSCALE,
    autoInvert = true,
    smoothRadius,
    smoothOtsu,
    trimToLine = true,
    stripEdges = true,
    only = null,
  } = {},
) {
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));

  // La netteté se mesure sur un recadrage **1:1**, jamais sur l'agrandissement :
  // l'interpolation bilinéaire adoucit précisément les contours dont on mesure
  // la vigueur, et la note dépendrait alors du facteur d'échelle — donc de la
  // résolution du capteur. Elle ne serait plus comparable d'un appareil à l'autre.
  const focus = measureSharpness(source, rect);

  const base = document.createElement('canvas');
  base.width = width;
  base.height = height;

  const context = base.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);

  const gray = toGrayscale(context.getImageData(0, 0, width, height));

  // Le flou passe par le canvas : le navigateur l'exécute en natif, trois fois
  // plus vite que la double passe en JavaScript, pour un résultat identique à
  // trois dixièmes de pour cent de pixels près (mesuré). C'est le poste de
  // prétraitement le plus lourd, on ne le laisse pas au JavaScript.
  const rayon = smoothRadius ?? Math.round(height / 120);
  let smoothed = null;
  if (rayon > 0) {
    const flou = document.createElement('canvas');
    flou.width = width;
    flou.height = height;
    const dessin = flou.getContext('2d', { willReadFrequently: true });
    dessin.filter = `blur(${rayon}px)`;
    dessin.imageSmoothingEnabled = true;
    dessin.imageSmoothingQuality = 'high';
    dessin.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
    dessin.filter = 'none';
    smoothed = toGrayscale(dessin.getImageData(0, 0, width, height));
  }

  const options = { autoInvert, smoothed, only };
  if (smoothRadius !== undefined) options.smoothRadius = smoothRadius;
  if (smoothOtsu !== undefined) options.smoothOtsu = smoothOtsu;

  const variants = preprocessVariants(gray, width, height, options).map(({ label, pixels, trim }) => {
    // La bande se cherche sur la polarité « encre sombre » : sur une variante
    // inversée, le fond est majoritaire et compterait comme de l'encre, et la
    // bande retenue serait une ligne de transition d'un pixel de haut. Vu sur
    // la caméra simulée, où ce sont ces variantes-là qui verrouillaient.
    const sombre = darkRatio(pixels) > 0.5 ? invert(pixels) : pixels;
    const band =
      trimToLine && trim ? textBand(sombre, width, height) : { top: 0, bottom: height - 1 };
    const bandHeight = band.bottom - band.top + 1;

    let bande = pixels.subarray(band.top * width, (band.bottom + 1) * width);

    // Le liseré de la carte, happé par le bord du viseur, devient une lettre
    // fantôme : « MAMA-FR113 » lu « COMAMA-FRIIZ », dont le préfixe à six
    // caractères sort de la grammaire d'un code. On l'efface, sur les mêmes
    // variantes que le rognage — celles dont on sait qu'elles portent l'encre
    // en sombre après normalisation.
    if (stripEdges && trim) {
      const sombreBande = darkRatio(bande) > 0.5 ? invert(bande) : bande;
      const nettoyee = stripEdgeInk(sombreBande, width, bandHeight);
      bande = darkRatio(bande) > 0.5 ? invert(nettoyee) : nettoyee;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = bandHeight;
    const target = canvas.getContext('2d');
    const imageData = target.createImageData(width, bandHeight);
    grayToImageData(bande, width, bandHeight, imageData);
    target.putImageData(imageData, 0, 0);
    return { label, canvas, band };
  });

  // La netteté est mesurée sur le gris d'origine, avant binarisation : après,
  // tous les bords sont francs et la mesure ne veut plus rien dire.
  return Object.assign(variants, { sharpness: focus });
}

/** Netteté d'une zone, mesurée sans agrandissement. */
function measureSharpness(source, rect) {
  const width = Math.max(3, Math.round(rect.width));
  const height = Math.max(3, Math.round(rect.height));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);

  // Après étirement du contraste : le garde-fou doit mesurer la mise au point,
  // pas le contraste. Sur une carte sombre au code gris sur fond noir, les
  // contours nets ne dépassent pas `EDGE_THRESHOLD` en valeur brute, et
  // l'image était déclarée « trop floue » alors que sa binarisation se lisait
  // à l'œil (vu sur un vrai téléphone, MAMA-FR113).
  const gray = stretchContrast(toGrayscale(context.getImageData(0, 0, width, height)));
  return sharpness(gray, width, height);
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
