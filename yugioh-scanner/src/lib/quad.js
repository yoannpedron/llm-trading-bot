/**
 * Trouver la carte dans l'image, et la redresser.
 *
 * Une carte photographiée est un quadrilatère : quatre bords francs sur un
 * fond quelconque. On cherche ce quadrilatère à basse résolution, on calcule
 * l'homographie qui le ramène à un rectangle 59:86, et l'on rééchantillonne
 * l'image d'origine à travers elle. Tout ce qui suit — empreinte de
 * l'illustration, lecture du code — travaille alors sur une carte vue de face,
 * quelle que soit la façon dont l'utilisateur l'a tenue.
 *
 * Aucune bibliothèque : gradient de Sobel, seuillage, composantes connexes,
 * enveloppe convexe, simplification en quatre sommets. Tout est en JavaScript
 * pur sur des tableaux d'octets, donc testable sous Node.
 */

import { CADRE_ART, CARTE_HAUTEUR, CARTE_LARGEUR, CARTE_RATIO } from './art.js';
import { toGrayscale } from './preprocess.js';

/** Largeur du liseré noir d'une carte, en fraction du petit côté (mesurée sur les rendus officiels). */
export const LISERE = 0.027;

/** Largeur de travail pour la détection : assez pour quatre bords, pas plus. */
export const LARGEUR_DETECTION = 320;

/* ------------------------------------------------------------------ */
/* Homographie                                                          */
/* ------------------------------------------------------------------ */

/**
 * Homographie qui envoie quatre points source sur quatre points cible (DLT).
 * @returns {Float64Array} matrice 3×3 en ligne, h[8] = 1
 */
export function homographie(source, cible) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = source[i];
    const { x: u, y: v } = cible[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  return Float64Array.from([...resoudre(A, b), 1]);
}

