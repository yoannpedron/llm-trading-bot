/**
 * Raretés : une seule table, lue par tout le monde.
 *
 * L'OCR ne voit pas l'holographie : c'est la rareté renvoyée par l'index (ou
 * choisie par l'utilisateur) qui pilote l'apparence de la carte révélée, la
 * couleur des boutons et celle des vignettes de la collection. Trois tables
 * séparées se contredisaient — une Collector's Rare était « ultimate » ici et
 * « secret » là, et des intensités écrites ici n'étaient lues par personne.
 *
 * Le rendu suit ce que la carte physique porte réellement, **zone par zone**,
 * chaque zone ayant sa finition. Relevé sur les descriptions de référence
 * (Yugipedia, TCGplayer) :
 *
 *     Rare            nom argenté, rien d'autre
 *     Super           illustration + étoiles/attribut en holo ; nom non foilé
 *     Ultra           Super + nom doré
 *     Secret          illustration, étoiles et nom en arc-en-ciel à texture
 *                     diagonale (Prismatic : texture scintillante)
 *     Ultimate        illustration, étoiles et bordures en relief, nom doré
 *     Gold            nom, illustration, étoiles ET bordures (carte, boîte de
 *                     texte) en or — Gold Secret ajoute la texture Secret
 *     Platinum        les mêmes zones que Gold, en platine, texture Secret
 *     Ghost           illustration et nom en blanc irisé
 *     Collector's     illustration, étoiles et bordures, arc-en-ciel texturé
 *     Starlight, Quarter Century   toute la carte SAUF la boîte de texte
 *     Starfoil, Shatterfoil, Mosaic, Parallel   toute la carte, à motif
 *
 * Le holo ne couvre donc « toute la carte » que pour les Parallel ; la boîte de
 * texte reste lisible sur toutes les autres, et le rendu le respecte.
 *
 * La rareté est celle du tirage, identique dans toutes les langues : une
 * RA03-FR001 existe dans les mêmes raretés que la RA03-EN001.
 *
 * Les libellés viennent de YGOPRODeck, avec leurs coquilles (« PLatinum »,
 * « Cr », « 2 », « New ») : le premier motif qui correspond l'emporte, et ce
 * qui ne correspond à rien est traité comme une Commune.
 */

/**
 * Du plus rare au plus commun.
 *
 * `zones` : finition par zone — `name` (bandeau du nom), `art` (illustration),
 * `stars` (bandeau étoiles/attribut), `border` (bordure de la carte et de la
 * boîte de texte), `full` (toute la carte), `fullNoText` (toute la carte sauf
 * la boîte de texte). Finitions : `silver`, `gold`, `rainbow`, `platinum`,
 * `ghost`, `relief`, `pattern`.
 *
 * `texture` : `diagonals` (texture Secret) ou `sparkle` (Prismatic, Starlight)
 * par-dessus les zones foilées. `foil` et `glare` : intensités 0-1 ; `glow` :
 * aura et vignettes ; `accent` : texte des boutons.
 */
const TIERS = [
  {
    key: 'premium',
    match: /quarter century|starlight/i,
    label: 'Carte entière, sauf le texte',
    zones: { fullNoText: 'rainbow' },
    texture: 'sparkle',
    foil: 0.8,
    glare: 0.42,
    glow: '#a855f7',
    accent: '#e9d5ff',
  },
  {
    key: 'collector',
    match: /collector/i,
    label: 'Illustration, étoiles et bordures texturées',
    zones: { art: 'rainbow', stars: 'rainbow', border: 'rainbow' },
    texture: 'sparkle',
    foil: 0.8,
    glare: 0.42,
    glow: '#c084fc',
    accent: '#e9d5ff',
  },
  {
    key: 'platinum',
    match: /platinum/i,
    label: 'Platine : nom, illustration, bordures',
    zones: { name: 'platinum', art: 'platinum', stars: 'platinum', border: 'platinum' },
    texture: 'diagonals',
    foil: 0.7,
    glare: 0.45,
    glow: '#94a3b8',
    accent: '#e2e8f0',
  },
  {
    key: 'goldsecret',
    match: /gold secret/i,
    label: 'Or texturé : nom, illustration, bordures',
    zones: { name: 'gold', art: 'gold', stars: 'gold', border: 'gold' },
    texture: 'diagonals',
    foil: 0.65,
    glare: 0.4,
    glow: '#f59e0b',
    accent: '#fde68a',
  },
  {
    key: 'ghost',
    match: /ghost/i,
    label: 'Ghost : illustration et nom blancs irisés',
    zones: { name: 'ghost', art: 'ghost' },
    texture: null,
    foil: 0.8,
    glare: 0.4,
    glow: '#e0f2fe',
    accent: '#f0f9ff',
  },
  {
    key: 'gold',
    match: /gold|pharaoh/i,
    label: 'Or : nom, illustration, bordures',
    zones: { name: 'gold', art: 'gold', stars: 'gold', border: 'gold' },
    texture: null,
    foil: 0.6,
    glare: 0.38,
    glow: '#f59e0b',
    accent: '#fde68a',
  },
  {
    key: 'secret',
    match: /secret/i,
    label: 'Secret : illustration, étoiles et nom',
    zones: { name: 'rainbow', art: 'rainbow', stars: 'rainbow' },
    texture: 'diagonals',
    foil: 0.75,
    glare: 0.4,
    glow: '#c084fc',
    accent: '#d8b4fe',
  },
  {
    key: 'ultimate',
    match: /ultimate/i,
    label: 'Relief sur illustration et bordures, nom doré',
    zones: { name: 'gold', art: 'relief', stars: 'relief', border: 'relief' },
    texture: null,
    foil: 0.55,
    glare: 0.5,
    glow: '#38bdf8',
    accent: '#bae6fd',
  },
  {
    key: 'parallel',
    match: /parallel|starfoil|shatterfoil|mosaic/i,
    label: 'Motif sur toute la carte',
    zones: { full: 'pattern' },
    texture: null,
    foil: 0.45,
    glare: 0.36,
    glow: '#2dd4bf',
    accent: '#99f6e4',
  },
  {
    key: 'ultra',
    match: /ultra/i,
    label: 'Illustration holo, nom doré',
    zones: { name: 'gold', art: 'rainbow', stars: 'rainbow' },
    texture: null,
    foil: 0.6,
    glare: 0.38,
    glow: '#fbbf24',
    accent: '#fcd34d',
  },
  {
    key: 'super',
    match: /super/i,
    label: 'Illustration holo',
    zones: { art: 'rainbow', stars: 'rainbow' },
    texture: null,
    foil: 0.5,
    glare: 0.34,
    glow: '#34d399',
    accent: '#6ee7b7',
  },
  {
    key: 'rare',
    match: /rare/i,
    label: 'Nom argenté',
    zones: { name: 'silver' },
    texture: null,
    foil: 0.55,
    glare: 0.3,
    glow: '#94a3b8',
    accent: '#cbd5e1',
  },
  {
    key: 'common',
    match: /./,
    label: 'Sans reflet',
    zones: {},
    texture: null,
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
 * @returns {{key: string, label: string, zones: Object<string, string>,
 *   texture: 'diagonals'|'sparkle'|null, foil: number, glare: number,
 *   glow: string, accent: string, rank: number, rarity: string}}
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
