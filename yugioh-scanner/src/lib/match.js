/**
 * Appariement local d'une lecture OCR avec la base de cartes.
 *
 * Le problème que ce module résout : `fname` de YGOPRODeck est une recherche
 * par **sous-chaîne**, pas floue. Un seul caractère mal lu et l'API renvoie une
 * 400. Or l'OCR se trompe toujours d'un caractère ou deux. Il faut donc une
 * recherche qui tolère l'erreur, ce qui suppose d'avoir la base sous la main.
 *
 * Trois indices sont combinés, du plus sûr au plus fragile :
 *
 *  1. **le passcode** — huit chiffres, clé unique des 14 523 cartes. Aucune
 *     confusion lettre/chiffre possible : s'il tombe juste, c'est fini ;
 *  2. **le code d'extension** — désigne le tirage exact, donc la série et la
 *     rareté ;
 *  3. **le titre** — le plus lisible mais le plus bruité, rattrapé par une
 *     recherche floue.
 *
 * La recherche floue passe par un index inversé de **trigrammes**. Chercher
 * « blue eyes white dragon » par sous-chaîne échoue dès qu'un caractère saute ;
 * en trigrammes, il reste des dizaines de fragments communs, et le bon candidat
 * remonte quand même. C'est ce qui fait la différence entre « aucun résultat »
 * et « voici les cinq cartes les plus proches ».
 */

import { extractSetCodes, levenshtein, normalizeTitle, setCodeMatchKey } from './parse.js';

/**
 * Poids relatifs des indices.
 *
 * La note est une moyenne pondérée des seuls indices **disponibles**, pas une
 * somme à poids fixes. Sans cette normalisation, une carte reconnue par un titre
 * parfaitement lu plafonnerait à 0,45 alors qu'elle est certaine, et aucun seuil
 * d'acceptation ne voudrait plus rien dire.
 */
const WEIGHT_CODE = 0.55;
const WEIGHT_TITLE = 0.45;

/** Nombre de candidats retenus avant le classement fin. */
const SHORTLIST = 160;

/** En deçà, un titre est trop éloigné pour être proposé. */
const MIN_TITLE_SCORE = 0.34;

/**
 * Trigrammes d'un texte normalisé, bornes comprises.
 * Les deux espaces ajoutés en tête et en queue font ressortir les débuts et
 * fins de mots, qui portent beaucoup d'information sur un nom propre.
 */
export function trigrams(text) {
  const padded = `  ${text} `;
  const result = new Set();
  for (let i = 0; i + 3 <= padded.length; i += 1) result.add(padded.slice(i, i + 3));
  return result;
}

/**
 * Construit les tables de recherche à partir de l'index embarqué.
 *
 * @param {{sets: string[], rarities: string[], cards: Array}} raw
 */
export function buildSearchIndex(raw) {
  const cards = raw.cards.map(([id, name, printings]) => ({
    id,
    name,
    normalized: normalizeTitle(name),
    printings: printings.map(([setIndex, setCode, rarityIndex]) => ({
      setName: raw.sets[setIndex] ?? '',
      setCode,
      rarity: raw.rarities[rarityIndex] ?? '',
    })),
  }));

  const byTrigram = new Map();
  const byPasscode = new Map();
  const byCode = new Map();
  const byExactCode = new Map();

  cards.forEach((card, position) => {
    byPasscode.set(card.id, position);

    for (const trigram of trigrams(card.normalized)) {
      const bucket = byTrigram.get(trigram);
      if (bucket) bucket.push(position);
      else byTrigram.set(trigram, [position]);
    }

    for (const printing of card.printings) {
      const key = setCodeMatchKey(printing.setCode);
      const bucket = byCode.get(key);
      if (bucket) bucket.add(position);
      else byCode.set(key, new Set([position]));

      // Le code tel qu'imprimé, pour la recherche exacte du mode sniper.
      const exact = String(printing.setCode ?? '').toUpperCase();
      const exactBucket = byExactCode.get(exact);
      if (exactBucket) exactBucket.add(position);
      else byExactCode.set(exact, new Set([position]));
    }
  });

  return { version: raw.version, cards, byTrigram, byPasscode, byCode, byExactCode };
}

