/**
 * Visuels officiels des cartes.
 *
 * YGOPRODeck sert les images à une adresse déduite du passcode, qui *est*
 * l'identifiant de la carte. Aucune URL n'est donc stockée dans l'index ni dans
 * la collection : autant d'octets épargnés sur 14 523 cartes.
 *
 * Ces adresses étaient reconstruites à la main à cinq endroits, dont deux fois
 * dans le même composant. Une seule source ici : le jour où l'hébergement des
 * images change, ou si l'on passe par un cache local, il n'y a qu'un fichier à
 * toucher.
 *
 * Trois formats existent, et le choix compte sur un réseau mobile :
 *
 *   petit    ~15 Ko   liste, vignette d'attente
 *   complet  ~150 Ko  carte révélée en plein écran
 *   rogné    ~30 Ko   illustration seule, sans le cadre
 */

const BASE = 'https://images.ygoprodeck.com/images';

/** Identifiant utilisable, ou `null` : on ne fabrique pas d'URL avec « undefined ». */
const identifiant = (carte) => {
  const valeur = typeof carte === 'object' && carte !== null ? carte.id : carte;
  return Number.isFinite(Number(valeur)) && Number(valeur) > 0 ? String(Number(valeur)) : null;
};

/** Visuel complet, pour la carte révélée. */
export const imageComplete = (carte) => {
  const id = identifiant(carte);
  return id ? `${BASE}/cards/${id}.jpg` : null;
};

/** Vignette, pour les listes et l'attente du visuel complet. */
export const imagePetite = (carte) => {
  const id = identifiant(carte);
  return id ? `${BASE}/cards_small/${id}.jpg` : null;
};

  const id = identifiant(carte);
  return id ? `${BASE}/cards_cropped/${id}.jpg` : null;
};

/** Les trois formats d'un coup, sous la forme attendue par la collection. */
export const imagesDe = (carte) => ({
  id: identifiant(carte),
  full: imageComplete(carte),
  small: imagePetite(carte),
  cropped: imageRognee(carte),
});