/** Élimination de Gauss avec pivot partiel. */
function resoudre(A, b) {
  const n = b.length;
  const M = A.map((ligne, i) => [...ligne, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const p = M[col][col];
    if (Math.abs(p) < 1e-12) throw new Error('points dégénérés');
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = M[r][col] / p;
      for (let c = col; c <= n; c += 1) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((ligne, i) => ligne[n] / ligne[i]);
}

/** Applique une homographie à un point. */
export function projeter(h, { x, y }) {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

/**
 * Rééchantillonne `source` (ImageData) à travers une homographie qui envoie la
 * SORTIE vers la SOURCE (interpolation bilinéaire). Hors de la source : noir.
 */
export function deformer(source, h, largeur, hauteur) {
  const { data, width, height } = source;
  const out = new Uint8ClampedArray(largeur * hauteur * 4);
  for (let y = 0; y < hauteur; y += 1) {
    for (let x = 0; x < largeur; x += 1) {
      const w = h[6] * x + h[7] * y + h[8];
      const sx = (h[0] * x + h[1] * y + h[2]) / w;
      const sy = (h[3] * x + h[4] * y + h[5]) / w;
      const o = (y * largeur + x) * 4;
      out[o + 3] = 255;
      if (sx < 0 || sy < 0 || sx >= width - 1 || sy >= height - 1) continue;
      const x0 = sx | 0;
      const y0 = sy | 0;
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * width + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + width * 4;
      const i11 = i01 + 4;
      for (let c = 0; c < 3; c += 1) {
        const haut = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
        const bas = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
        out[o + c] = haut * (1 - fy) + bas * fy;
      }
    }
  }
  return { data: out, width: largeur, height: hauteur };
}

/* ------------------------------------------------------------------ */
/* Détection du quadrilatère                                            */
/* ------------------------------------------------------------------ */

/**
 * Magnitude et orientation de Sobel. L'orientation est celle du gradient,
 * dans [0, π), et n'est calculée que là où la magnitude dépasse 3 % du
 * maximum : `atan2` coûte plus que tout le reste du filtre, et seuls les
 * pixels de contour votent (mesuré : 32 ms → 12 ms à 448×796).
 */
export function sobel(gray, width, height) {
  const magnitude = new Float32Array(width * height);
  const gxs = new Int16Array(width * height);
  const gys = new Int16Array(width * height);
  let max = 0;
  for (let y = 1; y < height - 1; y += 1) {
    const l0 = (y - 1) * width;
    const l1 = y * width;
    const l2 = (y + 1) * width;
    for (let x = 1; x < width - 1; x += 1) {
      const a = gray[l0 + x - 1];
      const b = gray[l0 + x];
      const c = gray[l0 + x + 1];
      const d = gray[l1 + x - 1];
      const f = gray[l1 + x + 1];
      const g = gray[l2 + x - 1];
      const h = gray[l2 + x];
      const i = gray[l2 + x + 1];
      const gx = c + 2 * f + i - a - 2 * d - g;
      const gy = g + 2 * h + i - a - 2 * b - c;
      const m = Math.sqrt(gx * gx + gy * gy);
      const k = l1 + x;
      magnitude[k] = m;
      gxs[k] = gx;
      gys[k] = gy;
      if (m > max) max = m;
    }
  }
  const orientation = new Float32Array(width * height);
  const seuil = max * 0.03;
  for (let k = 0; k < magnitude.length; k += 1) {
    if (magnitude[k] < seuil) continue;
    let a = Math.atan2(gys[k], gxs[k]);
    if (a < 0) a += Math.PI;
    orientation[k] = a;
  }
  return { magnitude, orientation };
}

/**
 * Flou 3×3 en boîte, pour ne pas voter avec le grain du capteur. Séparable :
 * une passe horizontale, une passe verticale, trois lectures par pixel
 * chacune, bords répétés.
 */
export function flouter(gray, width, height) {
  const tmp = new Uint16Array(gray.length);
  for (let y = 0; y < height; y += 1) {
    const l = y * width;
    for (let x = 0; x < width; x += 1) {
      const g = gray[l + (x > 0 ? x - 1 : 0)];
      const d = gray[l + (x < width - 1 ? x + 1 : width - 1)];
      tmp[l + x] = g + gray[l + x] + d;
    }
  }
  const out = new Uint8ClampedArray(gray.length);
  for (let y = 0; y < height; y += 1) {
    const h = (y > 0 ? y - 1 : 0) * width;
    const m = y * width;
    const b = (y < height - 1 ? y + 1 : height - 1) * width;
    for (let x = 0; x < width; x += 1) out[m + x] = (tmp[h + x] + tmp[m + x] + tmp[b + x]) / 9;
  }
  return out;
}

/** Seuil : les `fraction` pixels aux gradients les plus forts votent. */
export function seuilGradient(magnitude, fraction = 0.15) {
  const histogramme = new Uint32Array(1024);
  let max = 0;
  for (const v of magnitude) if (v > max) max = v;
  if (max === 0) return Infinity;
  for (const v of magnitude) histogramme[Math.min(1023, Math.floor((v / max) * 1023))] += 1;
  let cumul = 0;
  const cible = magnitude.length * fraction;
  for (let i = 1023; i >= 0; i -= 1) {
    cumul += histogramme[i];
    if (cumul >= cible) return (i / 1023) * max;
  }
  return 0;
}

const THETA_BINS = 180;
const DEG = Math.PI / 180;

/**
 * Transformée de Hough des contours, pondérée par le gradient.
 *
 * Chaque pixel de contour ne vote que pour les droites perpendiculaires à
 * son gradient (±6°) : c'est dix fois moins de votes qu'un balayage complet,
 * et surtout beaucoup moins de fausses droites — un pixel de texture ne vote
 * plus pour cent orientations.
 *
 * @returns {Array<{theta:number, rho:number, poids:number}>} les `n` droites
 *   les plus soutenues, après suppression des voisines
 */
export function droitesHough(magnitude, orientation, width, height, { fraction = 0.15, n = 24, puissance = 1 } = {}) {
  const diag = Math.ceil(Math.hypot(width, height));
  const rhoBins = 2 * diag + 1;
  const acc = new Float32Array(THETA_BINS * rhoBins);
  const seuil = seuilGradient(magnitude, fraction);
  const cosT = new Float32Array(THETA_BINS);
  const sinT = new Float32Array(THETA_BINS);
  for (let t = 0; t < THETA_BINS; t += 1) {
    cosT[t] = Math.cos(t * DEG);
    sinT[t] = Math.sin(t * DEG);
  }
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const m = magnitude[i];
      if (m < seuil) continue;
      // Le poids du vote : m, ou m² pour favoriser les bords francs (une
      // carte) face aux longues lignes pâles (une trame de nappe).
      const vote = puissance === 1 ? m : m ** puissance;
      // La droite du contour a pour normale le gradient : theta = orientation.
      const centre = Math.round(orientation[i] / DEG);
      for (let dt = -6; dt <= 6; dt += 1) {
        const t = (centre + dt + THETA_BINS) % THETA_BINS;
        const rho = Math.round(x * cosT[t] + y * sinT[t]) + diag;
        acc[t * rhoBins + rho] += vote;
      }
    }
  }

  // Pics, avec suppression des voisins (±4°, ±6 px). Une seule passe pour
  // ramasser les cases qui valent au moins un dixième du maximum (quelques
  // milliers), triées, puis la suppression dans l'ordre. Une première
  // version rebalayait l'accumulateur entier (330 000 cases) pour chaque pic :
  // 24 balayages, 8 millions de lectures, la moitié du temps de détection.
  let max = 0;
  for (let i = 0; i < acc.length; i += 1) if (acc[i] > max) max = acc[i];
  if (max === 0) return [];
  const seuilPic = max * 0.1;
  const cases = [];
  for (let i = 0; i < acc.length; i += 1) if (acc[i] >= seuilPic) cases.push(i);
  cases.sort((a, b) => acc[b] - acc[a]);

  const droites = [];
  const pris = new Uint8Array(acc.length);
  for (const i of cases) {
    if (droites.length >= n) break;
    if (pris[i]) continue;
    const t = Math.floor(i / rhoBins);
    const r = i % rhoBins;
    droites.push({ theta: t * DEG, rho: r - diag, poids: acc[i] });
    for (let dt = -4; dt <= 4; dt += 1) {
      const tt = (t + dt + THETA_BINS) % THETA_BINS;
      for (let dr = -6; dr <= 6; dr += 1) {
        const rr = r + dr;
        if (rr >= 0 && rr < rhoBins) pris[tt * rhoBins + rr] = 1;
      }
    }
  }
  return droites;
}

/** Intersection de deux droites (rho, theta) ; null si parallèles. */
export function intersection(a, b) {
  const det = Math.cos(a.theta) * Math.sin(b.theta) - Math.sin(a.theta) * Math.cos(b.theta);
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (a.rho * Math.sin(b.theta) - b.rho * Math.sin(a.theta)) / det,
    y: (b.rho * Math.cos(a.theta) - a.rho * Math.cos(b.theta)) / det,
  };
}

