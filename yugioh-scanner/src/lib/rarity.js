/**
 * Profils visuels de rareté.
 *
 * L'OCR ne voit pas les reflets : c'est la rareté renvoyée par l'API (ou choisie
 * par l'utilisateur) qui pilote l'apparence de la carte révélée. Chaque profil
 * donne la teinte de l'aura, l'intensité du voile holographique et la vitesse du
 * balayage — une Secret Rare doit se voir de l'autre bout de la pièce, une
 * Common doit rester sobre.
 */

const PROFILES = [
  {
    match: /secret|ghost|starlight|quarter century/i,
    key: 'secret',
    label: 'Holographique intense',
    glow: '#a855f7',
    accent: '#e879f9',
    foil: 0.95,
    sweep: 2.6,
    sparkle: true,
  },
  {
    match: /ultimate|collector|platinum/i,
    key: 'ultimate',
    label: 'Relief métallisé',
    glow: '#38bdf8',
    accent: '#7dd3fc',
    foil: 0.8,
    sweep: 3.2,
    sparkle: true,
  },
  {
    match: /ultra|gold|prismatic/i,
    key: 'ultra',
    label: 'Doré',
    glow: '#f59e0b',
    accent: '#fcd34d',
    foil: 0.62,
    sweep: 3.6,
    sparkle: true,
  },
  {
    match: /super|shatterfoil|starfoil|mosaic/i,
    key: 'super',
    label: 'Foil',
    glow: '#34d399',
    accent: '#6ee7b7',
    foil: 0.45,
    sweep: 4.2,
    sparkle: false,
  },
  {
    match: /rare/i,
    key: 'rare',
    label: 'Nom argenté',
    glow: '#94a3b8',
    accent: '#cbd5e1',
    foil: 0.24,
    sweep: 5,
    sparkle: false,
  },
];

const DEFAULT_PROFILE = {
  key: 'common',
  label: 'Sans reflet',
  glow: '#64748b',
  accent: '#94a3b8',
  foil: 0.12,
  sweep: 6,
  sparkle: false,
};

/** @param {string} rarity libellé renvoyé par YGOPRODeck */
export function rarityProfile(rarity) {
  const found = PROFILES.find((profile) => profile.match.test(rarity ?? ''));
  return found ? { ...found, rarity } : { ...DEFAULT_PROFILE, rarity };
}

/** Trie les raretés du plus rare au plus commun, pour l'ordre des boutons. */
export function sortRarities(printings) {
  const rank = (rarity) => {
    const index = PROFILES.findIndex((profile) => profile.match.test(rarity ?? ''));
    return index === -1 ? PROFILES.length : index;
  };
  return [...printings].sort((a, b) => rank(a.rarity) - rank(b.rarity));
}

/**
 * Palier visuel d'une rareté, tel que l'attend `holo.css`.
 *
 * Cinq paliers seulement : au-delà, les effets ne se distinguent plus à l'œil,
 * et la carte devient illisible sous les reflets.
 */
export function rarityTier(rarity) {
  const label = String(rarity ?? '');
  if (/secret|ghost|starlight|quarter century|collector/i.test(label)) return 'secret';
  if (/ultimate|ultra|gold|prismatic|platinum/i.test(label)) return 'ultra';
  if (/super|shatterfoil|starfoil|mosaic/i.test(label)) return 'super';
  if (/rare/i.test(label)) return 'rare';
  return 'common';
}
