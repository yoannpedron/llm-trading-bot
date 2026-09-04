/**
 * Lecture d'une fiche produit Cardmarket.
 *
 * Tout ce qui est testable sans réseau vit ici : construction de l'URL,
 * extraction du tableau de prix, conversion des montants au format européen.
 * La partie qui parle au réseau est isolée dans `fetchCardmarketPrices`.
 */

/** Étiquettes de la fiche produit, ramenées à des clés stables. */
const LABELS = [
  [/available\s*items/i, 'available'],
  [/^from$/i, 'from'],
  [/price\s*trend/i, 'trend'],
  [/30[-\s]?days?\s*average/i, 'avg30'],
  [/7[-\s]?days?\s*average/i, 'avg7'],
  [/1[-\s]?day\s*average/i, 'avg1'],
];

/**
 * Convertit un montant Cardmarket en nombre.
 * Le site écrit « 1.234,56 € » : le point sépare les milliers, la virgule les
 * décimales. L'inverse de la convention JavaScript, d'où la conversion explicite.
 */
export function parseEuroAmount(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.match(/(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?\s*€/);
  if (!match) return null;
  const value = Number.parseFloat(`${match[1].replace(/\./g, '')}.${match[2] ?? '0'}`);
  return Number.isFinite(value) ? value : null;
}

/** Retire les balises d'un fragment HTML et normalise les espaces. */
const stripTags = (html) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Extrait les prix du bloc `<dt>libellé</dt><dd>valeur</dd>` de la fiche.
 * @returns {{from?: number, trend?: number, avg30?: number, avg7?: number,
 *   avg1?: number, available?: number}}
 */
export function parsePriceTable(html) {
  const prices = {};
  const pattern = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;

  for (const [, rawLabel, rawValue] of html.matchAll(pattern)) {
    const label = stripTags(rawLabel);
    const value = stripTags(rawValue);
    const entry = LABELS.find(([pattern_]) => pattern_.test(label));
    if (!entry) continue;

    const [, key] = entry;
    if (key === 'available') {
      const count = Number.parseInt(value.replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(count)) prices.available = count;
      continue;
    }

    const amount = parseEuroAmount(value);
    if (amount !== null) prices[key] = amount;
  }

  return prices;
}

/**
 * Slug d'URL Cardmarket : accents retirés, ponctuation supprimée, espaces en
 * tirets. « Gishki Chain » -> « Gishki-Chain », « Mystical Elf » -> « Mystical-Elf ».
 */
export function slugify(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^A-Za-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-');
}

/**
 * URLs candidates pour une carte.
 *
 * Cardmarket éclate certaines cartes en plusieurs produits selon la rareté
 * (« Nom (V.1) », « Nom Secret Rare »). On essaie donc la variante avec rareté
 * avant la variante nue : la première qui répond gagne.
 */
export function buildProductUrls({ name, setName, rarity }) {
  const base = 'https://www.cardmarket.com/en/YuGiOh/Products/Singles';
  const set = slugify(setName);
  const card = slugify(name);
  if (!set || !card) return [];

  const urls = [];
  if (rarity) urls.push(`${base}/${set}/${card}-${slugify(rarity)}`);
  urls.push(`${base}/${set}/${card}`);
  return urls;
}

/** Une fiche a été trouvée si on en tire au moins un montant. */
export const hasUsablePrices = (prices) =>
  ['from', 'trend', 'avg30', 'avg7', 'avg1'].some((key) => typeof prices[key] === 'number');
