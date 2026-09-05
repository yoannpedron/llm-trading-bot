/**
 * Identification d'une carte par son illustration.
 *
 * Lire une inscription de deux millimètres restera toujours le maillon
 * fragile. L'illustration, elle, occupe la moitié de la carte : on la
 * reconnaît à trente centimètres, de travers, sous un reflet. C'est ainsi que
 * procèdent les applications de référence — l'image identifie la carte, le
 * code d'extension ne sert qu'à distinguer les tirages.
 *
 * Trois empreintes par carte, calculées sur l'illustration redressée :
 *
 *   - **vignette** 16×16 en gris, centrée-réduite : comparée par corrélation.
 *     Insensible à la luminosité et au contraste, tolérante au flou ;
 *   - **empreinte DCT** 64 bits (pHash) : la structure des basses fréquences,
 *     comparée par distance de Hamming. Résiste au gamma et à la compression ;
 *   - **couleur** 4×4 cellules en RVB : tranche entre deux illustrations de
 *     même structure (les cartes en série partagent souvent la composition).
 *
 * Les fonctions du coeur travaillent sur des tableaux d'octets bruts et sont
 * testables sous Node. Tout est déterministe : deux exécutions rendent la
 * même empreinte au bit près, ce qui rend l'index reproductible.
 */

import { toGrayscale } from './preprocess.js';

/** Proportions d'une carte : 59 × 86 mm. */
export const CARTE_RATIO = 59 / 86;

/** Taille canonique d'une carte redressée, en pixels (rapport 59:86). */
export const CARTE_LARGEUR = 268;
export const CARTE_HAUTEUR = 391;

/**
 * Cadre de l'illustration, en fractions de la largeur et de la hauteur de la
 * carte. Relevé sur les visuels officiels (813×1185) : la position est fixe
 * par famille de cadre — les monstres Pendule ont une illustration plus large
 * et moins haute, au-dessus de leur zone d'effet Pendule.
 */
export const CADRE_ART = {
  standard: { x: 0.096, y: 0.166, w: 0.808, h: 0.557 },
  pendulum: { x: 0.055, y: 0.166, w: 0.89, h: 0.45 },
};

/** Famille de cadre d'après le `frameType` YGOPRODeck. */
export const familleCadre = (frameType) =>
  String(frameType ?? '').includes('pendulum') ? 'pendulum' : 'standard';

/**
 * Marge intérieure retirée du cadre avant de calculer l'empreinte.
 *
 * Le redressement n'est jamais parfait à quelques pixels près : une marge de
 * 6 % de chaque côté fait que l'empreinte ne dépend pas du liseré du cadre,
 * dont la position varie plus que l'illustration elle-même.
 */
export const MARGE_ART = 0.1;

/** Zone de l'illustration dans une carte redressée, en pixels. */
export function zoneArt(famille, largeur = CARTE_LARGEUR, hauteur = CARTE_HAUTEUR) {
  const cadre = CADRE_ART[famille] ?? CADRE_ART.standard;
  const mx = cadre.w * MARGE_ART;
  const my = cadre.h * MARGE_ART;
  return {
    x: Math.round((cadre.x + mx) * largeur),
    y: Math.round((cadre.y + my) * hauteur),
    width: Math.round((cadre.w - 2 * mx) * largeur),
    height: Math.round((cadre.h - 2 * my) * hauteur),
  };
}

/** Côté de la vignette et de la grille DCT. */
export const VIGNETTE = 16;
export const DCT = 32;
export const CELLULES = 4;

/**
 * Réduction par moyenne de zone d'une image vers `tw × th`.
 *
 * La moyenne de zone — et non le plus proche voisin — fait que chaque pixel de
 * sortie résume tout le bloc qu'il couvre : c'est ce qui rend l'empreinte
 * stable au bruit et aux petits décalages.
 */
export function reduire(pixels, width, height, tw, th, canaux = 1) {
  const out = new Float32Array(tw * th * canaux);
  for (let ty = 0; ty < th; ty += 1) {
    const y0 = Math.floor((ty * height) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / th));
    for (let tx = 0; tx < tw; tx += 1) {
      const x0 = Math.floor((tx * width) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / tw));
      const n = (y1 - y0) * (x1 - x0);
      for (let c = 0; c < canaux; c += 1) {
        let somme = 0;
        for (let y = y0; y < y1; y += 1) {
          for (let x = x0; x < x1; x += 1) somme += pixels[(y * width + x) * canaux + c];
        }
        out[(ty * tw + tx) * canaux + c] = somme / n;
      }
    }
  }
  return out;
}

