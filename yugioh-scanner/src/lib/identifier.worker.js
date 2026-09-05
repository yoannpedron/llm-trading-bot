/**
 * L'identification par illustration tourne ici, hors du fil principal.
 *
 * Une passe prend entre 300 ms et 2 s selon l'appareil : sur le fil
 * principal, c'est une interface figée, un bouton de torche qui ne répond
 * plus, une image qui saccade. Le worker reçoit l'image native de la caméra
 * (transférée, pas copiée) et rend le contour, la carte et le score.
 *
 * Messages reçus : `{type: 'init', index: ArrayBuffer}` puis
 * `{type: 'identifier', id, image: ImageData, largeur}`.
 * Messages rendus : `{type: 'pret'}`, `{type: 'resultat', id, ...}`,
 * `{type: 'erreur', id, message}`.
 */

import { lireIndexArt } from './art.js';
import { identifierCarte, reduireImage } from './identifier.js';

let index = null;

self.onmessage = (evenement) => {
  const message = evenement.data;
  try {
    if (message.type === 'init') {
      index = lireIndexArt(message.index);
      self.postMessage({ type: 'pret', taille: index.taille });
      return;
    }
    if (message.type === 'identifier') {
      if (!index) throw new Error('index non chargé');
      const { image, largeur } = message;
      const reduite = reduireImage(image, largeur);
      const r = identifierCarte(image, reduite, index);
      self.postMessage({
        type: 'resultat',
        id: message.id,
        quad: r.quad,
        candidats: r.candidats,
        sens: r.sens,
        hypothese: r.hypothese,
        ms: r.ms,
        largeur: image.width,
        hauteur: image.height,
      });
    }
  } catch (cause) {
    self.postMessage({ type: 'erreur', id: message.id, message: cause?.message ?? String(cause) });
  }
};
