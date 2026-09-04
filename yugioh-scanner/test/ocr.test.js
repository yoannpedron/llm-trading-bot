import test from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES } from '../src/lib/ocr.js';

test('le profil du code lit un bloc, pas une ligne', () => {
  // PSM 7 (« ligne unique ») suppose que l'image ne contient que la ligne à
  // lire. La taille du viseur en pixels vidéo dépend de la hauteur de l'écran :
  // sur un conteneur court, il embarque la bordure du cadre de la carte, et
  // PSM 7 rend alors du vide sans lever la moindre erreur. Mesuré sur les deux
  // cadrages, PSM 6 lit dans les deux cas.
  assert.equal(PROFILES.setCode.tessedit_pageseg_mode, '6');
});

test('l’alphabet du code exclut tout ce qui n’y figure jamais', () => {
  const whitelist = PROFILES.setCode.tessedit_char_whitelist;
  assert.match(whitelist, /^[A-Z0-9-]+$/);
  // Ni minuscules ni ponctuation : un code d'extension n'en contient pas.
  assert.doesNotMatch(whitelist, /[a-z.,]/);
});

test('le profil du passcode n’accepte que des chiffres', () => {
  // Retirer les lettres supprime d'un coup toute la classe d'erreurs qui plombe
  // le code d'extension : il devient impossible de lire « O » pour « 0 ».
  assert.equal(PROFILES.passcode.tessedit_char_whitelist, '0123456789');
});