/**
 * Complétions plausibles d'un passcode à sept chiffres.
 *
 * Un chiffre saute à la lecture, et pas forcément le premier. On essaie donc
 * l'insertion d'un chiffre à chacune des huit positions — quatre-vingts clés à
 * éprouver, autant dire rien — et on ne retient le résultat que s'il est unique.
 * Deux candidats valides valent une absence de candidat : mieux vaut laisser le
 * titre trancher que jouer à pile ou face sur l'identité de la carte.
 */
export function completePasscode(byPasscode, digits) {
  if (digits.length !== 7) return null;

  const hits = new Set();
  for (let position = 0; position <= 7; position += 1) {
    for (let digit = 0; digit <= 9; digit += 1) {
      const candidate = Number(`${digits.slice(0, position)}${digit}${digits.slice(position)}`);
      if (byPasscode.has(candidate)) hits.add(candidate);
    }
  }

  return hits.size === 1 ? [...hits][0] : null;
}

/**
 * Présélection par trigrammes.
 *
 * On compte les trigrammes partagés, puis on normalise par la taille des deux
 * chaînes (indice de Jaccard) : sans cela, les noms très longs sortiraient
 * systématiquement en tête, ayant plus de trigrammes à partager.
 */
function shortlist(index, title) {
  const wanted = trigrams(normalizeTitle(title));
  if (wanted.size === 0) return [];

  const shared = new Map();
  for (const trigram of wanted) {
    const bucket = index.byTrigram.get(trigram);
    if (!bucket) continue;
    for (const position of bucket) shared.set(position, (shared.get(position) ?? 0) + 1);
  }

  const scored = [];
  for (const [position, count] of shared) {
    const card = index.cards[position];
    const union = wanted.size + card.normalized.length + 3 - count;
    scored.push([position, count / union]);
  }

  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, SHORTLIST).map(([position]) => position);
}

const similarity = (a, b) => {
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
};

/**
 * Classe les cartes de la base selon ce que l'OCR a pu lire.
 *
 * @param {object} index résultat de `buildSearchIndex`
 * @param {{passcode?: string, setCode?: {matchKey: string}, title?: string}} reading
 * @param {{limit?: number}} options
 * @returns {Array<{card: object, score: number, titleScore: number,
 *   codeMatched: boolean, printings: object[], reasons: string[]}>}
 */
export function findCandidates(index, reading, { limit = 5 } = {}) {
  const { passcode, setCode, title } = reading;
  const matchKey = setCode?.matchKey ?? null;
  const normalizedTitle = title ? normalizeTitle(title) : '';

  // 1. Le passcode tranche seul : c'est une clé primaire, pas un indice.
  const key = resolvePasscode(index, passcode);
  if (key !== null) {
    const card = index.cards[index.byPasscode.get(key)];
    return [
      {
        card,
        score: 1,
        titleScore: normalizedTitle ? similarity(normalizedTitle, card.normalized) : 0,
        codeMatched: Boolean(matchKey) && card.printings.some((p) => setCodeMatchKey(p.setCode) === matchKey),
        printings: printingsFor(card, matchKey),
        reasons: ['passcode'],
      },
    ];
  }

  // 2. Sinon on rassemble les candidats du code et ceux du titre.
  const positions = new Set(matchKey ? (index.byCode.get(matchKey) ?? []) : []);
  if (normalizedTitle.length >= 3) {
    for (const position of shortlist(index, title)) positions.add(position);
  }
  if (positions.size === 0) return [];

  // Seuls les indices effectivement lus entrent dans la moyenne.
  const total = (matchKey ? WEIGHT_CODE : 0) + (normalizedTitle ? WEIGHT_TITLE : 0);

  const results = [];
  for (const position of positions) {
    const card = index.cards[position];
    const codeMatched =
      Boolean(matchKey) && card.printings.some((p) => setCodeMatchKey(p.setCode) === matchKey);
    const titleScore = normalizedTitle ? similarity(normalizedTitle, card.normalized) : 0;

    // Un titre très éloigné ne vaut d'être proposé que si le code, lui, colle.
    if (!codeMatched && titleScore < MIN_TITLE_SCORE) continue;

    const reasons = [];
    if (codeMatched) reasons.push('code');
    if (titleScore >= MIN_TITLE_SCORE) reasons.push('titre');

    const weighted =
      (matchKey ? WEIGHT_CODE * (codeMatched ? 1 : 0) : 0) +
      (normalizedTitle ? WEIGHT_TITLE * titleScore : 0);

    results.push({
      card,
      score: total > 0 ? weighted / total : 0,
      titleScore,
      codeMatched,
      printings: printingsFor(card, matchKey),
      reasons,
    });
  }

  results.sort((a, b) => b.score - a.score || b.titleScore - a.titleScore);
  return results.slice(0, limit);
}

