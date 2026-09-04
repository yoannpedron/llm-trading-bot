/**
 * Raretés : une seule table, lue par tout le monde.
 *
 * L'OCR ne voit pas l'holographie : c'est la rareté renvoyée par l'index (ou
 * choisie par l'utilisateur) qui pilote l'apparence de la carte révélée, la
 * couleur des boutons et celle des vignettes de la collection. Trois tables
 * séparées se contredisaient — une Collector's Rare était « ultimate » ici et
 * « secret » là, et des intensités écrites ici n'étaient lues par personne.
 *
 * Le rendu suit ce que la carte physique porte réellement, sur deux axes :
 *
 *  - **couverture** : où le foil se trouve — nulle part (Commune), sur le nom
 *    seul (Rare), sur l'illustration (Super), sur l'illustration et le nom
 *    (Ultra, Secret), sur toute la surface (Parallel, Starlight, Quarter
 *    Century, Platinum, Collector's) ;
 *  - **finition** : argent, or, arc-en-ciel, motif pleine surface, relief sans
 *    couleur (Ultimate), platine, ou le blanc irisé d'une Ghost.
 *
 * La rareté est celle du tirage, identique dans toutes les langues : une
 * RA03-FR001 existe dans les mêmes raretés que la RA03-EN001.
 *
 * Les libellés viennent de YGOPRODeck, avec leurs coquilles (« PLatinum »,
 * « Cr », « 2 », « New ») : le premier motif qui correspond l'emporte, et ce
 * qui ne correspond à rien est traité comme une Commune.
 */

/**
 * Du plus rare au plus commun. `rank` sert au tri ; `foil` et `glare` sont
 * des intensités 0-1 passées au CSS ; `glow` colore l'aura et les vignettes ;
 * `accent` colore le texte des boutons.
 */
const TIERS = [
  {
    key: 'premium',
    match: /quarter century|starlight|collector/i,
    label: 'Foil intégral',
    coverage: 'full',
    finish: 'rainbow',
    sparkle: true,
    foil: 0.85,
    glare: 0.42,
    glow: '#a855f7',
    accent: '#e9d5ff',
  },
  {
    key: 'platinum',
    match: /platinum/i,
    label: 'Platine',
    coverage: 'full',
    finish: 'platinum',
    sparkle: true,
    foil: 0.7,
    glare: 0.45,
    glow: '#94a3b8',
    accent: '#e2e8f0',
  },
  {
    key: 'ghost',
    match: /ghost/i,
    label: 'Ghost',
    coverage: 'art',
    finish: 'ghost',
    sparkle: true,
    foil: 0.8,
    glare: 0.4,
    glow: '#e0f2fe',
    accent: '#f0f9ff',
  },
  {
    key: 'secret',
    match: /secret/i,
    label: 'Secret',
    coverage: 'artname',
    finish: 'rainbow',
    sparkle: true,
    foil: 0.75,
    glare: 0.4,
    glow: '#c084fc',
    accent: '#d8b4fe',
  },
  {
    key: 'ultimate',
    match: /ultimate/i,
    label: 'Relief',
    coverage: 'artname',
    finish: 'relief',
    sparkle: false,
    foil: 0.55,
    glare: 0.5,
    glow: '#38bdf8',
    accent: '#bae6fd',
  },
  {
    key: 'parallel',
    match: /parallel|starfoil|shatterfoil|mosaic/i,
    label: 'Foil à motif',
    coverage: 'full',
    finish: 'pattern',
    sparkle: false,
    foil: 0.45,
    glare: 0.36,
    glow: '#2dd4bf',
    accent: '#99f6e4',
  },
  {
    key: 'gold',
    match: /gold|pharaoh/i,
    label: 'Doré',
    coverage: 'artname',
    finish: 'gold',
    sparkle: false,
    foil: 0.6,
    glare: 0.38,
    glow: '#f59e0b',
    accent: '#fde68a',
  },
  {
    key: 'ultra',
    match: /ultra/i,
    label: 'Ultra',
    coverage: 'artname',
    finish: 'gold',
    sparkle: false,
    foil: 0.6,
    glare: 0.38,
    glow: '#fbbf24',
    accent: '#fcd34d',
  },
  {
    key: 'super',
    match: /super/i,
    label: 'Super',
    coverage: 'art',
    finish: 'rainbow',
    sparkle: false,
    foil: 0.5,
    glare: 0.34,
    glow: '#34d399',
    accent: '#6ee7b7',
  },
  {
    key: 'rare',
    match: /rare/i,
    label: 'Nom argenté',
    coverage: 'name',
    finish: 'silver',
    sparkle: false,
    foil: 0.55,
    glare: 0.3,
    glow: '#94a3b8',
    accent: '#cbd5e1',
  },
  {
    key: 'common',
    match: /./,
    label: 'Sans reflet',
    coverage: 'none',
    finish: 'silver',
    sparkle: false,
    foil: 0,
    glare: 0.18,
    glow: '#64748b',
    accent: '#94a3b8',
  },
];

// « Short Print » et « Super Short Print » sont des Communes tirées en moins
// grand nombre : elles portent « Super » ou rien, pas du foil.
const COMMON_ALIASES = /short print/i;

function tierOf(rarity) {
  const label = String(rarity ?? '');
  if (!label || COMMON_ALIASES.test(label)) return TIERS[TIERS.length - 1];
  return TIERS.find((tier) => tier.match.test(label)) ?? TIERS[TIERS.length - 1];
}

/**
 * Profil visuel d'un libellé de rareté.
 * @param {string} rarity libellé YGOPRODeck
 * @returns {{key: string, label: string, coverage: string, finish: string,
 *   sparkle: boolean, foil: number, glare: number, glow: string,
 *   accent: string, rank: number, rarity: string}}
 */
export function rarityProfile(rarity) {
  const tier = tierOf(rarity);
  const { match, ...profile } = tier;
  return { ...profile, rank: TIERS.indexOf(tier), rarity: rarity ?? '' };
}

/** Clé du palier, identique à `rarityProfile(rarity).key`. */
export function rarityTier(rarity) {
  return tierOf(rarity).key;
}

/**
 * Trie des tirages par rareté. Du plus commun au plus rare par défaut : c'est
 * l'ordre dans lequel on a le plus de chances de trouver la sienne, et
 * l'ordre des prix croissants.
 */
export function sortRarities(printings, { rarestFirst = false } = {}) {
  const sorted = [...printings].sort(
    (a, b) => rarityProfile(b.rarity).rank - rarityProfile(a.rarity).rank,
  );
  return rarestFirst ? sorted.reverse() : sorted;
}

/** Tous les paliers, du plus rare au plus commun — pour les tests et la doc. */
export const RARITY_TIERS = TIERS.map(({ match, ...tier }) => tier);
