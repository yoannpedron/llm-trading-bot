import test from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES, setCodePatterns } from '../src/lib/ocr.js';

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

test('la grammaire des codes couvre les formes réelles et rien de plus', () => {
  const lines = setCodePatterns().trim().split('\n');

  // Une forme de motif par ligne, pour les quatre familles recensées dans
  // l'index, et un préfixe de deux à cinq caractères.
  const shapes = new Set(lines.map((line) => line.replace(/(\\n)+/, 'P')));
  assert.deepEqual(
    shapes,
    new Set(['P-\\A\\A\\d\\d\\d', 'P-\\A\\A\\A\\d\\d', 'P-\\d\\d\\d', 'P-\\A\\d\\d\\d']),
  );
  assert.equal(lines.length, 16);
  assert.ok(lines.every((line) => /^(\\n){2,5}-/.test(line)));

  // Pas de « lettre de série + trois chiffres » : c'est par cette forme
  // inexistante que le « O » inséré après la région passait.
  assert.ok(!lines.some((line) => line.endsWith('\\A\\A\\A\\d\\d\\d')));

  // Le fichier se termine par un saut de ligne : Tesseract ignore sinon la
  // dernière ligne.
  assert.ok(setCodePatterns().endsWith('\n'));
});
