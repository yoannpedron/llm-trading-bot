/**
 * Page du banc d'identification par illustration : le VRAI code de
 * l'application (`src/lib/art.js`, `src/lib/quad.js`), servi par Vite, piloté
 * par `scripts/build-art-index.mjs` et `scripts/art-bench.mjs`.
 *
 * Expose sur `window` :
 *   __empreintes(urls)        empreintes des visuels officiels (index)
 *   __chargerIndex(octets, ignores)  index sérialisé → mémoire, moins les passcodes `ignores`
 *   __scene(url, params)      une photo synthétique de la carte, avec ses vrais coins
 *                             (`sansCarte: true` : le fond et ses parasites seuls)
 *   __identifier(sceneB64)    la chaîne complète, chronométrée
 */
import {
  CARTE_HAUTEUR,
  CARTE_LARGEUR,
  TAILLE_EMPREINTE,
  chercher,
  empreinte,
  lireIndexArt,
  masquerCartes,
  zoneArt,
} from '../../../src/lib/art.js';
import { identifierCarte } from '../../../src/lib/identifier.js';
import { LARGEUR_DETECTION, affiner, deformer, homographie, redresser } from '../../../src/lib/quad.js';

const charger = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image illisible : ${url}`));
    img.src = url;
  });

/** `deformer` rend un objet nu ; le canvas veut un vrai ImageData. */
const enImageData = (img) => (img instanceof ImageData ? img : new ImageData(img.data, img.width, img.height));

const canvasDe = (largeur, hauteur) => {
  const c = document.createElement('canvas');
  c.width = largeur;
  c.height = hauteur;
  return [c, c.getContext('2d', { willReadFrequently: true })];
};

/** ImageData d'une carte canonique 268×391 depuis un visuel officiel. */
async function carteCanonique(url) {
  const img = await charger(url);
  const [, cx] = canvasDe(CARTE_LARGEUR, CARTE_HAUTEUR);
  cx.drawImage(img, 0, 0, CARTE_LARGEUR, CARTE_HAUTEUR);
  return cx.getImageData(0, 0, CARTE_LARGEUR, CARTE_HAUTEUR);
}

/**
 * Empreinte de l'illustration d'une carte canonique (ImageData).
 *
 * `contraction` simule un contour pris sur le bord intérieur du liseré : la
 * zone d'illustration est celle d'une carte rétrécie de cette fraction sur
 * chaque côté (0,027 = la largeur du liseré).
 */
function empreinteDeCarte(carte, contraction = 0) {
  const z = zoneArt('standard');
  const [, cx] = canvasDe(z.width, z.height);
  const [source, sx] = canvasDe(carte.width, carte.height);
  sx.putImageData(carte, 0, 0);
  const dx = contraction * carte.width;
  const dy = contraction * carte.width; // même largeur physique sur les quatre côtés
  const s = { x: dx + z.x * (1 - 2 * dx / carte.width), y: dy + z.y * (1 - 2 * dy / carte.height), w: z.width * (1 - 2 * dx / carte.width), h: z.height * (1 - 2 * dy / carte.height) };
  cx.drawImage(source, s.x, s.y, s.w, s.h, 0, 0, z.width, z.height);
  return empreinte(cx.getImageData(0, 0, z.width, z.height));
}

window.__empreintes = async (urls, contraction = 0) => {
  const resultats = await Promise.all(
    urls.map(async (url) => {
      try {
        return Array.from(empreinteDeCarte(await carteCanonique(url), contraction));
      } catch {
        return null;
      }
    }),
  );
  return resultats;
};

let index = null;
/**
 * `ignores` : passcodes à faire disparaître de l'index (id à -1, sautés par
 * `chercher`), pour mesurer ce que rend une carte que l'index ne connaît pas.
 * Rend le nombre d'entrées et le nombre masquées.
 */
window.__chargerIndex = (octets, ignores = []) => {
  index = masquerCartes(lireIndexArt(Uint8Array.from(octets)), ignores);
  const masquees = index.ids.reduce((n, id) => n + (id < 0 ? 1 : 0), 0);
  return { taille: index.taille, masquees };
};
window.__tailleEmpreinte = TAILLE_EMPREINTE;

/* --- Scènes synthétiques --------------------------------------------------- */

// Une photo de téléphone : 1080×1920 (l'aperçu vidéo courant).
const SCENE_L = 1080;
const SCENE_H = 1920;

function aleatoire(graine) {
  let g = graine >>> 0 || 1;
  return () => {
    g = (g * 1103515245 + 12345) % 2147483648;
    return g / 2147483648;
  };
}

/**
 * Une photo de téléphone simulée : fond, carte en perspective, éclairage
 * inégal, reflet, balance des blancs, flou, grain. Rend le PNG et les coins
 * réels de la carte dans la scène.
 *
 * `sansCarte` : la même photo sans la carte (coins à `null`), pour mesurer ce
 * que la chaîne invente sur un fond et ses parasites. `parasites` (nombre)
 * remplace `parasite` (booléen) par des rectangles plus variés : tournés,
 * parfois cerclés d'un liseré sombre comme un téléphone ou une boîte.
 */
window.__scene = async (url, p) => sceneDepuis(p.sansCarte ? null : await carteCanonique(url), p);

/** La scène, depuis une carte déjà rendue (ImageData, n'importe quelle résolution), ou sans carte. */
async function sceneDepuis(carte, p) {
  const alea = aleatoire(p.graine);

  // Position et perspective de la carte.
  const hauteur = (p.taille ?? 0.5) * SCENE_H;
  const largeur = hauteur * (59 / 86);
  const cx = SCENE_L / 2 + (alea() - 0.5) * (SCENE_L - largeur) * 0.8;
  const cy = SCENE_H / 2 + (alea() - 0.5) * (SCENE_H - hauteur) * 0.8;
  const angle = ((alea() - 0.5) * 2 * (p.rotation ?? 0) * Math.PI) / 180;
  const base = [
    { x: -largeur / 2, y: -hauteur / 2 },
    { x: largeur / 2, y: -hauteur / 2 },
    { x: largeur / 2, y: hauteur / 2 },
    { x: -largeur / 2, y: hauteur / 2 },
  ];
  const coins = base.map(({ x, y }) => {
    const px = x + (alea() - 0.5) * p.perspective * largeur;
    const py = y + (alea() - 0.5) * p.perspective * hauteur * 0.6;
    return {
      x: cx + px * Math.cos(angle) - py * Math.sin(angle),
      y: cy + px * Math.sin(angle) + py * Math.cos(angle),
    };
  });
  if (p.retournee) coins.push(coins.shift(), coins.shift());
  // La carte reste entière dans le cadre : c'est la consigne donnée à
  // l'utilisateur (un guide à l'écran), pas une hypothèse sur sa dextérité.
  {
    const xs = coins.map((c) => c.x);
    const ys = coins.map((c) => c.y);
    const bx = [Math.min(...xs), Math.max(...xs)];
    const by = [Math.min(...ys), Math.max(...ys)];
    const bord = 12;
    const s = Math.min(1, (SCENE_L - 2 * bord) / (bx[1] - bx[0]), (SCENE_H - 2 * bord) / (by[1] - by[0]));
    const dx = Math.max(0, bord - bx[0]) - Math.max(0, bx[1] - (SCENE_L - bord));
    const dy = Math.max(0, bord - by[0]) - Math.max(0, by[1] - (SCENE_H - bord));
    for (const c of coins) {
      c.x = cx + (c.x - cx) * s + dx * s;
      c.y = cy + (c.y - cy) * s + dy * s;
    }
  }

  // Fond : dégradé + trame, couleur tirée au sort.
  const [scene, sx] = canvasDe(SCENE_L, SCENE_H);
  const teinte = [alea() * 255, alea() * 255, alea() * 255].map(Math.round);
  const grad = sx.createLinearGradient(0, 0, SCENE_L, SCENE_H);
  grad.addColorStop(0, `rgb(${teinte.join(',')})`);
  grad.addColorStop(1, `rgb(${teinte.map((v) => Math.round(v * 0.5)).join(',')})`);
  sx.fillStyle = grad;
  sx.fillRect(0, 0, SCENE_L, SCENE_H);
  if (p.fondTexture) {
    sx.fillStyle = 'rgba(255,255,255,0.12)';
    const pas = 24 + alea() * 40;
    for (let y = 0; y < SCENE_H; y += pas) sx.fillRect(0, y, SCENE_L, 2);
    for (let x = 0; x < SCENE_L; x += pas) sx.fillRect(x, 0, 2, SCENE_H);
  }
  // Un rectangle parasite (une autre carte, un téléphone) sur le fond.
  if (p.parasite) {
    sx.fillStyle = `rgb(${[alea() * 255, alea() * 255, alea() * 255].map(Math.round).join(',')})`;
    sx.fillRect(alea() * SCENE_L * 0.6, alea() * SCENE_H * 0.7, SCENE_L * 0.3, SCENE_H * 0.2);
  }
  // Des parasites plus trompeurs : rectangle plein, tourné, aux proportions
  // d'un objet posé sur la table, une fois sur deux cerclé d'un liseré sombre
  // (un téléphone, une boîte de deck). Ils ne portent aucune illustration :
  // ce que la chaîne y reconnaît, elle l'invente.
  for (let n = 0; n < (p.parasites ?? 0); n += 1) {
    const l = SCENE_L * (0.2 + alea() * 0.4);
    const h = l * (0.6 + alea() * 1.4);
    const x = SCENE_L * (0.1 + alea() * 0.8);
    const y = SCENE_H * (0.1 + alea() * 0.8);
    const a = (alea() - 0.5) * Math.PI * 0.5;
    const bordure = alea() < 0.5;
    sx.save();
    sx.translate(x, y);
    sx.rotate(a);
    if (bordure) {
      sx.fillStyle = `rgb(${[alea() * 40, alea() * 40, alea() * 40].map(Math.round).join(',')})`;
      sx.fillRect(-l / 2, -h / 2, l, h);
    }
    const marge = bordure ? Math.round(l * 0.03) : 0;
    sx.fillStyle = `rgb(${[alea() * 255, alea() * 255, alea() * 255].map(Math.round).join(',')})`;
    sx.fillRect(-l / 2 + marge, -h / 2 + marge, l - 2 * marge, h - 2 * marge);
    sx.restore();
  }

  // La carte, par homographie scène → carte.
  const fond = sx.getImageData(0, 0, SCENE_L, SCENE_H);
  const versCarte = carte
    ? homographie(coins, [
      { x: 0, y: 0 },
      { x: carte.width - 1, y: 0 },
      { x: carte.width - 1, y: carte.height - 1 },
      { x: 0, y: carte.height - 1 },
    ])
    : null;
  const rendu = carte ? deformer(carte, versCarte, SCENE_L, SCENE_H) : fond;
  // `deformer` met du noir hors source ; on y remet le fond.
  const insideMask = (x, y) => {
    if (!carte) return false;
    const w = versCarte[6] * x + versCarte[7] * y + versCarte[8];
    const u = (versCarte[0] * x + versCarte[1] * y + versCarte[2]) / w;
    const v = (versCarte[3] * x + versCarte[4] * y + versCarte[5]) / w;
    return u >= 0 && v >= 0 && u < carte.width - 1 && v < carte.height - 1;
  };
  const d = rendu.data;
  const f = fond.data;
  // Éclairage : dégradé linéaire aléatoire, reflet spéculaire sur la carte.
  const lx = alea();
  const ly = alea();
  const reflet = { x: cx + (alea() - 0.5) * largeur, y: cy + (alea() - 0.5) * hauteur, r: hauteur * (0.15 + alea() * 0.25) };
  const balance = [1 + (alea() - 0.5) * 0.3, 1, 1 + (alea() - 0.5) * 0.3];
  const gamma = 0.8 + alea() * 0.5;
  for (let y = 0; y < SCENE_H; y += 1) {
    for (let x = 0; x < SCENE_L; x += 1) {
      const i = (y * SCENE_L + x) * 4;
      const dedans = insideMask(x, y);
      const lumiere = 1 - p.eclairage * (Math.abs(x / SCENE_L - lx) + Math.abs(y / SCENE_H - ly)) * 0.5;
      let spec = 0;
      if (dedans && p.reflet) {
        const dist = Math.hypot(x - reflet.x, y - reflet.y) / reflet.r;
        spec = dist < 1 ? p.reflet * (1 - dist) ** 2 : 0;
      }
      for (let c = 0; c < 3; c += 1) {
        let v = dedans ? d[i + c] : f[i + c];
        v = 255 * (v / 255) ** gamma;
        v = v * lumiere * balance[c] + 255 * spec;
        d[i + c] = v;
      }
      d[i + 3] = 255;
    }
  }
  sx.putImageData(enImageData(rendu), 0, 0);

  // Flou de mise au point, puis grain du capteur.
  if (p.flou > 0) {
    const [tmp, tx] = canvasDe(SCENE_L, SCENE_H);
    tx.filter = `blur(${p.flou}px)`;
    tx.drawImage(scene, 0, 0);
    sx.filter = 'none';
    sx.drawImage(tmp, 0, 0);
  }
  if (p.bruit > 0) {
    const img = sx.getImageData(0, 0, SCENE_L, SCENE_H);
    for (let i = 0; i < img.data.length; i += 4) {
      const b = (alea() - 0.5) * p.bruit;
      img.data[i] += b;
      img.data[i + 1] += b;
      img.data[i + 2] += b;
    }
    sx.putImageData(img, 0, 0);
  }

  return { png: scene.toDataURL('image/jpeg', 0.85).split(',')[1], coins: carte ? coins : null, largeur: SCENE_L, hauteur: SCENE_H };
}

/* --- Identification -------------------------------------------------------- */

/** ImageData d'un canvas réduit à `largeur` px de large. */
function reduit(source, largeur) {
  const facteur = source.width / largeur;
  const hauteur = Math.round(source.height / facteur);
  const [, cx] = canvasDe(largeur, hauteur);
  cx.drawImage(source, 0, 0, largeur, hauteur);
  return { image: cx.getImageData(0, 0, largeur, hauteur), facteur };
}

/** Empreinte de la zone d'illustration d'une carte redressée, dans les deux sens. */
function empreintesRedressee(carte) {
  const z = zoneArt('standard');
  const [source, sx] = canvasDe(carte.width, carte.height);
  sx.putImageData(enImageData(carte), 0, 0);
  const sorties = [];
  for (const demiTour of [false, true]) {
    const [, cx] = canvasDe(z.width, z.height);
    if (demiTour) {
      cx.translate(z.width, z.height);
      cx.rotate(Math.PI);
      cx.drawImage(source, carte.width - z.x - z.width, carte.height - z.y - z.height, z.width, z.height, 0, 0, z.width, z.height);
    } else {
      cx.drawImage(source, z.x, z.y, z.width, z.height, 0, 0, z.width, z.height);
    }
    sorties.push(empreinte(cx.getImageData(0, 0, z.width, z.height)));
  }
  return sorties;
}

/**
 * Chaîne complète : quadrilatère → redressement → empreinte → recherche.
 * `coinsVrais` (facultatif) mesure aussi la borne haute : l'appariement avec
 * le vrai quadrilatère, pour séparer les échecs de détection des échecs
 * d'appariement.
 */
window.__identifier = async (b64, coinsVrais = null, { hypotheses = 40, finalistes = 6, largeur = LARGEUR_DETECTION, lignes = 24, bande = 0.03, variantes = 4 } = {}) => {
  const img = await charger(`data:image/jpeg;base64,${b64}`);
  const [scene, sx] = canvasDe(img.naturalWidth, img.naturalHeight);
  sx.drawImage(img, 0, 0);
  const plein = sx.getImageData(0, 0, scene.width, scene.height);
  const { image } = reduit(scene, largeur);

  const r = identifierCarte(plein, image, index, { hypotheses, finalistes, lignes, bande, variantes });
  const resultat = {
    quad: r.quad,
    candidats: r.candidats,
    sens: r.sens,
    hypothese: r.hypothese,
    evaluees: r.evaluees,
    toutes: r.toutes.map((h) => ({ nom: h.nom, coins: h.coins, id: h.candidats[0]?.id, score: h.score })),
    msQuad: r.ms.quad,
    msTotal: r.ms.total,
    ms: r.ms,
  };

  if (coinsVrais) {
    const carte = redresser(plein, coinsVrais);
    const [droite] = empreintesRedressee(carte);
    resultat.borne = chercher(index, droite, 5);
  }
  return resultat;
};

window.__pret = true;

/** La scène avec le quadrilatère trouvé (vert) et le vrai (rouge), pour l'œil. */
window.__dessiner = async (b64, trouve, vrai) => {
  const img = await charger(`data:image/jpeg;base64,${b64}`);
  const [c, cx] = canvasDe(img.naturalWidth, img.naturalHeight);
  cx.drawImage(img, 0, 0);
  for (const [coins, couleur] of [[vrai, 'red'], [trouve, 'lime']]) {
    if (!coins) continue;
    cx.strokeStyle = couleur;
    cx.lineWidth = 4;
    cx.beginPath();
    coins.forEach((p, i) => (i ? cx.lineTo(p.x, p.y) : cx.moveTo(p.x, p.y)));
    cx.closePath();
    cx.stroke();
  }
  return c.toDataURL('image/jpeg', 0.7).split(',')[1];
};

/**
 * L'affinage seul : on perturbe les vrais coins de ±`amplitude` px et l'on
 * mesure l'erreur avant et après. Sépare la qualité de l'affinage de celle de
 * la détection.
 */
window.__affinerTest = async (b64, coinsVrais, amplitude, graine) => {
  const img = await charger(`data:image/jpeg;base64,${b64}`);
  const [scene, sx] = canvasDe(img.naturalWidth, img.naturalHeight);
  sx.drawImage(img, 0, 0);
  const plein = sx.getImageData(0, 0, scene.width, scene.height);
  const alea = aleatoire(graine);
  const perturbes = coinsVrais.map((p) => ({ x: p.x + (alea() - 0.5) * 2 * amplitude, y: p.y + (alea() - 0.5) * 2 * amplitude }));
  const t0 = performance.now();
  const affines = affiner(plein, perturbes);
  const ms = performance.now() - t0;
  const erreur = (c) => Math.max(...c.map((p, i) => Math.hypot(p.x - coinsVrais[i].x, p.y - coinsVrais[i].y)));
  return { avant: erreur(perturbes), apres: erreur(affines), ms: Math.round(ms) };
};

/**
 * Pourquoi la vraie carte n'est pas proposée : pour chaque vrai côté, la
 * droite de Hough la plus proche (écart en px et en degrés, à l'échelle de
 * détection), puis le sort du vrai quadrilatère face aux critères.
 */
window.__diagnostic = async (b64, coinsVrais, { largeur = LARGEUR_DETECTION, lignes = 24 } = {}) => {
  const Q = await import('/src/lib/quad.js');
  const P = await import('/src/lib/preprocess.js');
  const img = await charger(`data:image/jpeg;base64,${b64}`);
  const [scene, sx] = canvasDe(img.naturalWidth, img.naturalHeight);
  sx.drawImage(img, 0, 0);
  const { image, facteur } = reduit(scene, largeur);
  const { width, height } = image;
  const gray = Q.flouter(P.toGrayscale(image), width, height);
  const { magnitude, orientation } = Q.sobel(gray, width, height);
  const droites = Q.droitesHough(magnitude, orientation, width, height, { n: lignes });
  const vrais = coinsVrais.map((p) => ({ x: p.x / facteur, y: p.y / facteur }));
  const cotes = [];
  for (let c = 0; c < 4; c += 1) {
    const a = vrais[c];
    const b = vrais[(c + 1) % 4];
    const theta = Math.atan2(b.x - a.x, -(b.y - a.y));
    const th = ((theta % Math.PI) + Math.PI) % Math.PI;
    const rho = a.x * Math.cos(th) + a.y * Math.sin(th);
    let meilleure = null;
    droites.forEach((d, rang) => {
      let dth = Math.abs(d.theta - th) % Math.PI;
      if (dth > Math.PI / 2) dth = Math.PI - dth;
      // rho de la droite de Hough, ramené au même signe de normale
      const drho = Math.abs(Math.abs(d.rho) - Math.abs(rho));
      const ecart = drho + dth * 60;
      if (!meilleure || ecart < meilleure.ecart) meilleure = { rang, drho: Math.round(drho), ddeg: Math.round((dth * 180) / Math.PI), ecart };
    });
    cotes.push(meilleure);
  }
  // Le vrai quadrilatère passe-t-il les critères ? On rejoue la recherche en
  // journalisant chaque combinaison, et l'on regarde celle des quatre droites
  // les plus proches des vrais côtés.
  const journal = [];
  const quads = Q.trouverQuads(image, { k: 12, lignes, journal });
  const rangs = cotes.map((c) => c.rang);
  const combinaison = journal.find((e) => rangs.every((r) => e.lignes.includes(r)));
  const acceptes = journal.filter((e) => e.etape === 'accepté').sort((a, b) => b.score - a.score);
  const rangVrai = combinaison ? acceptes.indexOf(combinaison) : -1;
  const resume = (e) => `s${e.appui.toFixed(2)}/n${e.noirceur.toFixed(2)}/r${e.richesse.toFixed(2)}/a${Math.round((100 * e.surface) / (width * height))}%`;
  const vraieCombinaison = combinaison
    ? { etape: combinaison.etape, rang: rangVrai, sur: acceptes.length, vrai: combinaison.etape === 'accepté' ? resume(combinaison) : '', tete: acceptes.slice(0, 3).map(resume).join(' ') }
    : { etape: 'jamais formée (appariement des paires)' };
  const plusProche = quads.reduce((m, q) => {
    const e = Math.max(...q.coins.map((p, i) => Math.hypot(p.x - vrais[i].x, p.y - vrais[i].y)));
    return !m || e < m.e ? { e, rang: quads.indexOf(q), soutien: q.soutien, type: q.type } : m;
  }, null);
  return { cotes, nbDroites: droites.length, vraieCombinaison, candidatsProches: plusProche && Math.round(plusProche.e * facteur), rangProche: plusProche?.rang, soutienProche: plusProche?.soutien?.toFixed(2), typeProche: plusProche?.type };
};

/** Luminance moyenne de bandes intérieures à plusieurs retraits, sur les vrais coins (image de détection). */
window.__bandes = async (b64, coinsVrais, largeur = 448) => {
  const P = await import('/src/lib/preprocess.js');
  const img = await charger(`data:image/jpeg;base64,${b64}`);
  const [scene, sx] = canvasDe(img.naturalWidth, img.naturalHeight);
  sx.drawImage(img, 0, 0);
  const { image, facteur } = reduit(scene, largeur);
  const gray = P.toGrayscale(image);
  const coins = coinsVrais.map((p) => ({ x: p.x / facteur, y: p.y / facteur }));
  const cx = coins.reduce((s, p) => s + p.x, 0) / 4;
  const cy = coins.reduce((s, p) => s + p.y, 0) / 4;
  const petit = Math.min(Math.hypot(coins[1].x - coins[0].x, coins[1].y - coins[0].y), Math.hypot(coins[3].x - coins[0].x, coins[3].y - coins[0].y));
  const sortie = {};
  for (const frac of [-0.03, -0.01, 0.01, 0.02, 0.03, 0.05, 0.08, 0.12]) {
    const retrait = petit * frac;
    const parCote = [];
    for (let c = 0; c < 4; c += 1) {
      const a = coins[c]; const b = coins[(c + 1) % 4];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      let nx = -(b.y - a.y) / L; let ny = (b.x - a.x) / L;
      if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) > 0) { nx = -nx; ny = -ny; }
      let t = 0; let n = 0;
      for (let k = 1; k < 12; k += 1) {
        const x = Math.round(a.x + (b.x - a.x) * k / 12 + nx * retrait); const y = Math.round(a.y + (b.y - a.y) * k / 12 + ny * retrait);
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
        t += gray[y * image.width + x]; n += 1;
      }
      parCote.push(n ? Math.round(t / n) : -1);
    }
    sortie[frac] = parCote;
  }
  return { petit: Math.round(petit), sortie };
};

/** Les 40 hypothèses distinctes : erreur (à rotation cyclique près) et traits, pour une scène. */
window.__hypotheses = async (b64, coinsVrais, largeur = 448) => {
  const Q = await import('/src/lib/quad.js');
  const img = await charger(`data:image/jpeg;base64,${b64}`);
  const [scene, sx] = canvasDe(img.naturalWidth, img.naturalHeight);
  sx.drawImage(img, 0, 0);
  const { image, facteur } = reduit(scene, largeur);
  const vrais = coinsVrais.map((p) => ({ x: p.x / facteur, y: p.y / facteur }));
  const erreur = (coins) => Math.min(...[0, 1, 2, 3].map((d) => Math.max(...coins.map((p, i) => Math.hypot(p.x - vrais[(i + d) % 4].x, p.y - vrais[(i + d) % 4].y)))));
  const quads = Q.trouverQuads(image, { k: 40 });
  return quads.map((q, i) => `${i}:${q.type[0]} e${Math.round(erreur(q.coins) * facteur)} s${q.soutien.toFixed(2)} n${q.noirceur.toFixed(2)} r${q.richesse.toFixed(2)} a${Math.round((100 * q.aire) / (image.width * image.height))}%`);
};

/** Tolérance de l'appariement à l'erreur de coin : vrais coins perturbés de ±amplitude px. */
window.__tolerance = async (b64, coinsVrais, amplitudes, graine) => {
  const { empreinteDepuisCoins } = await import('/src/lib/identifier.js');
  const img = await charger(`data:image/jpeg;base64,${b64}`);
  const [scene, sx] = canvasDe(img.naturalWidth, img.naturalHeight);
  sx.drawImage(img, 0, 0);
  const plein = sx.getImageData(0, 0, scene.width, scene.height);
  const alea = aleatoire(graine);
  const sortie = {};
  for (const amp of amplitudes) {
    const coins = coinsVrais.map((p) => ({ x: p.x + (alea() - 0.5) * 2 * amp, y: p.y + (alea() - 0.5) * 2 * amp }));
    const e = empreinteDepuisCoins(plein, coins);
    const r = chercher(index, e, 2);
    sortie[amp] = { id: r[0]?.id, score: r[0]?.score, marge: (r[0]?.score ?? 0) - (r[1]?.score ?? 0) };
  }
  return sortie;
};

/**
 * Écart signé (vers l'intérieur positif) entre chaque côté de l'hypothèse la
 * plus proche et le vrai côté, en % du petit côté de la carte.
 */
window.__ecarts = async (b64, coinsVrais, { largeur = 448, bande = 0.03 } = {}) => {
  const Q = await import('/src/lib/quad.js');
  const P = await import('/src/lib/preprocess.js');
  const img = await charger(`data:image/jpeg;base64,${b64}`);
  const [scene, sx] = canvasDe(img.naturalWidth, img.naturalHeight);
  sx.drawImage(img, 0, 0);
  const plein = sx.getImageData(0, 0, scene.width, scene.height);
  const { image, facteur } = reduit(scene, largeur);
  const gris = { gray: P.toGrayscale(plein), width: plein.width, height: plein.height };
  const quads = Q.trouverQuads(image, { k: 40 });
  const cx = coinsVrais.reduce((s, p) => s + p.x, 0) / 4;
  const cy = coinsVrais.reduce((s, p) => s + p.y, 0) / 4;
  const petit = Math.min(Math.hypot(coinsVrais[1].x - coinsVrais[0].x, coinsVrais[1].y - coinsVrais[0].y), Math.hypot(coinsVrais[3].x - coinsVrais[0].x, coinsVrais[3].y - coinsVrais[0].y));
  const ecartsDe = (coins) => {
    // Pour chaque vrai côté, distance signée du milieu du côté correspondant de l'hypothèse (après alignement cyclique).
    let meilleur = null;
    for (let d = 0; d < 4; d += 1) {
      const c = [0, 1, 2, 3].map((i) => coins[(i + d) % 4]);
      const err = Math.max(...c.map((p, i) => Math.hypot(p.x - coinsVrais[i].x, p.y - coinsVrais[i].y)));
      if (!meilleur || err < meilleur.err) meilleur = { err, c };
    }
    const out = [];
    for (let i = 0; i < 4; i += 1) {
      const a = coinsVrais[i]; const b = coinsVrais[(i + 1) % 4];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      let nx = -(b.y - a.y) / L; let ny = (b.x - a.x) / L;
      if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) > 0) { nx = -nx; ny = -ny; } // vers l'intérieur
      const ha = meilleur.c[i]; const hb = meilleur.c[(i + 1) % 4];
      const mx = (ha.x + hb.x) / 2 - (a.x + b.x) / 2; const my = (ha.y + hb.y) / 2 - (a.y + b.y) / 2;
      out.push(Math.round(((mx * nx + my * ny) / petit) * 1000) / 10);
    }
    return { err: meilleur.err, ecarts: out };
  };
  let brut = null; let affine = null;
  for (const q of quads) {
    if (q.type !== 'carte') continue;
    const base = Q.remettreEchelle(q.coins, facteur);
    const eb = ecartsDe(base);
    if (!brut || eb.err < brut.err) { brut = eb; affine = ecartsDe(Q.affiner(gris, base, { bande })); }
  }
  return { brut, affine };
};



/**
 * Traits de tous les candidats acceptés d'une scène, avec leur étiquette
 * (vrai contour : erreur de coin < 4 % du petit côté, à rotation près), pour
 * ajuster le pré-classement sur des données plutôt qu'à la main.
 */
window.__traits = async (b64, coinsVrais, largeur = 448) => {
  const Q = await import('/src/lib/quad.js');
  const img = await charger(`data:image/jpeg;base64,${b64}`);
  const [scene, sx] = canvasDe(img.naturalWidth, img.naturalHeight);
  sx.drawImage(img, 0, 0);
  const { image, facteur } = reduit(scene, largeur);
  const vrais = coinsVrais.map((p) => ({ x: p.x / facteur, y: p.y / facteur }));
  const petit = Math.min(Math.hypot(vrais[1].x - vrais[0].x, vrais[1].y - vrais[0].y), Math.hypot(vrais[3].x - vrais[0].x, vrais[3].y - vrais[0].y));
  const erreur = (coins) => Math.min(...[0, 1, 2, 3].map((d) => Math.max(...coins.map((p, i) => Math.hypot(p.x - vrais[(i + d) % 4].x, p.y - vrais[(i + d) % 4].y)))));
  const journal = [];
  Q.trouverQuads(image, { k: 1, journal });
  const acceptes = journal.filter((e) => e.etape === 'accepté');
  const surface = image.width * image.height;
  const lignes = acceptes.map((e) => {
    const coins = Q.ordonner(e.p);
    const err = erreur(coins) / petit;
    return { s: e.appui, n: e.noirceur, r: e.richesse, a: e.surface / surface, ratio: e.ratio, err, vrai: err < 0.04 ? 1 : 0 };
  });
  // Tous les vrais, et jusqu'à 80 faux tirés au hasard.
  const vrais_ = lignes.filter((l) => l.vrai);
  const faux = lignes.filter((l) => !l.vrai).sort(() => Math.random() - 0.5).slice(0, 80);
  return { vrais: vrais_, faux, total: lignes.length };
};

/* --- Lecture du code de tirage sur la carte redressée ------------------- */

/**
 * Une carte haute résolution (visuel officiel 813×1185, sans code : ce sont
 * des « Replica ») sur laquelle on IMPRIME un code de tirage à sa place —
 * sous l'illustration, aligné à droite, 1,75 % de la hauteur — puis mise en
 * scène comme `__scene`. Sert à mesurer à partir de quelle taille de carte à
 * l'écran le code se lit, en borne haute (police approchée, impression nette).
 */
window.__sceneCode = async (url, code, p) => {
  const img = await charger(url);
  const [carte, cx] = canvasDe(img.naturalWidth, img.naturalHeight);
  cx.drawImage(img, 0, 0);
  const h = carte.height;
  cx.font = `bold ${Math.round(h * 0.0175)}px "Liberation Sans", Arial, sans-serif`;
  cx.textAlign = 'right';
  cx.textBaseline = 'alphabetic';
  cx.fillStyle = '#1a1a1a';
  cx.fillText(code, Math.round(carte.width * 0.905), Math.round(h * 0.7475));
  const source = cx.getImageData(0, 0, carte.width, carte.height);
  return sceneDepuis(source, p);
};

/** Position de la bande du code sur une carte redressée (fractions). */
const BANDE_CODE = { x0: 0.45, x1: 0.93, y0: 0.722, y1: 0.758 };

/**
 * Redresse la carte en haute résolution depuis la scène, découpe la bande du
 * code, l'agrandit et la lit avec le moteur OCR de l'application.
 */
window.__lireCode = async (b64, coins, { largeurCarte = 813, hauteurCarte = 1185, zoom = 2 } = {}) => {
  const O = await import('/src/lib/ocr.js');
  const img = await charger(`data:image/jpeg;base64,${b64}`);
  const [scene, sx] = canvasDe(img.naturalWidth, img.naturalHeight);
  sx.drawImage(img, 0, 0);
  const plein = sx.getImageData(0, 0, scene.width, scene.height);
  const t0 = performance.now();
  const carte = redresser(plein, coins, largeurCarte, hauteurCarte);
  const [cc, ccx] = canvasDe(carte.width, carte.height);
  ccx.putImageData(enImageData(carte), 0, 0);
  const x = Math.round(BANDE_CODE.x0 * carte.width);
  const y = Math.round(BANDE_CODE.y0 * carte.height);
  const w = Math.round((BANDE_CODE.x1 - BANDE_CODE.x0) * carte.width);
  const hb = Math.round((BANDE_CODE.y1 - BANDE_CODE.y0) * carte.height);
  const [bande, bx] = canvasDe(w * zoom, hb * zoom);
  bx.imageSmoothingQuality = 'high';
  bx.drawImage(cc, x, y, w, hb, 0, 0, w * zoom, hb * zoom);
  const t1 = performance.now();
  const { text, ms } = await O.recognize(bande);
  return { texte: text, msRedressement: Math.round(t1 - t0), msOcr: ms, bande: bande.toDataURL('image/png').split(',')[1] };
};
window.__ocrPret = async () => (await import('/src/lib/ocr.js')).warmUp().then((r) => r.provider);

/** La lecture du tirage telle que l'application la fait (`src/lib/lireTirage.js`). */
window.__lireTirageApp = async (b64, coins, printings, options = {}) => {
  const L = await import('/src/lib/lireTirage.js');
  const img = await charger(`data:image/jpeg;base64,${b64}`);
  const [scene, sx] = canvasDe(img.naturalWidth, img.naturalHeight);
  sx.drawImage(img, 0, 0);
  const plein = sx.getImageData(0, 0, scene.width, scene.height);
  const r = await L.lireTirage(plein, coins, printings, options);
  return { tirage: r.tirage?.setCode ?? null, exact: Boolean(r.exact), net: Boolean(r.net), ambigu: Boolean(r.ambigu), lecture: r.lecture, brut: r.brut ?? '', similarite: r.similarite, avance: r.avance, raison: r.raison, ms: r.ms };
};