/**
 * Passcode exploitable : lu en entier, ou reconstitué sans ambiguïté.
 * @returns {number|null} la clé présente dans la base, ou `null`
 */
export function resolvePasscode(index, passcode) {
  const digits = String(passcode ?? '').replace(/[^0-9]/g, '');
  if (digits.length === 8) {
    const value = Number(digits);
    return index.byPasscode.has(value) ? value : null;
  }
  return completePasscode(index.byPasscode, digits);
}

/**
 * Tirages à proposer : ceux du code lu s'il en désigne, sinon tous.
 * Une carte réimprimée dix fois n'a qu'un tirage pertinent quand le code a été
 * lu ; sans code, l'utilisateur devra trancher lui-même.
 */
function printingsFor(card, matchKey) {
  if (!matchKey) return card.printings;
  const exact = card.printings.filter((p) => setCodeMatchKey(p.setCode) === matchKey);
  return exact.length > 0 ? exact : card.printings;
}

/** Raretés distinctes d'une liste de tirages, dans l'ordre rencontré. */
export function distinctRarities(printings) {
  const seen = [];
  for (const printing of printings) {
    if (!seen.some((known) => known.rarity === printing.rarity)) seen.push(printing);
  }
  return seen;
}

/**
 * Une zone a-t-elle livré quelque chose d'exploitable ?
 *
 * Le critère n'est pas « la regex a trouvé une forme valide » mais « la valeur
 * existe dans la base ». Sans cela, un code bien formé mais mal lu — « IOR-EN001 »
 * pour « LOB-EN001 » — marquerait la zone comme réglée et empêcherait les passes
 * suivantes de retenter la lecture avec une autre binarisation.
 */
