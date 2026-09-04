/**
 * Point d'entrée du banc d'essai.
 *
 * Les scripts de mesure doivent exercer le **vrai** code de l'application, pas
 * une réimplémentation qui divergerait en silence. On empaquette donc les
 * modules avec Vite, et on injecte le résultat dans une page avec
 * `page.addScriptTag()` : `window.YGO` expose alors exactement ce que
 * l'application exécute.
 */
import * as match from '../../src/lib/match.js';
import * as parse from '../../src/lib/parse.js';
import * as preprocess from '../../src/lib/preprocess.js';
import * as viewport from '../../src/lib/viewport.js';

window.YGO = { match, parse, preprocess, viewport };
