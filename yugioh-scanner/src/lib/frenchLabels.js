/**
 * Libellés français des types, catégories et attributs.
 *
 * `?language=fr` traduit le nom et le texte de la carte, mais laisse `type` et
 * `race` en anglais. Comme le panneau affiche « [Dragon / Monstre Normal] », on
 * complète ici. Une valeur inconnue est rendue telle quelle : mieux vaut un mot
 * anglais qu'un trou.
 *
 * Ces tables doublent celles de `backend/app/translate.py` : les deux chemins —
 * avec ou sans backend Python — doivent afficher exactement la même chose.
 */

const TYPES = {
  'Effect Monster': 'Monstre à Effet',
  'Normal Monster': 'Monstre Normal',
  'Normal Tuner Monster': 'Monstre Syntoniseur Normal',
  'Tuner Monster': 'Monstre Syntoniseur',
  'Flip Effect Monster': 'Monstre à Effet Flip',
  'Gemini Monster': 'Monstre Gemini',
  'Spirit Monster': 'Monstre Esprit',
  'Union Effect Monster': 'Monstre Union',
  'Toon Monster': 'Monstre Toon',
  'Ritual Monster': 'Monstre Rituel',
  'Ritual Effect Monster': 'Monstre Rituel à Effet',
  'Fusion Monster': 'Monstre Fusion',
  'Synchro Monster': 'Monstre Synchro',
  'Synchro Tuner Monster': 'Monstre Synchro Syntoniseur',
  'XYZ Monster': 'Monstre Xyz',
  'Pendulum Effect Monster': 'Monstre Pendule à Effet',
  'Pendulum Normal Monster': 'Monstre Pendule Normal',
  'Link Monster': 'Monstre Lien',
  'Spell Card': 'Carte Magie',
  'Trap Card': 'Carte Piège',
  'Skill Card': 'Carte Compétence',
  Token: 'Jeton',
};

const RACES = {
  Aqua: 'Aqua', Beast: 'Bête', 'Beast-Warrior': 'Bête-Guerrier',
  'Creator-God': 'Dieu Créateur', Cyberse: 'Cyberse', Dinosaur: 'Dinosaure',
  'Divine-Beast': 'Bête Divine', Dragon: 'Dragon', Fairy: 'Elfe',
  Fiend: 'Démon', Fish: 'Poisson', Insect: 'Insecte', Machine: 'Machine',
  Plant: 'Plante', Psychic: 'Psychique', Pyro: 'Pyro', Reptile: 'Reptile',
  Rock: 'Rocher', 'Sea Serpent': 'Serpent de Mer', Spellcaster: 'Magicien',
  Thunder: 'Tonnerre', Warrior: 'Guerrier', 'Winged Beast': 'Bête Ailée',
  Wyrm: 'Wyrm', Zombie: 'Zombie',
  // Magies et pièges : `race` porte le sous-type.
  Normal: 'Normale', Field: 'Terrain', Equip: 'Équipement',
  Continuous: 'Continue', 'Quick-Play': 'Jeu-Rapide', Ritual: 'Rituel',
  Counter: 'Contre',
};

const ATTRIBUTES = {
  DARK: 'TÉNÈBRES', LIGHT: 'LUMIÈRE', EARTH: 'TERRE',
  WATER: 'EAU', FIRE: 'FEU', WIND: 'VENT', DIVINE: 'DIVIN',
};

export const typeFr = (value) => TYPES[value] ?? value ?? '';
export const raceFr = (value) => RACES[value] ?? value ?? '';
export const attributeFr = (value) => ATTRIBUTES[value] ?? value ?? '';

/** Sous-titre du panneau : « [Dragon / Monstre Normal] ». */
export function subtitleFr(card) {
  const parts = [raceFr(card?.race), typeFr(card?.type)].filter(Boolean);
  return parts.length ? `[${parts.join(' / ')}]` : '';
}