/** Écart angulaire entre deux droites, dans [0, π/2]. */
const ecartAngle = (a, b) => {
  let d = Math.abs(a.theta - b.theta) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
};

/** Aire d'un polygone (formule du lacet), positive. */
export function aire(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** Vrai si le quadrilatère est convexe (tous les produits vectoriels de même signe). */
export function convexe(coins) {
  let signe = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = coins[i];
    const b = coins[(i + 1) % 4];
    const c = coins[(i + 2) % 4];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-9) return false;
    if (signe === 0) signe = Math.sign(z);
    else if (Math.sign(z) !== signe) return false;
  }
  return true;
}

/**
 * Ordonne quatre coins : haut-gauche, haut-droit, bas-droit, bas-gauche, dans
 * le repère image, le petit côté en haut (portrait). Une carte tenue en
 * paysage est ramenée en portrait ; l'orientation haut/bas se règle ensuite.
 */
export function ordonner(coins) {
  const cx = coins.reduce((s, p) => s + p.x, 0) / 4;
  const cy = coins.reduce((s, p) => s + p.y, 0) / 4;
  const tri = [...coins].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let depart = 0;
  for (let i = 1; i < 4; i += 1) if (tri[i].x + tri[i].y < tri[depart].x + tri[depart].y) depart = i;
  const ordre = [0, 1, 2, 3].map((i) => tri[(depart + i) % 4]);
  const largeur = Math.hypot(ordre[1].x - ordre[0].x, ordre[1].y - ordre[0].y);
  const hauteur = Math.hypot(ordre[3].x - ordre[0].x, ordre[3].y - ordre[0].y);
  return largeur > hauteur ? [ordre[1], ordre[2], ordre[3], ordre[0]] : ordre;
}

const cote = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * Soutien d'un côté par les contours : moyenne, le long du segment, du
 * gradient maximal dans un voisinage de ±2 px, rapportée au gradient
 * maximal de l'image. Dans [0, 1].
 */
function soutien(magnitude, width, height, a, b, max) {
  // 20 points par côté, maximum dans un voisinage de ±1 px : mesuré, la même
  // précision qu'avec 32 points et ±2 px, pour six fois moins de lectures —
  // et ce calcul se fait sur plus de mille candidats par image.
  const n = 20;
  let total = 0;
  for (let k = 0; k <= n; k += 1) {
    const x = Math.round(a.x + ((b.x - a.x) * k) / n);
    const y = Math.round(a.y + ((b.y - a.y) * k) / n);
    let local = 0;
    for (let dy = -1; dy <= 1; dy += 1) {
      const yy = y + dy;
      if (yy < 0 || yy >= height) continue;
      const l = yy * width;
      for (let dx = -1; dx <= 1; dx += 1) {
        const xx = x + dx;
        if (xx < 0 || xx >= width) continue;
        const m = magnitude[l + xx];
        if (m > local) local = m;
      }
    }
    total += local;
  }
  return total / ((n + 1) * max);
}