/** Vignette centrée-réduite, sur 8 bits (128 = moyenne, ±3 écarts-types). */
export function vignette(gray, width, height, cote = VIGNETTE) {
  const petite = reduire(gray, width, height, cote, cote);
  let moyenne = 0;
  for (const v of petite) moyenne += v;
  moyenne /= petite.length;
  let variance = 0;
  for (const v of petite) variance += (v - moyenne) ** 2;
  const ecart = Math.sqrt(variance / petite.length) || 1;
  const out = new Uint8Array(petite.length);
  for (let i = 0; i < petite.length; i += 1) {
    out[i] = Math.max(0, Math.min(255, Math.round(128 + ((petite[i] - moyenne) / ecart) * 40)));
  }
  return out;
}

const cosinus = new Map();
function tableCosinus(n) {
  if (!cosinus.has(n)) {
    const t = new Float32Array(n * n);
    for (let u = 0; u < n; u += 1) {
      for (let x = 0; x < n; x += 1) t[u * n + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n));
    }
    cosinus.set(n, t);
  }
  return cosinus.get(n);
}

/**
 * Empreinte DCT (pHash) : 64 bits.
 *
 * Réduction à 32×32, DCT-II, on garde le bloc 8×8 des basses fréquences hors
 * composante continue, et chaque bit dit si le coefficient dépasse la médiane.
 */
export function empreinteDct(gray, width, height) {
  const n = DCT;
  const petite = reduire(gray, width, height, n, n);
  const t = tableCosinus(n);
  // DCT séparable : lignes, puis colonnes, mais seulement les 8 premières fréquences.
  const lignes = new Float32Array(n * 8);
  for (let y = 0; y < n; y += 1) {
    for (let u = 0; u < 8; u += 1) {
      let s = 0;
      for (let x = 0; x < n; x += 1) s += petite[y * n + x] * t[u * n + x];
      lignes[y * 8 + u] = s;
    }
  }
  const coeffs = new Float32Array(64);
  for (let v = 0; v < 8; v += 1) {
    for (let u = 0; u < 8; u += 1) {
      let s = 0;
      for (let y = 0; y < n; y += 1) s += lignes[y * 8 + u] * t[v * n + y];
      coeffs[v * 8 + u] = s;
    }
  }
  // Médiane hors composante continue (coeffs[0]).
  const tri = Array.from(coeffs.subarray(1)).sort((a, b) => a - b);
  const mediane = (tri[31] + tri[32]) / 2;
  const bits = new Uint8Array(8);
  for (let i = 1; i < 64; i += 1) {
    if (coeffs[i] > mediane) bits[i >> 3] |= 1 << (i & 7);
  }
  return bits;
}

/** Couleur moyenne par cellule, 4×4×3 octets. */
export function couleurs(rgba, width, height, cellules = CELLULES) {
  const rgb = new Uint8ClampedArray(width * height * 3);
  for (let p = 0, i = 0; p < width * height; p += 1, i += 4) {
    rgb[p * 3] = rgba[i];
    rgb[p * 3 + 1] = rgba[i + 1];
    rgb[p * 3 + 2] = rgba[i + 2];
  }
  const petite = reduire(rgb, width, height, cellules, cellules, 3);
  const out = new Uint8Array(petite.length);
  for (let i = 0; i < petite.length; i += 1) out[i] = Math.round(petite[i]);
  return out;
}

/** Octets d'une empreinte complète : 8 (DCT) + 256 (vignette) + 48 (couleur). */
export const TAILLE_EMPREINTE = 8 + VIGNETTE * VIGNETTE + CELLULES * CELLULES * 3;

/**
 * Empreinte d'une illustration, depuis son ImageData.
 * @returns {Uint8Array} `TAILLE_EMPREINTE` octets
 */
export function empreinte(imageData) {
  const { data, width, height } = imageData;
  const gray = toGrayscale(imageData);
  const out = new Uint8Array(TAILLE_EMPREINTE);
  out.set(empreinteDct(gray, width, height), 0);
  out.set(vignette(gray, width, height), 8);
  out.set(couleurs(data, width, height), 8 + VIGNETTE * VIGNETTE);
  return out;
}

const POIDS_BITS = new Uint8Array(256).map((_, v) => {
  let n = 0;
  for (let b = v; b; b >>= 1) n += b & 1;
  return n;
});

/** Pondération des trois empreintes, réglée sur le banc (`scripts/art-bench.mjs`). */
export const POIDS = { vignette: 0.6, dct: 0.25, couleur: 0.15 };

/**
 * Similarité entre deux empreintes, dans [0, 1].
 */
export function similarite(a, b, offsetA = 0, offsetB = 0, poids = POIDS) {
  let hamming = 0;
  for (let i = 0; i < 8; i += 1) hamming += POIDS_BITS[a[offsetA + i] ^ b[offsetB + i]];
  const dct = 1 - hamming / 64;

  // Corrélation des vignettes (déjà centrées-réduites autour de 128).
  let produit = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < VIGNETTE * VIGNETTE; i += 1) {
    const va = a[offsetA + 8 + i] - 128;
    const vb = b[offsetB + 8 + i] - 128;
    produit += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  const correlation = na && nb ? produit / Math.sqrt(na * nb) : 0;

  let dist = 0;
  const debut = 8 + VIGNETTE * VIGNETTE;
  for (let i = 0; i < CELLULES * CELLULES * 3; i += 1) {
    dist += Math.abs(a[offsetA + debut + i] - b[offsetB + debut + i]);
  }
  const couleur = 1 - dist / (CELLULES * CELLULES * 3 * 255);

  return poids.vignette * Math.max(0, correlation) + poids.dct * dct + poids.couleur * couleur;
}

