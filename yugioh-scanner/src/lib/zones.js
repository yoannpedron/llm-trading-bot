/**
 * Géométrie des zones de ciblage.
 *
 * Tout est exprimé en fractions du *cadre carte* (et non de la vidéo) : l'overlay
 * SVG et le recadrage canvas lisent les mêmes nombres, donc ce que l'utilisateur
 * aligne à l'écran est exactement ce que Tesseract reçoit. Une carte Yu-Gi-Oh!
 * mesure 59 x 86 mm.
 */

export const CARD_ASPECT = 59 / 86; // largeur / hauteur ~ 0,686

/**
 * Fraction de la plus petite dimension de la vidéo occupée par le cadre carte.
 * 0,82 laisse une marge : cadrer au ras du bord fait perdre les coins.
 */
export const CARD_FILL = 0.82;

export const ZONES = {
  title: {
    id: 'title',
    label: 'Titre',
    hint: 'Nom de la carte',
    // Le titre court du bord gauche jusqu'au symbole d'attribut (en haut à droite),
    // qu'on exclut : c'est un pictogramme, il ne produit que du bruit.
    x: 0.055,
    y: 0.032,
    w: 0.745,
    h: 0.075,
  },
  setCode: {
    id: 'setCode',
    label: 'Code',
    hint: 'ex. LOB-EN001',
    // Imprimé sous l'illustration, aligné à droite, juste au-dessus de la ligne
    // de type. Sur une carte de 86 mm, cela tombe vers 55-58 mm du haut.
    x: 0.545,
    y: 0.618,
    w: 0.405,
    h: 0.043,
  },
};

export const ZONE_LIST = [ZONES.title, ZONES.setCode];

/**
 * Place le cadre carte au centre d'une surface (vidéo ou conteneur), en pixels.
 * @param {number} width  largeur de la surface
 * @param {number} height hauteur de la surface
 */
export function cardFrame(width, height) {
  // On teste les deux contraintes et on garde celle qui tient dans la surface.
  let frameHeight = height * CARD_FILL;
  let frameWidth = frameHeight * CARD_ASPECT;

  if (frameWidth > width * CARD_FILL) {
    frameWidth = width * CARD_FILL;
    frameHeight = frameWidth / CARD_ASPECT;
  }

  return {
    x: (width - frameWidth) / 2,
    y: (height - frameHeight) / 2,
    width: frameWidth,
    height: frameHeight,
  };
}

/**
 * Rectangle absolu d'une zone, en pixels de la surface donnée.
 */
export function zoneRect(zone, width, height) {
  const frame = cardFrame(width, height);
  return {
    x: frame.x + zone.x * frame.width,
    y: frame.y + zone.y * frame.height,
    width: zone.w * frame.width,
    height: zone.h * frame.height,
  };
}

/**
 * Mêmes rectangles, exprimés en pourcentages de la surface.
 *
 * L'overlay HTML et le recadrage canvas doivent viser exactement le même
 * endroit. Plutôt que de dupliquer les nombres dans une feuille de style, on
 * dérive les pourcentages des mêmes fonctions : le conteneur vidéo porte le
 * ratio du flux, donc un pourcentage à l'écran vaut le même pourcentage dans
 * l'image capturée.
 */
export function toPercent(rect, width, height) {
  return {
    left: `${(rect.x / width) * 100}%`,
    top: `${(rect.y / height) * 100}%`,
    width: `${(rect.width / width) * 100}%`,
    height: `${(rect.height / height) * 100}%`,
  };
}

export const framePercent = (width, height) => toPercent(cardFrame(width, height), width, height);

export const zonePercent = (zone, width, height) =>
  toPercent(zoneRect(zone, width, height), width, height);