/**
 * Richesse de l'intérieur d'un quadrilatère : gradient moyen sur une grille
 * de points intérieurs, rapporté au gradient maximal de l'image. Une carte
 * est pleine de dessin et de texte ; une case de nappe, une boîte, un
 * téléphone posé sur la table sont plats à l'intérieur.
 */
function richesse(magnitude, width, height, coins, max) {
  let total = 0;
  let n = 0;
  for (let v = 0.1; v <= 0.9; v += 0.1) {
    for (let u = 0.1; u <= 0.9; u += 0.1) {
      // Interpolation bilinéaire des coins (approximation suffisante).
      const x = (1 - v) * ((1 - u) * coins[0].x + u * coins[1].x) + v * ((1 - u) * coins[3].x + u * coins[2].x);
      const y = (1 - v) * ((1 - u) * coins[0].y + u * coins[1].y) + v * ((1 - u) * coins[3].y + u * coins[2].y);
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= width || yi >= height) continue;
      total += magnitude[yi * width + xi];
      n += 1;
    }
  }
  return n ? total / (n * max) : 0;
}

/**
 * Noirceur du liseré : luminance d'une bande fine juste à l'intérieur des
 * quatre côtés.
 *
 * C'est la signature la plus fiable du bord physique d'une carte : toutes
 * ont un liseré noir de deux millimètres, quel que soit leur cadre. Un
 * quadrilatère qui prend le bord de la zone de texte pour côté a du blanc à
 * cet endroit ; une case de nappe a du fond. Rend 1 pour du noir, 0 pour du
 * clair.
 */
export function noirceur(gray, width, height, coins) {
  const cx = coins.reduce((s, p) => s + p.x, 0) / 4;
  const cy = coins.reduce((s, p) => s + p.y, 0) / 4;
  const petit = Math.min(cote(coins[0], coins[1]), cote(coins[0], coins[3]));
  let total = 0;
  for (let c = 0; c < 4; c += 1) {
    const a = coins[c];
    const b = coins[(c + 1) % 4];
    const longueur = cote(a, b) || 1;
    let nx = -(b.y - a.y) / longueur;
    let ny = (b.x - a.x) / longueur;
    // Normale vers l'intérieur.
    if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) > 0) {
      nx = -nx;
      ny = -ny;
    }
    // Le liseré fait 2,5 % de large et la droite détectée peut être à un ou
    // deux pixels du bord : on prend, par côté, la plus sombre de trois bandes
    // (1,5 %, 2,5 %, 3,5 %). Mesuré sur les vrais coins : le minimum tombe
    // entre 20 et 60 sur le liseré, au-dessus de 90 partout ailleurs.
    let plusSombre = 255;
    for (const frac of [0.015, 0.025, 0.035]) {
      const retrait = Math.max(1, petit * frac);
      let somme = 0;
      let n = 0;
      for (let k = 1; k < 12; k += 1) {
        const t = k / 12;
        const x = Math.round(a.x + (b.x - a.x) * t + nx * retrait);
        const y = Math.round(a.y + (b.y - a.y) * t + ny * retrait);
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        somme += gray[y * width + x];
        n += 1;
      }
      if (n && somme / n < plusSombre) plusSombre = somme / n;
    }
    total += plusSombre;
  }
  return Math.max(0, Math.min(1, (140 - total / 4) / 100));
}

/**
 * Cherche les quadrilatères qui pourraient être une carte dans une image.
 *
 * Les droites les plus soutenues (Hough) sont combinées deux à deux : une
 * paire de côtés « verticaux », une paire d'« horizontaux », à peu près
 * perpendiculaires. Chaque quadrilatère ainsi formé est jugé sur ses
 * proportions (une carte vue en perspective reste proche de 59:86), sa
 * convexité, et le soutien de ses quatre côtés par les contours. Le meilleur
 * l'emporte, avec une préférence pour le plus grand à soutien égal : le bord
 * extérieur de la carte plutôt que le cadre intérieur de l'illustration.
 *
 * Rend les `k` meilleurs, distincts, du meilleur au moins bon : c'est
 * l'appariement de l'illustration qui tranche entre eux — un rectangle uni
 * (boîte, téléphone) a des bords parfaits mais ne ressemble à aucune carte.
 *
 * @param {ImageData} imageData image (de préférence réduite à ~320 px de large)
 * @returns {Array<{coins: Array<{x:number,y:number}>, aire: number, soutien: number, score: number}>}
 */
