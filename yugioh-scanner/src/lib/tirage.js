/**
 * Reconnaître le TIRAGE d'une carte déjà identifiée, par son code imprimé.
 *
 * L'illustration dit quelle carte c'est ; le code sous l'illustration
 * (« LDK2-FR001 ») dit quelle édition — et c'est l'édition qui fixe le prix.
 * Comme la carte est connue, le code n'est plus à chercher parmi les 44 000
 * de l'index mais parmi ceux de CETTE carte, trois en médiane, cinquante-neuf
 * au pire. Une lecture OCR approximative suffit alors.
 *
 * Mesuré (`scripts/harness/code-bench.mjs`, 216 bandes rendues, deux images
 * par cas) : 95 % de tirages justes et 0 faux avec la règle « exact tout de
 * suite, sinon deux lectures d'accord » ; 100 % dès que la carte occupe 60 %
 * de la hauteur de l'image. Ce module est pur : la lecture elle-même est
 * dans `lireTirage.js`.
 */

import { codeSimilarity } from './match.js';
import { levenshtein, setCodeMatchKey } from './parse.js';

/** Bande du code sur une carte redressée, en fractions de sa largeur et hauteur. */
export const BANDE_CODE = { x0: 0.45, x1: 0.93, y0: 0.722, y1: 0.758 };

/**
 * Hauteur minimale de la carte, en fraction de la hauteur de l'image, pour
 * tenter une lecture. Mesuré (contraste étiré, correction par gabarit) : à
 * 40 % le tirage est juste dans 64 % des cas (100 % sans flou), 44 % à
 * 35 % ; jamais faux. Une lecture ratée ne coûte qu'une passe du moteur.
 */
export const HAUTEUR_LISIBLE = 0.4;

export const SIMILARITE_MINIMALE = 70;
export const AVANCE_MINIMALE = 5;

/**
 * La carte est-elle assez grande dans l'image pour que son code se lise ?
 * @param {Array<{x:number,y:number}>} coins dans le repère de l'image
 * @param {number} hauteurImage
 */
export function assezGrande(coins, hauteurImage) {
  if (!coins || coins.length !== 4 || !hauteurImage) return false;
  const ys = coins.map((p) => p.y);
  return (Math.max(...ys) - Math.min(...ys)) / hauteurImage >= HAUTEUR_LISIBLE;
}

/** Nettoie une lecture OCR de la bande : majuscules, sans espaces ni ponctuation parasite. */
export function nettoyerLecture(texte) {
  return String(texte ?? '')
    .toUpperCase()
    .replace(/[‐-―−_]/g, '-')
    .replace(/[^A-Z0-9-]/g, '');
}

/**
 * Ce qui, dans la lecture, ressemble à un code de tirage : « MP17-EN171 »
 * au milieu de « MP17-EN171ITTOTHEGY… » quand la bande a attrapé un bout de
 * texte. Sans cela, le texte parasite noyait la similarité (22 sur une
 * lecture qui contenait le code exact). À défaut de motif, la lecture
 * nettoyée entière.
 */
export function extraireCode(lecture) {
  const motif = /[A-Z0-9]{2,5}-[A-Z]{0,2}[A-Z]?[0-9]{2,4}/;
  // D'abord mot par mot (les espaces de l'OCR séparent le code du reste),
  // puis dans la lecture recollée (le texte parasite collé au code).
  const mots = String(lecture ?? '')
    .toUpperCase()
    .replace(/[‐-―−_]/g, '-')
    .split(/[^A-Z0-9-]+/)
    .filter(Boolean);
  for (const mot of mots) {
    const trouve = motif.exec(mot);
    if (trouve) return trouve[0];
  }
  const propre = nettoyerLecture(lecture);
  const trouve = motif.exec(propre);
  return trouve ? trouve[0] : propre;
}

/** Forme d'un code de tirage, région et numéro pouvant être mal lus (lettre pour chiffre). */
const MOTIF_LARGE = /[A-Z0-9]{2,5}-[A-Z]{0,3}[0-9A-Z]{2,4}/g;

/**
 * Toutes les façons de lire un code dans le texte brut de la bande.
 *
 * Mesuré sur 216 bandes rendues : le moteur remplace souvent le tiret par
 * « : », « · », « = », un espace, ou l'oublie (« MP25EN051 »). Tout
 * séparateur vaut donc tiret, et un mot sans tiret est coupé à chaque
 * endroit plausible. L'appariement choisira la meilleure de ces lectures.
 *
 * @param {string} brut texte lu par le moteur
 * @returns {string[]} lectures possibles, en majuscules, avec tiret
 */
