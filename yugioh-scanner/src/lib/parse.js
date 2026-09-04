/**
 * Extraction du code d'extension et du titre depuis le texte brut de Tesseract.
 *
 * L'OCR d'un code d'extension se trompe presque toujours de la même façon :
 * il confond des glyphes qui se ressemblent (O/0, I/1, S/5, B/8, Z/2, G/6).
 * Comme le format d'un code est rigide -- `PREFIXE-REGION` + numéro -- on sait
 * pour chaque position si on attend une lettre ou un chiffre. La correction est
 * donc *positionnelle* : on remappe dans un sens dans le préfixe et la région,
 * dans l'autre dans le numéro. C'est ce qui rattrape « L0B-EN0O1 » en
 * « LOB-EN001 » sans jamais casser un code déjà correct.
 */

/** Régions TCG/OCG connues, pour recaler la partie centrale du code. */
export const REGIONS = ['EN', 'FR', 'DE', 'IT', 'SP', 'PT', 'JP', 'KR', 'AE', 'EU'];

/** Glyphe lu comme un chiffre alors qu'une lettre est attendue. */
const DIGIT_TO_LETTER = { 0: 'O', 1: 'I', 2: 'Z', 5: 'S', 6: 'G', 8: 'B' };

/** Glyphe lu comme une lettre alors qu'un chiffre est attendu. */
const LETTER_TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', G: '6', B: '8' };

const asLetters = (text) =>
  text.replace(/[0-9]/g, (character) => DIGIT_TO_LETTER[character] ?? character);

const asDigits = (text) =>
  text.replace(/[A-Z]/g, (character) => LETTER_TO_DIGIT[character] ?? character);

/**
 * Met le texte OCR sous une forme comparable : majuscules, tirets unifiés,
 * espaces autour des tirets supprimés, ponctuation parasite retirée.
 */
export function normalizeOcrText(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[‐-―−_]/g, '-') // tirets typographiques et souligné
    .replace(/[^A-Z0-9\-\s]/g, ' ')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Découpe la partie droite d'un code (après le tiret) en région / série / numéro.
 *
 * Les longueurs observées dans la base : `EN001` (région + 3 chiffres),
 * `ENA01` des Speed Duel et `ENJ01` des Legendary Decks (région + lettre de
 * série + chiffres), `001` sans région sur les vieilles séries.
 */
function splitSuffix(suffix) {
  const head = asLetters(suffix.slice(0, 2));
  // Une région est présente si la tête est connue, ou simplement si deux lettres
  // précèdent assez de caractères pour former un numéro.
  const hasRegion = REGIONS.includes(head) || (suffix.length >= 4 && /^[A-Z]{2}/.test(suffix));
  const region = hasRegion ? head : '';
  const rest = hasRegion ? suffix.slice(2) : suffix;

  // Une lettre en tête du reste peut être une lettre de série (« ENA01 »)... ou un
  // chiffre mal lu (« ENOO4 » pour 004). On ne retient la lettre de série que si
  // le glyphe n'est pas de ceux qui se confondent avec un chiffre : un « O » en
  // tête d'un numéro est un zéro dans l'écrasante majorité des cas.
  if (rest.length >= 3 && /^[A-Z]/.test(rest) && !(rest[0] in LETTER_TO_DIGIT)) {
    return { region, serial: rest.slice(0, 1), number: asDigits(rest.slice(1)) };
  }

  return { region, serial: '', number: asDigits(rest) };
}

/**
 * Clé de rapprochement d'un code, région retirée.
 *
 * YGOPRODeck ne stocke que la variante anglaise des codes TCG : une carte
 * française « LOB-FR001 » doit tomber sur « LOB-EN001 ». On applique la même
 * fonction aux deux côtés de la comparaison, donc une région mal lue par l'OCR
 * disparaît des deux bords au lieu de faire échouer le rapprochement.
 */
export function setCodeMatchKey(code) {
  const normalized = String(code ?? '')
    .toUpperCase()
    .replace(/[\u2010-\u2015\u2212_\s]/g, '-')
    .replace(/[^A-Z0-9-]/g, '');

  const parts = /^([A-Z0-9]{2,5})-(.+)$/.exec(normalized);
  if (!parts) return normalized;

  const rest = parts[2];
  // « EN001 », « ENA01 », « FN001 » (région mal lue) : on retire la tête.
  const stripped = /^[A-Z]{2}[A-Z]?[0-9]{2,4}$/.test(rest) ? rest.slice(2) : rest;
  return `${parts[1]}-${stripped}`;
}

/** Lettres que Tesseract intervertit le plus souvent entre elles. */
const LETTER_CONFUSIONS = {
  A: 'R',
  B: 'ERPD',
  C: 'OGE',
  D: 'OBP',
  E: 'FBC',
  F: 'EP',
  G: 'COQ',
  H: 'NMK',
  I: 'TLJ',
  J: 'IT',
  K: 'RXH',
  L: 'IE',
  M: 'NHW',
  N: 'MHU',
  O: 'DQCG',
  P: 'FRBD',
  Q: 'OG',
  R: 'PBKA',
  S: 'E',
  T: 'IJY',
  U: 'VN',
  V: 'UYW',
  W: 'VM',
  X: 'KY',
  Y: 'VXT',
  Z: 'S',
};