export function trouverQuads(imageData, { fraction = 0.15, aireMin = 0.03, soutienMin = 0.12, k = 40, variantes = 4, lignes = 24, puissance = 1, journal = null } = {}) {
  const { width, height } = imageData;
  const tDebut = performance.now();
  const gray = flouter(toGrayscale(imageData), width, height);
  const { magnitude, orientation } = sobel(gray, width, height);
  let max = 0;
  for (const v of magnitude) if (v > max) max = v;
  if (max === 0) return [];
  const tGradient = performance.now();
  const droites = droitesHough(magnitude, orientation, width, height, { fraction, n: lignes, puissance });
  const tHough = performance.now();

  const marge = 0.08; // les coins peuvent déborder un peu de l'image
  const dedans = (p) =>
    p.x > -marge * width && p.x < (1 + marge) * width && p.y > -marge * height && p.y < (1 + marge) * height;

  const candidats = [];
  let plancher = -Infinity;
  const n = droites.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (ecartAngle(droites[i], droites[j]) > 35 * DEG) continue;
      for (let k2 = 0; k2 < n; k2 += 1) {
        if (k2 === i || k2 === j) continue;
        const perp = (ecartAngle(droites[i], droites[k2]) + ecartAngle(droites[j], droites[k2])) / 2;
        if (perp < 50 * DEG) continue;
        for (let l = k2 + 1; l < n; l += 1) {
          if (l === i || l === j) continue;
          if (ecartAngle(droites[k2], droites[l]) > 35 * DEG) continue;
          const p = [
            intersection(droites[i], droites[k2]),
            intersection(droites[i], droites[l]),
            intersection(droites[j], droites[l]),
            intersection(droites[j], droites[k2]),
          ];
          if (journal) journal.push({ lignes: [i, j, k2, l], etape: 'coins', p });
          if (p.some((q) => !q || !dedans(q))) continue;
          if (!convexe(p)) continue;
          const coins = ordonner(p);
          const surface = aire(coins);
          if (journal) journal.at(-1).etape = 'convexe';
          if (surface < aireMin * width * height) continue;
          const largeur = (cote(coins[0], coins[1]) + cote(coins[3], coins[2])) / 2;
          const hauteur = (cote(coins[0], coins[3]) + cote(coins[1], coins[2])) / 2;
          const ratio = largeur / Math.max(1, hauteur);
          // Une carte (59:86) ou son cadre d'illustration (carré) : les deux
          // servent, le second permet de retrouver la carte quand son bord se
          // confond avec le fond. Entre les deux, rien de connu.
          const type = ratio < CARTE_RATIO * 1.3 ? 'carte' : ratio > 0.86 ? 'art' : null;
          if (journal) Object.assign(journal.at(-1), { etape: 'aire', ratio });
          if (!type || ratio < CARTE_RATIO * 0.75 || ratio > 1.3) continue;
          // Les traits bon marché d'abord (liseré, taille, proportions), et le
          // soutien des bords — cinq cents lectures — seulement si le candidat
          // peut encore entrer dans les `k` retenus avec un soutien parfait :
          // plus de mille candidats par image, la plupart s'arrêtent ici.
          // Le liseré noir ne vaut que pour le bord de la carte ; le cadre de
          // l'illustration (type « art ») n'en a pas, on ne le lui demande pas.
          const noir = type === 'carte' ? noirceur(gray, width, height, coins) : 0.3;
          // Pré-classement APPRIS (régression logistique sur 25 000 candidats
          // de 300 scènes du banc, étiquetés « à moins de 10 % du vrai
          // contour ») : le liseré noir pèse le plus, puis la proximité des
          // proportions d'une carte, puis la taille ; la richesse intérieure
          // ne compte pas. Mesuré contre la formule manuelle qui précédait :
          // le vrai contour passe du rang médian 4 au rang 0, et se trouve
          // dans les cinq premiers 84 % du temps contre 52 %.
          const base = 1.85 * noir + 0.81 * Math.log(surface / (width * height) + 1e-4) - 1.92 * Math.abs(ratio - CARTE_RATIO);
          if (base + 0.26 < plancher) {
            if (journal) journal.at(-1).etape = 'élagué';
            continue;
          }
          let appui = 0;
          for (let c = 0; c < 4; c += 1) appui += soutien(magnitude, width, height, coins[c], coins[(c + 1) % 4], max);
          appui /= 4;
          if (journal) Object.assign(journal.at(-1), { etape: 'ratio', appui });
          if (appui < soutienMin) continue;
          if (journal) journal.at(-1).etape = 'accepté';
          const plein = richesse(magnitude, width, height, coins, max);
          const score = 0.26 * appui + base;
          if (journal) Object.assign(journal.at(-1), { richesse: plein, noirceur: noir, score, surface });
          candidats.push({ coins, type, aire: surface, soutien: appui, richesse: plein, noirceur: noir, score });
          // Le plancher : le score du (3k)-ième meilleur candidat noté jusqu'ici,
          // rafraîchi de loin en loin (un tri à chaque ajout coûterait plus
          // qu'il n'économise). Trois fois k, parce que la déduplication en
          // régions écarte ensuite des candidats bien notés.
          if (candidats.length % 64 === 0 && candidats.length >= k * 3) {
            const tri = candidats.map((c) => c.score).sort((a, b) => b - a);
            plancher = tri[k * 3 - 1];
          }
        }
      }
    }
  }

  // Les `k` meilleurs, à deux niveaux. D'abord des RÉGIONS : deux
  // quadrilatères dont les coins sont à moins de 3 % de la diagonale de
  // l'image l'un de l'autre couvrent la même région ; les régions sont prises
  // par score décroissant, c'est ce qui garantit la diversité (la carte, la
  // boîte à côté, la case de nappe). Puis, dans chaque région, jusqu'à
  // `variantes` contours distincts à 3 % de leur propre petit côté : le bord
  // de la carte, le liseré, le cadre de l'illustration pris pour un côté —
  // c'est l'appariement qui tranchera entre eux. Une version à un seul
  // niveau perdait l'un ou l'autre : trop fin, quarante variantes d'une
  // seule région ; trop large, le vrai contour d'une petite carte absorbé
  // par un voisin mieux noté.
  const tCandidats = performance.now();
  candidats.sort((a, b) => b.score - a.score);
  const large = 0.03 * Math.hypot(width, height);
  const regions = [];
  for (const c of candidats) {
    const region = regions.find((r) => r.chef.coins.every((q, idx) => cote(q, c.coins[idx]) < large));
    if (region) region.membres.push(c);
    else regions.push({ chef: c, membres: [c] });
  }
  const sortie = [];
  const parRegion = Math.max(1, variantes);
  for (const region of regions) {
    if (sortie.length >= k) break;
    const gardes = [];
    for (const c of region.membres) {
      if (gardes.length >= parRegion) break;
      const fine = 0.03 * Math.min(cote(c.coins[0], c.coins[1]), cote(c.coins[0], c.coins[3]));
      if (!gardes.some((d) => d.coins.every((q, idx) => cote(q, c.coins[idx]) < fine))) gardes.push(c);
    }
    for (const g of gardes) if (sortie.length < k) sortie.push(g);
  }
  // Temps par étape, pour le banc (propriété non énumérable : la sortie reste un tableau).
  Object.defineProperty(sortie, 'temps', {
    value: { gradient: tGradient - tDebut, hough: tHough - tGradient, candidats: tCandidats - tHough, tri: performance.now() - tCandidats, nb: candidats.length },
    enumerable: false,
  });
  return sortie;
}