export function zoneSatisfied(index, found, zoneId) {
  if (zoneId === 'title') return (found.title?.length ?? 0) >= 4;

  if (zoneId === 'setCode') {
    return Boolean(found.setCode) && (!index || index.byCode.has(found.setCode.matchKey));
  }

  if (zoneId === 'passcode') {
    return index
      ? resolvePasscode(index, found.passcode) !== null
      : (found.passcode?.length ?? 0) === 8;
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* Mode « sniper » : résolution par le seul code d'extension            */
/* ------------------------------------------------------------------ */

/**
 * Note plancher d'une correspondance approchée, sur 100.
 *
 * Les clés comparées font sept ou huit caractères pour 99 % de l'index : à
 * cette longueur, un seul caractère d'écart vaut 85,7 ou 87,5. Un plancher à
 * 82 acceptait donc *toute* lecture à une erreur près — et sur 37 000 clés,
 * une lecture abîmée en trouve presque toujours une. À 88, une clé courte doit
 * être lue sans faute ; seules les clés de neuf caractères et plus tolèrent
 * encore un écart.
 *
 * Mesuré (`scripts/ocr-confusions.mjs`, 60 codes réels × 2 dégradations) :
 * voir le tableau dans `PASSATION.md`, § 3. C'est le point de bascule : en
 * dessous, l'approché rend plus de mauvaises cartes que de bonnes.
 */
export const FUZZY_CUTOFF = 88;

/**
 * Écart minimal, sur 100, entre le meilleur candidat approché et le second.
 *
 * Deux codes différents à la même note ne désignent rien : « RA03-10 » est
 * aussi proche de « RA03-010 » que de « RA03-100 », et choisir le premier
 * rencontré revient à tirer au sort. Les notes sont quantifiées par la
 * longueur des clés (pas de 12,5 ou 14,3 entre deux distances d'édition), de
 * sorte que toute valeur entre 0 exclu et 10 signifie « aucune égalité ».
 */
export const FUZZY_MARGIN = 1;

/**
 * Similarité de deux codes, sur 100 : distance de Levenshtein rapportée à la
 * longueur du plus long. Le serveur applique la même formule
 * (`Levenshtein.normalized_similarity` de rapidfuzz, sur la clé sans région),
 * pour que les deux implémentations rendent le même verdict sur la même
 * lecture. `fuzz.ratio`, lui, compte une substitution pour deux opérations et
 * ne donne pas les mêmes notes.
 */
export function codeSimilarity(a, b) {
  if (!a || !b) return 0;
  return (1 - levenshtein(a, b) / Math.max(a.length, b.length)) * 100;
}

/**
 * Résout une lecture OCR en tirage, sur l'index local.
 *
 * Reproduit la logique du backend Python : exact, puis régional, puis approché.
 * L'index embarqué ne contient que les codes anglais publiés par YGOPRODeck ;
 * la régionalisation se fait donc ici par *retrait* de la région plutôt que par
 * génération des variantes — même résultat, sans multiplier l'index par six.
 *
 * @param {{cutoff?: number, margin?: number}} options plancher et marge de
 *   l'approché, sur 100 — surchargeables pour les bancs de mesure
 * @returns {{status: 'no_code'|'no_match'|'matched', read?: string,
 *   reason?: 'ambiguous', code?: string, matchedCode?: string, method?: string,
 *   confidence?: number, card?: object, printings?: object[], rarities?: object[]}}
 */
export function resolveSetCode(
  index,
  raw,
  { cutoff = FUZZY_CUTOFF, margin = FUZZY_MARGIN } = {},
) {
  const candidates = extractSetCodes(raw);
  if (candidates.length === 0) return { status: 'no_code', read: raw };

  // 1. Le code lu existe tel quel.
  for (const candidate of candidates) {
    const positions = index.byExactCode.get(candidate.code);
    if (positions) return describe(index, candidate, candidate.code, 'exact', 100, positions);
  }

  // 2. Son équivalent dans une autre région existe.
  for (const candidate of candidates) {
    const positions = index.byCode.get(candidate.matchKey);
    if (positions) {
      const printed = printedCodeFor(index, positions, candidate.matchKey, candidate.region);
      return describe(index, candidate, printed, 'region', 100, positions);
    }
  }

  // 3. Le plus proche au-delà du plancher. On compare sur la clé sans région :
  // sinon un « FR » face à un « EN » coûterait deux caractères d'écart pour
  // une différence qui n'en est pas une.
  //
  // Chaque clé garde sa meilleure note, tous candidats confondus : les
  // candidats sont des transpositions d'une même lecture, et une clé ne doit
  // pas se faire concurrence à elle-même au moment de juger l'ambiguïté.
  const scores = new Map();
  for (const candidate of candidates) {
    for (const key of index.byCode.keys()) {
      const score = codeSimilarity(candidate.matchKey, key);
      if (score >= cutoff && score > (scores.get(key)?.score ?? -1)) {
        scores.set(key, { candidate, score });
      }
    }
  }

  let best = null;
  let runnerUp = null;
  for (const [key, hit] of scores) {
    if (best === null || hit.score > best.score) {
      runnerUp = best;
      best = { key, ...hit };
    } else if (runnerUp === null || hit.score > runnerUp.score) {
      runnerUp = { key, ...hit };
    }
  }

  const read = candidates.map((c) => c.code);
  if (!best) return { status: 'no_match', read: raw, candidates: read };

  // Une lecture qui hésite entre deux cartes ne désigne aucune des deux.
  if (runnerUp && best.score - runnerUp.score < margin) {
    return {
      status: 'no_match',
      reason: 'ambiguous',
      read: raw,
      candidates: read,
      between: [best.key, runnerUp.key],
    };
  }

  const positions = index.byCode.get(best.key);
  const printed = printedCodeFor(index, positions, best.key, best.candidate.region);
  return describe(index, best.candidate, printed, 'fuzzy', best.score, positions);
}

/**
 * Le code tel qu'imprimé sur l'un des tirages désignés.
 *
 * On préfère celui dont la région correspond à ce qui a été lu, puis la forme
 * anglaise. « LOB-001 » et « LOB-EN001 » désignent le même tirage : renvoyer le
 * premier venu afficherait une référence que l'utilisateur ne lit pas sur sa carte.
 */
function printedCodeFor(index, positions, matchKey, readRegion = '') {
  const matching = [];
  for (const position of positions) {
    for (const printing of index.cards[position].printings) {
      if (setCodeMatchKey(printing.setCode) === matchKey) matching.push(printing.setCode);
    }
  }
  if (matching.length === 0) return matchKey;

  const withRegion = (region) =>
    matching.find((code) => code.includes(`-${region}`) || code.includes(`-${region}`));

  return (readRegion && withRegion(readRegion)) || withRegion('EN') || matching[0];
}

function describe(index, candidate, matchedCode, method, confidence, positions) {
  const matchKey = setCodeMatchKey(matchedCode);
  const position = [...positions][0];
  const card = index.cards[position];

  const printings = card.printings.filter(
    (printing) => setCodeMatchKey(printing.setCode) === matchKey,
  );

  // Le code publié par YGOPRODeck est toujours la forme anglaise. Quand la
  // carte en main porte une autre région, on affiche ce qui y est imprimé :
  // l'utilisateur doit reconnaître son exemplaire, pas sa contrepartie anglaise.
  //
  // Réservé aux correspondances sûres : sur un rapprochement approché, la
  // lecture contient précisément l'erreur qu'on vient de rattraper, et
  // l'afficher reviendrait à présenter la faute comme la référence.
  const regional =
    method !== 'fuzzy' && candidate.region !== '' && candidate.code !== matchedCode;

  return {
    status: 'matched',
    read: candidate.code,
    code: candidate.code,
    matchedCode: regional ? candidate.code : matchedCode,
    sourceCode: matchedCode,
    method,
    confidence: Math.round(confidence * 10) / 10,
    regional,
    card,
    printings,
    rarities: distinctRarities(printings),
  };
}

/* ------------------------------------------------------------------ */
/* Saisie manuelle : complétion d'un code en cours de frappe            */
/* ------------------------------------------------------------------ */

/**
 * Codes de l'index qui commencent par ce que l'utilisateur a tapé.
 *
 * La saisie manuelle existe pour les cas où la caméra ne peut pas : pas de
 * caméra, carte abîmée, code effacé. Compléter pendant la frappe évite les
 * fautes de frappe (le code n'est jamais tapé en entier) et montre tout de
 * suite si le code existe.
 *
 * La région tapée est conservée dans les propositions : quelqu'un qui tape
 * « RA03-FR0 » veut voir « RA03-FR001 », pas la forme anglaise. Tant que la
 * région n'est pas complète, on complète sur le préfixe seul.
 *
 * @param {object} index résultat de `buildSearchIndex`
 * @param {string} typed saisie brute, casse et espaces libres
 * @returns {Array<{code: string, key: string, name: string}>}
 */
export function suggestSetCodes(index, typed, { limit = 6 } = {}) {
  const text = String(typed ?? '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[\u2010-\u2015\u2212_]/g, '-')
    .replace(/[^A-Z0-9-]/g, '');
  if (text.length < 2) return [];

  const parts = /^([A-Z0-9]{1,5})(?:-([A-Z]{0,2})([A-Z0-9]*))?$/.exec(text);
  if (!parts) return [];
  const [, prefix, region = '', rest = ''] = parts;
  const hasDash = text.includes('-');

  // Région complète : on cherche « PREFIXE-NUMERO » ; sinon « PREFIXE- » ou
  // « PREFIXE » seul. Une région d'une lettre ne restreint rien : elle peut
  // encore devenir n'importe laquelle.
  let wanted = prefix;
  if (hasDash) wanted += region.length === 2 ? `-${rest}` : '-';

  if (!index.sortedCodes) {
    index.sortedCodes = [...index.byCode.keys()].sort();
  }

  const out = [];
  for (const key of index.sortedCodes) {
    if (!key.startsWith(wanted)) {
      if (out.length > 0 && key > wanted) break;
      continue;
    }
    const position = [...index.byCode.get(key)][0];
    const card = index.cards[position];
    const printed = region.length === 2 ? key.replace('-', `-${region}`) : key.replace('-', '-EN');
    out.push({ code: printed, key, name: card.name });
    if (out.length >= limit) break;
  }
  return out;
}