const isConfusable = (a, b) => a === b || (LETTER_CONFUSIONS[a] ?? '').includes(b);

/**
 * Recale la région sur la liste connue.
 *
 * La simple distance d'édition ne tranche pas : « EM » est à un caractère de
 * « EN » comme de « EU ». On exige donc que le caractère divergent soit une
 * confusion que Tesseract commet réellement -- M/N oui, M/U non -- et on ne
 * recale que s'il reste une seule candidate.
 */
function snapRegion(region) {
  if (!region || REGIONS.includes(region)) return region;

  const plausible = REGIONS.filter(
    (known) => isConfusable(region[0], known[0]) && isConfusable(region[1], known[1]),
  );

  return plausible.length === 1 ? plausible[0] : region;
}

function buildCode({ prefix, region, serial, number }) {
  const normalizedPrefix = asLetters(prefix.slice(0, 2)) + prefix.slice(2);
  const normalizedRegion = snapRegion(region);
  return {
    prefix: normalizedPrefix,
    region: normalizedRegion,
    serial,
    number,
    // Code complet tel qu'il est imprimé sur la carte.
    code: `${normalizedPrefix}-${normalizedRegion}${serial}${number}`,
    matchKey: setCodeMatchKey(`${normalizedPrefix}-${normalizedRegion}${serial}${number}`),
  };
}

/** Regex tolérante : on laisse passer chiffres et lettres des deux côtés du tiret. */
const CODE_WITH_DASH = /\b([A-Z0-9]{2,5})-([A-Z0-9]{2,6})\b/g;

/** Le tiret saute parfois complètement : on se raccroche à la région. */
const CODE_WITHOUT_DASH = new RegExp(
  `\\b([A-Z0-9]{2,5})(${REGIONS.join('|')})([A-Z]?[0-9]{2,4})\\b`,
  'g',
);

/**
 * Extrait tous les codes plausibles d'un texte OCR, le plus crédible en tête.
 *
 * @param {string} raw texte brut renvoyé par Tesseract
 * @returns {Array<{code:string, matchKey:string, prefix:string, region:string,
 *   serial:string, number:string, score:number}>}
 */
export function extractSetCodes(raw) {
  const text = normalizeOcrText(raw);
  const found = new Map();

  const push = (candidate, bonus) => {
    if (!/^[0-9]{2,4}$/.test(candidate.number)) return;
    if (!/^[A-Z][A-Z0-9]{1,4}$/.test(candidate.prefix)) return;

    // Un code bien formé -- région connue, numéro à 3 chiffres -- doit primer
    // sur une bribe reconstruite depuis un texte abîmé.
    const score =
      bonus +
      (REGIONS.includes(candidate.region) ? 3 : 0) +
      (candidate.number.length === 3 ? 2 : 0) +
      (/^[A-Z]{2,4}$/.test(candidate.prefix) ? 1 : 0);

    const previous = found.get(candidate.code);
    if (!previous || previous.score < score) found.set(candidate.code, { ...candidate, score });
  };

  for (const match of text.matchAll(CODE_WITH_DASH)) {
    push(buildCode({ prefix: match[1], ...splitSuffix(match[2]) }), 2);
  }

  for (const match of text.matchAll(CODE_WITHOUT_DASH)) {
    push(
      buildCode({
        prefix: match[1],
        region: match[2],
        serial: /^[A-Z]/.test(match[3]) ? match[3].slice(0, 1) : '',
        number: /^[A-Z]/.test(match[3]) ? match[3].slice(1) : match[3],
      }),
      1,
    );
  }

  return [...found.values()].sort((a, b) => b.score - a.score);
}

/** Le meilleur code, ou `null`. */
export function extractSetCode(raw) {
  return extractSetCodes(raw)[0] ?? null;
}

/**
 * Isole le titre : première ligne porteuse de texte, nettoyée.
 *
 * On ne corrige pas les chiffres ici -- « Number 39: Utopia » en contient
 * légitimement -- on se contente de retirer le bruit de bordure que Tesseract
 * accroche en début et fin de ligne.
 */
export function extractTitle(raw) {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/[|]/g, 'I') // barre verticale : c'est un I ou un l, jamais un pipe
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => (line.match(/[A-Za-zÀ-ÿ0-9]/g) ?? []).length >= 2);

  if (lines.length === 0) return '';

  return lines[0]
    .replace(/^[^A-Za-zÀ-ÿ0-9"'(]+/, '')
    .replace(/[^A-Za-zÀ-ÿ0-9.!?")\]]+$/, '')
    .trim();
}

/** Forme canonique pour comparer deux titres (casse, accents, ponctuation). */
export function normalizeTitle(title) {
  return String(title ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Distance de Levenshtein, bornée en mémoire à une seule ligne. */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[b.length];
}

/** Similarité dans [0, 1] entre deux titres, tolérante à l'OCR. */
export function titleSimilarity(a, b) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return 0;
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}