/** Le meilleur quadrilatère, ou null. Voir `trouverQuads`. */
export function trouverQuad(imageData, options) {
  return trouverQuads(imageData, { ...options, k: 1 })[0] ?? null;
}

/**
 * Les coins de la carte, déduits de ceux de son cadre d'illustration.
 *
 * Le cadre est à une position fixe dans la carte (`CADRE_ART.standard`) : une
 * homographie du repère de la carte vers l'image, calée sur les quatre coins
 * du cadre, donne les coins de la carte. Le cadre étant carré, on ne sait pas
 * dans quel sens il est tourné : les deux lectures sont rendues, l'appariement
 * tranche.
 *
 * @returns {Array<Array<{x:number,y:number}>>} deux quadrilatères de carte
 */
export function carteDepuisArt(coinsArt) {
  const { x, y, w, h } = CADRE_ART.standard;
  const cadre = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
  const carte = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const sorties = [];
  for (const rotation of [0, 1]) {
    const coins = [0, 1, 2, 3].map((i) => coinsArt[(i + rotation) % 4]);
    const h2 = homographie(cadre, coins);
    sorties.push(ordonner(carte.map((p) => projeter(h2, p))));
  }
  return sorties;
}

/**
 * Décale les quatre côtés d'un quadrilatère vers l'extérieur (ou l'intérieur
 * si `liseré` est négatif) d'une fraction du PETIT côté — la largeur du
 * liseré noir, 2,5 % de la largeur d'une carte, sur les quatre côtés.
 *
 * Sert à proposer l'hypothèse « ce qu'on a trouvé est le bord intérieur du
 * liseré, pas le bord de la carte ». Chaque côté est décalé le long de sa
 * normale et les coins sont les intersections des côtés décalés — une
 * homothétie ou un déplacement des coins vers le centre ne décalerait pas
 * les côtés de la même largeur (mesuré par le test).
 */