export function lecturesPossibles(brut) {
  const texte = String(brut ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  const possibles = new Set(texte.match(MOTIF_LARGE) ?? []);
  for (const mot of texte.split('-')) {
    if (mot.length < 6) continue;
    for (let i = 2; i <= 5 && i < mot.length - 2; i++) {
      const essai = `${mot.slice(0, i)}-${mot.slice(i)}`;
      const trouve = essai.match(MOTIF_LARGE);
      if (trouve && trouve[0] === essai) possibles.add(essai);
    }
  }
  const code = extraireCode(brut);
  if (code) possibles.add(code);
  return [...possibles];
}

/** Lettres que le moteur met pour un chiffre, et l'inverse — là où l'on sait ce qui est attendu. */
const VERS_CHIFFRE = { O: '0', D: '0', Q: '0', U: '0', I: '1', L: '1', T: '1', Z: '2', S: '5', G: '6', B: '8', A: '4' };
const VERS_LETTRE = { 0: 'O', 1: 'I', 2: 'Z', 4: 'A', 5: 'S', 6: 'G', 8: 'B' };

/**
 * Corrige une lecture d'après la forme d'un code de la carte : à chaque
 * position où le code attend un chiffre et où l'on a lu une lettre qui lui
 * ressemble (O pour 0, S pour 5, B pour 8…), on met le chiffre — et
 * l'inverse. On ne touche qu'aux confusions lettre↔chiffre : un 8 lu 0 reste
 * une erreur, que l'appariement traitera comme telle.
 *
 * @param {string} lu clé de lecture (`setCodeMatchKey`), région retirée si reconnue
 * @param {string} cle clé d'un code de la carte
 * @returns {string} la lecture corrigée, ou telle quelle si les formes ne s'alignent pas
 */
export function corrigerSelon(lu, cle) {
  const a = /^([A-Z0-9]+)-([A-Z0-9]+)$/.exec(lu);
  const b = /^([A-Z0-9]+)-([A-Z0-9]+)$/.exec(cle);
  if (!a || !b) return lu;
  const [, prefixe, reste] = a;
  const [, prefixeCle, numeroCle] = b;
  // Le reste : deux lettres de région (si la clé de lecture les a gardées) puis le numéro.
  let numero;
  if (reste.length === numeroCle.length) numero = reste;
  else if (reste.length === numeroCle.length + 2 && /^[A-Z]{2}/.test(reste)) numero = reste.slice(2);
  else return lu;
  const aligner = (texte, modele) => {
    let sortie = '';
    for (let i = 0; i < texte.length; i++) {
      const c = texte[i];
      const attendu = modele[i];
      if (attendu === undefined) sortie += c;
      else if (/[0-9]/.test(attendu) && /[A-Z]/.test(c)) sortie += VERS_CHIFFRE[c] ?? c;
      else if (/[A-Z]/.test(attendu) && /[0-9]/.test(c)) sortie += VERS_LETTRE[c] ?? c;
      else sortie += c;
    }
    return sortie;
  };
  return `${aligner(prefixe, prefixeCle)}-${aligner(numero, numeroCle)}`;
}

/**
 * Distance (en caractères) à laquelle un autre code de la carte doit se tenir
 * pour qu'une lecture exacte soit tenue pour sûre à elle seule. À distance 1
 * (« MP18-064 » et « MP18-004 » sur la même carte : 636 cartes de l'index),
 * un seul chiffre mal lu ferait un faux tirage : ces lectures ne sont
 * jamais « exactes », elles attendent des jumelles.
 */
export const DISTANCE_EXACTE = 2;

const mieux = (a, b) => {
  if (!b) return true;
  if (a.exact !== b.exact) return a.exact;
  if (Boolean(a.tirage) !== Boolean(b.tirage)) return Boolean(a.tirage);
  return a.similarite > b.similarite;
};

/**
 * Le tirage de la carte dont le code ressemble le plus à la lecture.
 *
 * Chaque lecture possible du texte (`lecturesPossibles`), corrigée d'après
 * chaque code de la carte (`corrigerSelon`), est comparée à tous les codes ;
 * on garde la meilleure. Mesuré (`scripts/harness/code-bench.mjs`) : cette
 * correction fait passer les lectures exactes de 58 à 76 % des bandes, sans
 * faux tirage.
 *
 * @param {string} lecture texte brut lu dans la bande
 * @param {Array<{setCode: string}>} printings tirages de la carte identifiée
 * @returns {{tirage: object|null, exact: boolean, ambigu: boolean, similarite: number, avance: number,
 *   lecture: string, candidats: Array<{cle: string, similarite: number}>}}
 *   `tirage` est nul si la lecture ne désigne pas un code assez sûrement ;
 *   `exact` : la lecture EST ce code, et aucun autre code de la carte n'en
 *   est à moins de `DISTANCE_EXACTE` ; `ambigu` : un autre code de la carte
 *   est à un caractère de la lecture.
 */
export function apparierTirage(lecture, printings) {
  const vide = { tirage: null, exact: false, ambigu: false, similarite: 0, avance: 0, lecture: '', candidats: [] };
  // Les codes distincts de la carte, région ignorée : « LOB-EN005 » et
  // « LOB-FR005 » sont le même tirage vu de deux pays.
  const parCle = new Map();
  for (const tirage of printings ?? []) {
    const cle = setCodeMatchKey(tirage.setCode);
    if (cle && !parCle.has(cle)) parCle.set(cle, tirage);
  }
  const cles = [...parCle.keys()];
  if (!cles.length) return vide;

  let meilleur = null;
  for (const possible of lecturesPossibles(lecture)) {
    const base = setCodeMatchKey(possible);
    if (!base || base.length < 5) continue;
    const essais = new Set([base]);
    for (const cle of cles) essais.add(corrigerSelon(base, cle));
    for (const lu of essais) {
      const candidats = cles
        .map((cle) => ({ cle, similarite: codeSimilarity(lu, cle) }))
        .sort((a, b) => b.similarite - a.similarite);
      const [premier, second] = candidats;
      const avance = premier.similarite - (second?.similarite ?? 0);
      const sur = premier.similarite >= SIMILARITE_MINIMALE && (second === undefined || avance >= AVANCE_MINIMALE);
      const loin = second === undefined || levenshtein(lu, second.cle) >= DISTANCE_EXACTE;
      const resultat = {
        tirage: sur ? parCle.get(premier.cle) : null,
        exact: sur && premier.similarite >= 100 && loin,
        ambigu: sur && !loin,
        similarite: premier.similarite,
        avance,
        lecture: lu,
        candidats,
      };
      if (mieux(resultat, meilleur)) meilleur = resultat;
    }
  }
  return meilleur ?? { ...vide, lecture: setCodeMatchKey(extraireCode(lecture)) };
}

/**
 * Restreint les tirages d'une carte à ceux du code reconnu (toutes raretés de
 * ce code), pour l'écran de résultat et l'inventaire.
 */
export function tiragesDuCode(printings, tirage) {
  if (!tirage) return printings ?? [];
  const cle = setCodeMatchKey(tirage.setCode);
  const memes = (printings ?? []).filter((p) => setCodeMatchKey(p.setCode) === cle);
  return memes.length ? memes : [tirage];
}


/**
 * Lectures d'accord (sur des images différentes) avant de tenir un tirage
 * approché pour lu. Une lecture exacte se suffit.
 */
export const LECTURES_CONCORDANTES = 2;
/**
 * Pour un code ambigu (un autre code de la carte à un caractère), seules
 * comptent les lectures qui sont le code tel quel, et il en faut davantage :
 * un chiffre mal lu de la même façon deux fois de suite n'est pas rare.
 */
export const LECTURES_AMBIGUES = 3;

/**
 * Décide, lecture après lecture, du tirage à retenir : tout de suite si la
 * lecture est exacte ; sinon quand `LECTURES_CONCORDANTES` lectures
 * approchées désignent le même code (`LECTURES_AMBIGUES` lectures du code
 * tel quel s'il est ambigu). Une lecture différente remet le compte à zéro.
 * C'est ce qui rend le tirage lu sûr : un faux tirage devrait être lu
 * plusieurs fois de la même façon, sur des images différentes.
 */
export class ConcordanceTirage {
  constructor({ requises = LECTURES_CONCORDANTES, ambigues = LECTURES_AMBIGUES } = {}) {
    this.requises = requises;
    this.ambigues = ambigues;
    this.cle = null;
    this.compte = 0;
  }

  /**
   * @param {{tirage: object|null, exact?: boolean, ambigu?: boolean, similarite?: number}} lu résultat d'`apparierTirage`
   * @returns {object|null} le tirage retenu, ou null
   */
  ajouter(lu) {
    if (!lu?.tirage) return null;
    if (lu.exact) return lu.tirage;
    if (lu.ambigu && (lu.similarite ?? 0) < 100) return null;
    const cle = setCodeMatchKey(lu.tirage.setCode);
    if (cle === this.cle) this.compte += 1;
    else {
      this.cle = cle;
      this.compte = 1;
    }
    return this.compte >= (lu.ambigu ? this.ambigues : this.requises) ? lu.tirage : null;
  }

  reset() {
    this.cle = null;
    this.compte = 0;
  }
}
