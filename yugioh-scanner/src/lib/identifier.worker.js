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

/**
 * Résolution adaptative. Une passe doit rester sous ~600 ms pour que le
 * viseur suive la main : si l'appareil est trop lent, on travaille sur une
 * image réduite (jusqu'à 60 %) — la détection tourne déjà à 448 px, ce sont
 * l'affinage et les empreintes qui lisent l'image entière. Les coins rendus
 * sont ramenés au repère de l'image reçue. La mesure est un lissage des
 * dernières passes, pour ne pas réagir à une seule image lente.
 */
const CIBLE_MS = 600;
let echelle = 1;
let dureeLissee = 0;
function adapter(dureeMs) {
  dureeLissee = dureeLissee ? dureeLissee * 0.7 + dureeMs * 0.3 : dureeMs;
  if (dureeLissee > CIBLE_MS && echelle > 0.6) echelle = Math.max(0.6, echelle - 0.1);
  else if (dureeLissee < CIBLE_MS * 0.5 && echelle < 1) echelle = Math.min(1, echelle + 0.1);
}

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
      const depart = performance.now();
      const travail = echelle < 1 ? reduireImage(image, Math.round(image.width * echelle)) : image;
      const rapport = image.width / travail.width;
      const reduite = reduireImage(travail, largeur);
      const r = identifierCarte(travail, reduite, index);
      if (r.quad && rapport !== 1) r.quad = r.quad.map((p) => ({ x: p.x * rapport, y: p.y * rapport }));
      adapter(performance.now() - depart);
      self.postMessage({
        type: 'resultat',
        id: message.id,
        quad: r.quad,
        candidats: r.candidats,
        sens: r.sens,
        hypothese: r.hypothese,
        sombre: r.sombre,
        ms: r.ms,
        echelle,
        largeur: image.width,
        hauteur: image.height,
      });
    }
  } catch (cause) {
    self.postMessage({ type: 'erreur', id: message.id, message: cause?.message ?? String(cause) });
  }
};