export function dilater(coins, liseré = 0.025) {
  const cx = coins.reduce((s, p) => s + p.x, 0) / 4;
  const cy = coins.reduce((s, p) => s + p.y, 0) / 4;
  const petit = Math.min(cote(coins[0], coins[1]), cote(coins[0], coins[3]));
  const d = petit * liseré;
  // Chaque côté, décalé de d le long de sa normale extérieure, sous forme (rho, theta).
  const lignes = coins.map((a, i) => {
    const b = coins[(i + 1) % 4];
    const longueur = cote(a, b) || 1;
    let nx = -(b.y - a.y) / longueur;
    let ny = (b.x - a.x) / longueur;
    if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const theta = Math.atan2(ny, nx);
    return { theta, rho: (a.x + nx * d) * nx + (a.y + ny * d) * ny };
  });
  // Le coin i est l'intersection des côtés i-1 et i.
  return coins.map((p, i) => intersection(lignes[(i + 3) % 4], lignes[i]) ?? p);
}

/**
 * Affine un quadrilatère sur l'image en pleine résolution.
 *
 * La détection travaille à 448 px de large avec des droites quantifiées au
 * degré : sur un côté de 500 px, un degré fait neuf pixels d'erreur au bout.
 * Pour chaque côté, on relève en 48 points la position du LISERÉ NOIR : une
 * bande de 2,7 % du petit côté, plus sombre que ce qui l'entoure des deux
 * côtés — c'est la signature du bord physique de toute carte, que le fond
 * soit clair ou texturé, et elle survit au flou. Son bord extérieur est le
 * bord de la carte. Puis une droite par consensus (RANSAC) et moindres
 * carrés. Là où le liseré ne se lit pas (fond noir, cadre noir), le plus fort
 * gradient sert de secours.
 *
 * @param {ImageData|{gray: Uint8ClampedArray, width: number, height: number}} image
 *   pleine résolution ; on peut passer le gris déjà calculé
 * @param {Array<{x:number,y:number}>} coins ordonnés, dans le repère de l'image
 * @param {{bande?: number, points?: number, minimum?: number}} options
 *   demi-largeur de recherche en fraction du petit côté (3 px au moins)
 */
export function affiner(image, coins, { bande = 0.03, points = 48, minimum = 10, trace = null } = {}) {
  const { width, height } = image;
  const gray = image.gray ?? toGrayscale(image);
  const lire = (x, y) => {
    const xi = x < 0 ? 0 : x >= width ? width - 1 : Math.round(x);
    const yi = y < 0 ? 0 : y >= height ? height - 1 : Math.round(y);
    return gray[yi * width + xi];
  };
  const petit = Math.min(cote(coins[0], coins[1]), cote(coins[0], coins[3]));
  const portee = Math.max(3, Math.round(petit * bande));
  // Largeur du liseré noir en pixels : c'est lui qu'on cherche.
  const w = Math.max(2, Math.round(petit * LISERE));
  const cx = coins.reduce((s, p) => s + p.x, 0) / 4;
  const cy = coins.reduce((s, p) => s + p.y, 0) / 4;

  const droites = [];
  for (let c = 0; c < 4; c += 1) {
    const a = coins[c];
    const b = coins[(c + 1) % 4];
    const longueur = cote(a, b) || 1;
    const tx = (b.x - a.x) / longueur;
    const ty = (b.y - a.y) / longueur;
    let nx = -ty;
    let ny = tx;
    // Normale vers l'extérieur : les offsets positifs du profil sont dehors.
    if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const bords = [];
    const secours = [];
    const debut = -portee - 2 * w;
    const fin = portee + w;
    for (let k = 1; k < points; k += 1) {
      const t = k / points;
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      // Profil le long de la normale, moyenné sur trois pixels le long du
      // bord ; l'indice i correspond à l'offset debut + i.
      const profil = [];
      for (let d = debut; d <= fin; d += 1) {
        profil.push((lire(px + nx * d - tx, py + ny * d - ty) + lire(px + nx * d, py + ny * d) + lire(px + nx * d + tx, py + ny * d + ty)) / 3);
      }
      const somme = (i0, i1) => {
        let sm = 0;
        for (let i = i0; i <= i1; i += 1) sm += profil[i];
        return sm / (i1 - i0 + 1);
      };
      // Le liseré : une bande de `w` pixels plus sombre que ce qui l'entoure
      // des deux côtés. On cherche l'offset e de son bord extérieur.
      let meilleurE = null;
      let meilleurContraste = 0;
      for (let e = -portee; e <= portee; e += 1) {
        const i = e - debut;
        const liseré = somme(i - w + 1, i);
        const dehors = somme(i + 1, i + w);
        const dedans = somme(i - 2 * w + 1, i - w);
        const contraste = Math.min(dehors, dedans) - liseré;
        if (contraste > meilleurContraste) {
          meilleurContraste = contraste;
          meilleurE = e;
        }
      }
      if (meilleurE !== null && meilleurContraste >= minimum) {
        bords.push({ x: px + nx * meilleurE, y: py + ny * meilleurE, k });
        continue;
      }
      // Pas de liseré lisible ici (fond noir, cadre noir) : le plus fort
      // gradient fera l'affaire, en secours.
      let max = 0;
      let ou = 0;
      for (let i = 1; i < profil.length - 1; i += 1) {
        const g = Math.abs(profil[i + 1] - profil[i - 1]);
        if (g > max) {
          max = g;
          ou = debut + i;
        }
      }
      if (max >= minimum && Math.abs(ou) <= portee) secours.push({ x: px + nx * ou, y: py + ny * ou, k });
    }
    if (trace) trace.push({ bords: bords.length, secours: secours.length });
    const initiale = { theta: Math.atan2(ny, nx), rho: a.x * nx + a.y * ny };
    const droite = droiteConsensus(bords, initiale, points) ?? droiteConsensus(bords.concat(secours), initiale, points);
    if (!droite) return coins;
    droites.push(droite);
  }
  const affines = [
    intersection(droites[3], droites[0]),
    intersection(droites[0], droites[1]),
    intersection(droites[1], droites[2]),
    intersection(droites[2], droites[3]),
  ];
  if (affines.some((p) => !p) || !convexe(affines)) return coins;
  if (affines.some((p, i) => cote(p, coins[i]) > portee * 4 + 4)) return coins;
  return affines;
}

