/**
 * Identifier une carte dans une image : la chaîne complète.
 *
 *   1. droites et quadrilatères candidats à basse résolution (`quad.js`) ;
 *   2. pour CHAQUE candidat, l'empreinte de sa zone d'illustration, obtenue
 *      par un rééchantillonnage direct et minuscule (96×96) — quelques
 *      milliers de pixels, pas la carte entière ;
 *   3. recherche dans l'index (`art.js`) ; le meilleur score désigne à la
 *      fois la carte et son contour ;
 *   4. variantes autour du vainqueur — carte tournée de 180°, contour dilaté
 *      (liseré intérieur pris pour le bord) — puis affinage des coins en
 *      pleine résolution.
 *
 * Pourquoi tant d'hypothèses : aucun critère géométrique ne distingue à coup
 * sûr une carte d'une case de nappe ou d'une boîte posée à côté. Ce qui les
 * distingue, c'est qu'une carte ressemble à une carte de l'index. On laisse
 * donc l'appariement trancher, et l'on rend son évaluation assez bon marché
 * pour se le permettre (mesuré : 1 à 2 ms par hypothèse).
 */

import { CADRE_ART, MARGE_ART, chercher, empreinte } from './art.js';
import { toGrayscale } from './preprocess.js';
import { affiner, carteDepuisArt, dilater, homographie, noirceur, remettreEchelle, trouverQuads } from './quad.js';
import { MARGE_SURE, SCORE_SUR } from './verdictArt.js';

/** Une recherche qui désigne une carte avec la certitude de la zone sûre de `verdictArt`. */
const estSure = (trouves) => (trouves[0]?.score ?? 0) >= SCORE_SUR && trouves[0].score - (trouves[1]?.score ?? 0) >= MARGE_SURE;

/** Côté du rééchantillonnage de l'illustration pour l'empreinte. */
export const COTE_ART = 96;

/**
 * Largeur de l'image de détection dans l'application. Mesuré sur le banc :
 * 320 px perdaient les petites cartes (56 % → 88 % à 448 px sur les
 * moyennes) ; au-delà, le coût de Hough croît sans gain.
 */
export const LARGEUR_DETECTION_APP = 448;

/**
 * Réduit une image (ImageData) à `largeur` pixels de large, par moyenne de
 * zone. C'est l'image que voit la détection ; l'identification lit ensuite
 * l'image d'origine à travers les contours trouvés.
 */
export function reduireImage(image, largeur) {
  const echelle = Math.min(1, largeur / image.width);
  return recadrerReduire(image, { x: 0, y: 0, w: image.width, h: image.height }, echelle);
}

/**
 * Empreinte de l'illustration d'une carte dont on connaît les coins dans
 * `imageData`, sans redresser la carte entière.
 *
 * @param {ImageData} imageData image source
 * @param {Array<{x:number,y:number}>} coins haut-gauche, haut-droit, bas-droit, bas-gauche
 * @param {{demiTour?: boolean}} options carte vue à l'envers
 */
export function empreinteDepuisCoins(imageData, coins, { demiTour = false } = {}) {
  const { x, y, w, h } = CADRE_ART.standard;
  const mx = w * MARGE_ART;
  const my = h * MARGE_ART;
  // Coins de la zone d'illustration, en coordonnées normalisées de la carte.
  let zone = [
    { x: x + mx, y: y + my },
    { x: x + w - mx, y: y + my },
    { x: x + w - mx, y: y + h - my },
    { x: x + mx, y: y + h - my },
  ];
  if (demiTour) zone = zone.map((p) => ({ x: 1 - p.x, y: 1 - p.y }));
  const versImage = homographie(
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    coins,
  );
  const cible = zone.map((p) => projeterH(versImage, p));
  const h2 = homographie(
    [
      { x: 0, y: 0 },
      { x: COTE_ART - 1, y: 0 },
      { x: COTE_ART - 1, y: COTE_ART - 1 },
      { x: 0, y: COTE_ART - 1 },
    ],
    cible,
  );
  return empreinte(echantillonner(imageData, h2, COTE_ART, COTE_ART));
}