/**
 * Index d'empreintes : un tableau plat, une empreinte par carte, dans l'ordre
 * de `ids`. C'est la forme sérialisée (`art-index.bin`) et la forme en mémoire.
 */
export function construireIndexArt(entrees) {
  const ids = new Int32Array(entrees.length);
  const empreintes = new Uint8Array(entrees.length * TAILLE_EMPREINTE);
  entrees.forEach(({ id, empreinte: e }, i) => {
    ids[i] = id;
    empreintes.set(e, i * TAILLE_EMPREINTE);
  });
  return { ids, empreintes, taille: entrees.length };
}

/** Sérialise l'index : [n:uint32][ids:int32×n][empreintes]. */
export function serialiserIndexArt(index) {
  const out = new Uint8Array(4 + index.taille * 4 + index.empreintes.length);
  const vue = new DataView(out.buffer);
  vue.setUint32(0, index.taille, true);
  for (let i = 0; i < index.taille; i += 1) vue.setInt32(4 + i * 4, index.ids[i], true);
  out.set(index.empreintes, 4 + index.taille * 4);
  return out;
}

export function lireIndexArt(buffer) {
  const vue = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const base = buffer instanceof ArrayBuffer ? 0 : buffer.byteOffset;
  const taille = vue.getUint32(base, true);
  const ids = new Int32Array(taille);
  for (let i = 0; i < taille; i += 1) ids[i] = vue.getInt32(base + 4 + i * 4, true);
  const empreintes = new Uint8Array(vue.buffer, base + 4 + taille * 4, taille * TAILLE_EMPREINTE);
  return { ids, empreintes, taille };
}

/** Distance de Hamming entre les empreintes DCT (8 octets) de deux entrées. */
function hamming(a, offsetA, b, offsetB) {
  let h = 0;
  for (let i = 0; i < 8; i += 1) h += POIDS_BITS[a[offsetA + i] ^ b[offsetB + i]];
  return h;
}

/** Taille de la présélection par empreinte DCT avant le score complet. */
export const PRESELECTION = 384;

/**
 * Meilleures correspondances d'une empreinte dans l'index.
 *
 * Deux étages : la distance de Hamming sur l'empreinte DCT (8 octets, une
 * poignée d'opérations par carte) présélectionne `PRESELECTION` cartes, puis
 * le score complet les départage. Mesuré : la bonne carte est dans les 384
 * premières par Hamming dans 99 % des cas où elle est en tête au score
 * complet, pour un coût divisé par dix — ce qui permet d'évaluer des dizaines
 * d'hypothèses de contour par image.
 *
 * @returns {Array<{id: number, score: number}>} triées par score décroissant
 */
export function chercher(index, e, k = 5, poids = POIDS, preselection = PRESELECTION) {
  const n = index.taille;
  let candidats;
  if (preselection && preselection < n) {
    // Histogramme des distances (0..64) pour trouver le seuil qui garde
    // `preselection` cartes, sans tri.
    const distances = new Uint8Array(n);
    const histo = new Uint32Array(65);
    for (let i = 0; i < n; i += 1) {
      const h = hamming(e, 0, index.empreintes, i * TAILLE_EMPREINTE);
      distances[i] = h;
      histo[h] += 1;
    }
    let seuil = 0;
    let cumul = 0;
    while (seuil < 64 && cumul + histo[seuil] < preselection) {
      cumul += histo[seuil];
      seuil += 1;
    }
    candidats = [];
    for (let i = 0; i < n; i += 1) if (distances[i] <= seuil) candidats.push(i);
  } else {
    candidats = null;
  }

  const meilleurs = [];
  const total = candidats ? candidats.length : n;
  for (let c = 0; c < total; c += 1) {
    const i = candidats ? candidats[c] : c;
    const score = similarite(e, index.empreintes, 0, i * TAILLE_EMPREINTE, poids);
    if (meilleurs.length < k || score > meilleurs[meilleurs.length - 1].score) {
      // Une carte peut avoir plusieurs empreintes dans l'index (variantes de
      // cadrage) : on ne garde que sa meilleure.
      const id = index.ids[i];
      const deja = meilleurs.findIndex((m) => m.id === id);
      if (deja >= 0) {
        if (meilleurs[deja].score >= score) continue;
        meilleurs.splice(deja, 1);
      }
      meilleurs.push({ id, score });
      meilleurs.sort((x, y) => y.score - x.score);
      if (meilleurs.length > k) meilleurs.pop();
    }
  }
  return meilleurs;
}