/** Distance signée d'un point à une droite (rho, theta). */
const distanceDroite = (d, p) => p.x * Math.cos(d.theta) + p.y * Math.sin(d.theta) - d.rho;

/**
 * La droite qui rallie le plus de candidats (RANSAC déterministe), puis
 * ajustée par moindres carrés sur ses ralliés.
 *
 * Deux droites à égalité de soutien — le bord de la carte et le liseré du
 * cadre sont tous deux parfaitement droits — sont départagées par la
 * proximité de l'estimation initiale : l'affinage rend précis ce qu'on lui a
 * donné, il ne choisit pas entre bord et liseré. C'est le rôle des hypothèses
 * (`dilater`) et de l'appariement.
 */
function droiteConsensus(candidats, initiale, points) {
  if (candidats.length < 6) return null;
  let graine = 7;
  const alea = () => {
    graine = (graine * 1103515245 + 12345) % 2147483648;
    return graine / 2147483648;
  };
  const tolerance = 1.5;
  let meilleur = null;
  for (let essai = 0; essai < 48; essai += 1) {
    const p = candidats[Math.floor(alea() * candidats.length)];
    const q = candidats[Math.floor(alea() * candidats.length)];
    if (p.k === q.k) continue;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const longueur = Math.hypot(dx, dy);
    if (longueur < 1e-6) continue;
    const theta = Math.atan2(dx, -dy);
    const d = { theta, rho: p.x * Math.cos(theta) + p.y * Math.sin(theta) };
    // Un rallié par point du côté au plus.
    const rallies = new Set();
    for (const c of candidats) if (Math.abs(distanceDroite(d, c)) <= tolerance) rallies.add(c.k);
    const soutien = rallies.size;
    const ecart = Math.abs(distanceDroite(initiale, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }));
    if (!meilleur || soutien > meilleur.soutien || (soutien === meilleur.soutien && ecart < meilleur.ecart)) {
      meilleur = { d, soutien, ecart };
    }
  }
  // Il faut qu'une vraie proportion du côté soit d'accord.
  if (!meilleur || meilleur.soutien < Math.max(6, points * 0.3)) return null;
  const inliers = candidats.filter((c) => Math.abs(distanceDroite(meilleur.d, c)) <= tolerance);
  return ajusterDroite(inliers);
}

/** Droite (rho, theta) par moindres carrés orthogonaux. */
function ajusterDroite(pts) {
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  const angleDir = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const theta = angleDir + Math.PI / 2;
  return { theta, rho: mx * Math.cos(theta) + my * Math.sin(theta) };
}

/**
 * Redresse une carte : des coins (dans le repère de `source`) vers une image
 * `largeur × hauteur` vue de face.
 */
export function redresser(source, coins, largeur = CARTE_LARGEUR, hauteur = CARTE_HAUTEUR) {
  const cible = [
    { x: 0, y: 0 },
    { x: largeur - 1, y: 0 },
    { x: largeur - 1, y: hauteur - 1 },
    { x: 0, y: hauteur - 1 },
  ];
  return deformer(source, homographie(cible, coins), largeur, hauteur);
}

/** Les mêmes coins, à l'échelle : de l'image réduite vers l'image d'origine. */
export const remettreEchelle = (coins, facteur) => coins.map((p) => ({ x: p.x * facteur, y: p.y * facteur }));