function projeterH(h, { x, y }) {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

/** Rééchantillonnage bilinéaire à travers une homographie sortie → source. */
function echantillonner(source, h, largeur, hauteur) {
  const { data, width, height } = source;
  const out = new Uint8ClampedArray(largeur * hauteur * 4);
  for (let y = 0; y < hauteur; y += 1) {
    for (let x = 0; x < largeur; x += 1) {
      const w = h[6] * x + h[7] * y + h[8];
      const sx = (h[0] * x + h[1] * y + h[2]) / w;
      const sy = (h[3] * x + h[4] * y + h[5]) / w;
      const o = (y * largeur + x) * 4;
      out[o + 3] = 255;
      if (!(sx >= 0 && sy >= 0 && sx < width - 1 && sy < height - 1)) continue;
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

/**
 * Indice d'orientation d'une carte redressée (gris, largeur × hauteur) :
 * la bande du nom, en haut, porte de grandes lettres contrastées ; la marge
 * du bas ne porte que le numéro de carte en petits caractères. La différence
 * des variances de luminance des deux bandes est positive pour une carte à
 * l'endroit. Mesuré sur les visuels officiels (voir `scripts/art-bench.mjs`).
 */
export function indiceOrientation(gray, width, height, bandes = BANDES_ORIENTATION, mesure = 'moyenne') {
  const stats = (y0, y1) => {
    let somme = 0;
    let carre = 0;
    let n = 0;
    for (let y = Math.round(y0 * height); y < Math.round(y1 * height); y += 1) {
      for (let x = Math.round(0.12 * width); x < Math.round(0.88 * width); x += 1) {
        const v = gray[y * width + x];
        somme += v;
        carre += v * v;
        n += 1;
      }
    }
    const moyenne = n ? somme / n : 0;
    return { moyenne, variance: n ? carre / n - moyenne ** 2 : 0 };
  };
  const [haut, bas] = bandes;
  return stats(haut[0], haut[1])[mesure] - stats(bas[0], bas[1])[mesure];
}

/**
 * Bandes comparées : la zone de texte (bas) contre son miroir (bas du nom,
 * étoiles, haut de l'illustration). Mesuré sur 3 000 visuels officiels : la
 * zone de texte est plus claire dans 100 % des cas, de 83 niveaux en médiane,
 * 31 au premier centile. Sous ce seuil de sûreté, l'appariement départage.
 */
export const BANDES_ORIENTATION = [[0.76, 0.9], [0.1, 0.24]];
export const ORIENTATION_SURE = 15;

/**
 * Orientation d'une carte dont on connaît les coins : rend l'indice de
 * luminance (positif = à l'endroit), calculé sur un rééchantillonnage gris
 * de 48×70 de la carte entière.
 */
export function orientationDepuisCoins(imageData, coins) {
  const l = 48;
  const h = 70;
  const h2 = homographie(
    [
      { x: 0, y: 0 },
      { x: l - 1, y: 0 },
      { x: l - 1, y: h - 1 },
      { x: 0, y: h - 1 },
    ],
    coins,
  );
  const petite = echantillonner(imageData, h2, l, h);
  const gray = new Uint8ClampedArray(l * h);
  for (let p = 0, i = 0; p < gray.length; p += 1, i += 4) {
    gray[p] = (petite.data[i] * 299 + petite.data[i + 1] * 587 + petite.data[i + 2] * 114) / 1000;
  }
  const moyenne = (y0, y1, x0 = 0.12, x1 = 0.88) => {
    let somme = 0;
    let n = 0;
    for (let y = Math.round(y0 * h); y < Math.round(y1 * h); y += 1) {
      for (let x = Math.round(x0 * l); x < Math.round(x1 * l); x += 1) {
        somme += gray[y * l + x];
        n += 1;
      }
    }
    return n ? somme / n : 0;
  };
  // Comparaison brute des deux zones. Une correction par la luminance du
  // liseré aux deux extrémités a été essayée pour compenser un éclairage
  // inégal : elle dégradait le résultat (80 % → 71 %), le liseré n'étant pas
  // fiable à cette échelle. On s'en tient à la mesure directe, et à
  // l'appariement pour les cas incertains.
  const [texte, miroir] = BANDES_ORIENTATION;
  return moyenne(texte[0], texte[1]) - moyenne(miroir[0], miroir[1]);
}

/** Recadre `cadre` dans `source` et le réduit d'un facteur `echelle` (moyenne de zone). */
function recadrerReduire(source, cadre, echelle) {
  const largeur = Math.max(1, Math.round(cadre.w * echelle));
  const hauteur = Math.max(1, Math.round(cadre.h * echelle));
  const out = new Uint8ClampedArray(largeur * hauteur * 4);
  const { data, width } = source;
  for (let y = 0; y < hauteur; y += 1) {
    const sy0 = cadre.y + Math.floor((y * cadre.h) / hauteur);
    const sy1 = cadre.y + Math.max(sy0 - cadre.y + 1, Math.floor(((y + 1) * cadre.h) / hauteur));
    for (let x = 0; x < largeur; x += 1) {
      const sx0 = cadre.x + Math.floor((x * cadre.w) / largeur);
      const sx1 = cadre.x + Math.max(sx0 - cadre.x + 1, Math.floor(((x + 1) * cadre.w) / largeur));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const i = (sy * width + sx) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n += 1;
        }
      }
      const o = (y * largeur + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: largeur, height: hauteur };
}

/**
 * Identifie la carte visible dans `plein`.
 *
 * @param {ImageData} plein image en pleine résolution
 * @param {ImageData} reduite la même image, réduite pour la détection
 * @param {object} index index d'empreintes (`lireIndexArt`)
 * @param {{hypotheses?: number, finalistes?: number, lignes?: number}} options
 * @returns {{quad: Array|null, candidats: Array<{id:number, score:number}>, sens: string|null,
 *   hypothese: string|null, evaluees: number, toutes: Array, ms: {quad:number, total:number}}}
 */
export function identifierCarte(plein, reduite, index, { hypotheses = 40, finalistes = 6, lignes = 24, bande = 0.03, variantes = 4 } = {}) {
  const t0 = performance.now();
  const facteur = plein.width / reduite.width;
  const quads = trouverQuads(reduite, { k: hypotheses, lignes, variantes });
  const t1 = performance.now();
  // Le gris pleine résolution, une fois pour tous les affinages.
  const gris = { gray: toGrayscale(plein), width: plein.width, height: plein.height };
  const tGris = performance.now();

  // Étage 1 : chaque candidat, affiné au pixel, tel quel, à l'endroit. Les
  // cadres carrés (type « art ») donnent deux lectures de carte.
  // Le score d'une hypothèse n'est pas le seul score d'appariement : parmi
  // des dizaines de contours et 14 500 cartes, un bout de nappe ou de boîte
  // finit toujours par ressembler à quelque chose. Le liseré noir, mesuré en
  // pleine résolution sur le contour proposé, dit si c'est une carte du tout.
  // Mesuré : les faux contours gagnants avaient un liseré à 0-0,3, les vrais
  // à 0,7-1.
  // Le score de pré-classement (appris, voir `trouverQuads`) est une
  // log-vraisemblance : passée par la sigmoïde, c'est la probabilité que le
  // contour soit celui d'une carte. Elle pondère le score d'appariement.
  const prior = (q) => 1 / (1 + Math.exp(-q.score));
  const noter = (coins, score, q) => score * (0.4 + 0.6 * (q ? prior(q) : noirceur(gris.gray, gris.width, gris.height, coins)));
  // Les hypothèses sont évaluées dans l'ordre du pré-classement, et l'on
  // S'ARRÊTE dès qu'une carte est trouvée avec certitude (score et marge de la
  // zone sûre de `verdictArt`) : le pré-classement met le vrai contour en tête
  // dans 84 % des cas, inutile d'évaluer les quarante autres.
  const toutes = [];
  let sur = false;
  const evaluer = (q, coins, nom) => {
    // L'orientation vient de la carte elle-même (zone de texte claire en
    // bas), pas de l'appariement : une carte à l'envers ressemble parfois
    // mieux à une autre carte qu'à elle-même. Indice faible : les deux sens.
    const orientation = orientationDepuisCoins(plein, coins);
    const sens = orientation > ORIENTATION_SURE ? ['droite'] : orientation < -ORIENTATION_SURE ? ['tournée'] : ['droite', 'tournée'];
    for (const s of sens) {
      const e = empreinteDepuisCoins(plein, coins, { demiTour: s === 'tournée' });
      const trouves = chercher(index, e, 3);
      const appariement = trouves[0]?.score ?? 0;
      toutes.push({ nom: `${nom}${s === 'tournée' ? '↺' : ''}`, coins, candidats: trouves, appariement, score: noter(coins, appariement, q), sens: s, orientation, quad: q });
      if (estSure(trouves)) sur = true;
    }
  };
  for (let rang = 0; rang < quads.length && !sur; rang += 1) {
    const q = quads[rang];
    const base = affiner(gris, remettreEchelle(q.coins, facteur), { bande });
    const variantes = q.type === 'art' ? carteDepuisArt(base).map((c, i) => [`art${i}`, c]) : [['brut', base]];
    for (const [nom, coins] of variantes) evaluer(q, coins, `${rang}:${nom}`);
  }
  toutes.sort((a, b) => b.score - a.score);

  const tEtage1 = performance.now();
  // Seconde détection, RAPPROCHÉE, autour des meilleures petites régions :
  // une carte qui n'occupe qu'un quart de l'image ne fait que cent pixels de
  // large à l'échelle de détection, son liseré un pixel — les droites sont
  // trop grossières. On recadre autour d'elle dans l'image d'origine, on
  // détecte à nouveau à l'échelle de travail, et l'on soumet ces contours au
  // même appariement. Mesuré : les petites cartes passaient de 56 % à ...
  // Seulement si rien de sûr n'a été trouvé : mesuré, la passe coûte 80 ms.
  const regionsFaites = [];
  for (const h of sur ? [] : toutes.slice(0, 6)) {
    const xs = h.coins.map((p) => p.x);
    const ys = h.coins.map((p) => p.y);
    const largeur = Math.max(...xs) - Math.min(...xs);
    const hauteur = Math.max(...ys) - Math.min(...ys);
    if (largeur > 0.45 * plein.width && hauteur > 0.45 * plein.height) continue;
    const cxr = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cyr = (Math.min(...ys) + Math.max(...ys)) / 2;
    if (regionsFaites.some((r) => Math.hypot(r.x - cxr, r.y - cyr) < 0.25 * Math.max(largeur, hauteur))) continue;
    regionsFaites.push({ x: cxr, y: cyr });
    if (regionsFaites.length > 3) break;
    const cadre = {
      x: Math.max(0, Math.round(cxr - largeur * 0.75)),
      y: Math.max(0, Math.round(cyr - hauteur * 0.75)),
    };
    cadre.w = Math.min(plein.width - cadre.x, Math.round(largeur * 1.5));
    cadre.h = Math.min(plein.height - cadre.y, Math.round(hauteur * 1.5));
    if (cadre.w < 32 || cadre.h < 32) continue;
    const echelle = Math.min(1, reduite.width / cadre.w);
    const zoom = recadrerReduire(plein, cadre, echelle);
    const proches = trouverQuads(zoom, { k: 12, lignes, variantes });
    for (let rang = 0; rang < proches.length && !sur; rang += 1) {
      const q = proches[rang];
      const coinsPlein = q.coins.map((p) => ({ x: cadre.x + p.x / echelle, y: cadre.y + p.y / echelle }));
      const base = affiner(gris, coinsPlein, { bande });
      const variantesQ = q.type === 'art' ? carteDepuisArt(base).map((c, i) => [`art${i}`, c]) : [['brut', base]];
      for (const [nom, coins] of variantesQ) evaluer(q, coins, `z${regionsFaites.length}.${rang}:${nom}`);
    }
    if (sur) break;
  }
  toutes.sort((a, b) => b.score - a.score);
  const t2 = performance.now();

  // Étage 2 : autour des finalistes, une recherche locale guidée par le score
  // d'appariement : le contour décalé vers l'extérieur par pas d'une demi-
  // largeur de liseré (la détection se cale souvent sur le bord intérieur du
  // liseré, parfois sur le cadre de l'illustration), et la carte à l'envers.
  // L'appariement tolère ±12 px (mesuré : 99 % de bonnes cartes) ; un pas de
  // 1,25 % du petit côté garantit qu'un des décalages tombe dans cette marge.
  let meilleur = null;
  const pas = [0, 0.025, -0.025];
  for (const finaliste of toutes.slice(0, finalistes)) {
    for (const decalage of pas) {
      const coins = decalage === 0 ? finaliste.coins : dilater(finaliste.coins, decalage);
      const e = empreinteDepuisCoins(plein, coins, { demiTour: finaliste.sens === 'tournée' });
      const trouves = chercher(index, e, 5);
      const score = noter(coins, trouves[0]?.score ?? 0, finaliste.quad);
      if (!meilleur || score > meilleur.score) {
        meilleur = { quad: coins, candidats: trouves, score, sens: finaliste.sens, hypothese: `${finaliste.nom}/${decalage >= 0 ? '+' : ''}${(decalage * 100).toFixed(2)}%` };
      }
    }
  }

  return {
    quad: meilleur?.quad ?? null,
    candidats: meilleur?.candidats ?? [],
    sens: meilleur?.sens ?? null,
    hypothese: meilleur?.hypothese ?? null,
    evaluees: toutes.length,
    toutes,
    ms: {
      quad: Math.round(t1 - t0),
      gradient: Math.round(quads.temps?.gradient ?? 0),
      hough: Math.round(quads.temps?.hough ?? 0),
      candidats: Math.round(quads.temps?.candidats ?? 0),
      tri: Math.round(quads.temps?.tri ?? 0),
      nbCandidats: quads.temps?.nb ?? 0,
      gris: Math.round(tGris - t1),
      etage1: Math.round(tEtage1 - tGris),
      zoom: Math.round(t2 - tEtage1),
      etage2: Math.round(performance.now() - t2),
      total: Math.round(performance.now() - t0),
    },
  };
}
