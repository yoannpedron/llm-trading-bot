/**
 * Correspondance entre le viseur affiché et les pixels de la vidéo.
 *
 * Le flux occupe tout l'écran en `object-fit: cover` : il est donc agrandi puis
 * rogné, et jamais aux mêmes proportions que la fenêtre. Un rectangle dessiné à
 * l'écran ne correspond donc pas au même rectangle dans l'image capturée, et
 * s'en remettre à l'intuition revient à envoyer à l'OCR une portion décalée —
 * une panne invisible, qui se manifeste seulement par « ça ne lit rien ».
 *
 * Les fonctions ci-dessous sont pures et testées : elles sont la seule
 * traduction entre les deux repères.
 */

/**
 * Facteur d'agrandissement appliqué par `object-fit: cover`.
 * C'est le plus grand des deux rapports : la dimension la plus contrainte
 * remplit le conteneur, l'autre déborde et se fait rogner.
 */
export function coverScale(video, container) {
  if (!video.width || !video.height) return 1;
  return Math.max(container.width / video.width, container.height / video.height);
}

/**
 * Décalage, en pixels du conteneur, de l'image agrandie par rapport à lui.
 * Positif : l'image déborde et la partie visible commence plus loin.
 */
export function coverOffset(video, container) {
  const scale = coverScale(video, container);
  return {
    x: (video.width * scale - container.width) / 2,
    y: (video.height * scale - container.height) / 2,
  };
}

/**
 * Convertit un rectangle exprimé en pixels du conteneur vers les pixels natifs
 * de la vidéo. Le résultat est borné à l'image : un viseur qui déborderait
 * demanderait un recadrage hors limites, que le canvas rendrait vide.
 *
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {{width:number,height:number}} video dimensions natives du flux
 * @param {{width:number,height:number}} container dimensions affichées
 */
export function toVideoRect(rect, video, container) {
  const scale = coverScale(video, container);
  const offset = coverOffset(video, container);

  const x = (rect.x + offset.x) / scale;
  const y = (rect.y + offset.y) / scale;
  const width = rect.width / scale;
  const height = rect.height / scale;

  const clampedX = Math.max(0, Math.min(x, video.width));
  const clampedY = Math.max(0, Math.min(y, video.height));

  return {
    x: clampedX,
    y: clampedY,
    width: Math.max(1, Math.min(width, video.width - clampedX)),
    height: Math.max(1, Math.min(height, video.height - clampedY)),
  };
}

/**
 * Le viseur : un rectangle très allongé, centré.
 *
 * Un code d'extension fait environ 10 caractères sur une seule ligne. Un cadre
 * au ratio 6:1 le contient sans laisser de place au décor de la carte, ce qui
 * évite à l'OCR d'avoir à trier le texte utile du reste.
 */
export const RETICLE_RATIO = 6;

export function reticleRect(container, { ratio = RETICLE_RATIO, fill = 0.82, max = 420 } = {}) {
  const width = Math.min(container.width * fill, max);
  const height = width / ratio;
  return {
    x: (container.width - width) / 2,
    y: (container.height - height) / 2,
    width,
    height,
  };
}

/**
 * L'inverse : un point en pixels natifs de la vidéo, ramené en pixels du
 * conteneur — pour dessiner sur l'écran ce que la détection a trouvé dans
 * l'image. Un point peut tomber hors du conteneur : la partie rognée par
 * `object-fit: cover` existe dans l'image, pas à l'écran.
 */
export function toContainerPoint(point, video, container) {
  const scale = coverScale(video, container);
  const offset = coverOffset(video, container);
  return { x: point.x * scale - offset.x, y: point.y * scale - offset.y };
}
