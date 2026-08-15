/**
 * Audit du dictionnaire d'anonymisation généré.
 *
 * ── Le risque symétrique ──────────────────────────────────────────────────
 * `buildEntities.js` protège contre le SOUS-masquage : un dirigeant oublié
 * laisse fuiter l'identité de l'entreprise. Ce script protège contre l'inverse,
 * le SUR-masquage, qui est un défaut moins visible et tout aussi coûteux.
 *
 * Un terme trop générique dans la liste des produits — « Vision », « Prime »,
 * « Fusion », « One » — sera censuré PARTOUT dans les textes, y compris quand
 * il n'a aucun rapport avec l'entreprise. Le modèle reçoit alors des phrases
 * criblées de jetons et perd le sens du texte. On aurait remplacé un biais de
 * mémoire par une dégradation de lecture, en croyant avoir amélioré la mesure.
 *
 * Deux critères, tous deux nécessaires :
 *
 *   • COURT — un terme de moins de 5 caractères n'a presque jamais assez de
 *     spécificité pour désigner une entreprise sans faux positifs ;
 *   • COMMUN — un mot du vocabulaire courant, même long, produit des
 *     collisions (« Discover », « Progressive », « Target » sont à la fois des
 *     raisons sociales et des mots ordinaires — c'est d'ailleurs pour ça que
 *     ces trois-là sont de vraies sociétés cotées).
 *
 * Le script ne corrige rien : il signale. Le choix de retirer un terme est un
 * arbitrage entre fuite d'identité et lisibilité, et il se fait à l'œil.
 *
 * `npm run entities:audit`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIVERSE_ENTITIES } from '../llm/entities.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, '..', 'llm', 'entities.generated.json');

/**
 * Mots courants de la presse financière anglophone.
 *
 * Liste volontairement courte : elle ne sert pas à filtrer automatiquement mais
 * à attirer l'œil. Un terme absent d'ici peut très bien poser problème.
 */
const COURANTS = new Set([
  'one', 'prime', 'vision', 'fusion', 'connect', 'core', 'edge', 'flow', 'pro',
  'max', 'plus', 'air', 'go', 'now', 'live', 'next', 'true', 'open', 'access',
  'target', 'discover', 'progressive', 'advance', 'apex', 'summit', 'legacy',
  'venture', 'capital', 'select', 'premier', 'signature', 'freedom', 'liberty',
  'united', 'general', 'standard', 'national', 'american', 'global', 'first',
  'power', 'energy', 'digital', 'mobile', 'express', 'direct', 'secure', 'smart',
]);

const LONGUEUR_MIN = 5;

if (!fs.existsSync(FILE)) {
  console.log('\n  Aucun dictionnaire généré. Lance `npm run entities:build` d\'abord.\n');
  process.exit(0);
}

const genere = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const suspects = [];
const collisions = new Map();

for (const [symbol, e] of Object.entries(genere)) {
  for (const champ of ['names', 'executives', 'products', 'subsidiaries']) {
    for (const terme of e[champ] ?? []) {
      const bas = terme.toLowerCase();

      // Un terme composé de plusieurs mots est presque toujours spécifique :
      // « Analog and Embedded Processing » ne collisionne avec rien.
      const monoMot = !/\s/.test(terme);

      if (monoMot && (terme.length < LONGUEUR_MIN || COURANTS.has(bas))) {
        suspects.push({ symbol, champ, terme, raison: COURANTS.has(bas) ? 'mot courant' : `${terme.length} caractères` });
      }

      // Un même terme revendiqué par deux sociétés différentes : la censure
      // s'appliquerait aux deux, et le texte d'une entreprise se retrouverait
      // amputé au nom d'une autre.
      if (!collisions.has(bas)) collisions.set(bas, new Set());
      collisions.get(bas).add(symbol);
    }
  }
}

const partages = [...collisions.entries()]
  .filter(([, symbols]) => symbols.size > 1)
  .map(([terme, symbols]) => ({ terme, symbols: [...symbols] }))
  .sort((a, b) => b.symbols.length - a.symbols.length);

const total = Object.keys(genere).length;
const termes = Object.values(genere).reduce(
  (a, e) => a + ['names', 'executives', 'products', 'subsidiaries'].reduce((b, c) => b + (e[c]?.length ?? 0), 0),
  0,
);

console.log(`\n── Dictionnaire généré ──────────────────────────────────────────`);
console.log(`  ${total} symbole(s), ${termes} terme(s) de censure`);
console.log(`  (+ ${Object.keys(UNIVERSE_ENTITIES).length} symbole(s) écrits à la main, non audités ici)`);

console.log(`\n── Termes à risque de sur-masquage : ${suspects.length} ──────────────────`);
if (!suspects.length) {
  console.log('  Aucun. Tous les termes mono-mot font au moins 5 caractères et ne sont');
  console.log('  pas des mots courants.');
} else {
  for (const s of suspects.slice(0, 40)) {
    console.log(`  ${s.symbol.padEnd(6)} ${s.champ.padEnd(13)} « ${s.terme} »  — ${s.raison}`);
  }
  if (suspects.length > 40) console.log(`  … et ${suspects.length - 40} autre(s)`);
  console.log('');
  console.log('  Chacun de ces termes sera remplacé PARTOUT où il apparaît, y compris');
  console.log('  hors contexte. Retire à la main ceux qui te semblent trop courants.');
}

console.log(`\n── Termes partagés entre sociétés : ${partages.length} ────────────────────`);
if (!partages.length) {
  console.log('  Aucun. Chaque terme ne désigne qu\'une société.');
} else {
  for (const p of partages.slice(0, 20)) {
    console.log(`  « ${p.terme} » → ${p.symbols.join(', ')}`);
  }
  if (partages.length > 20) console.log(`  … et ${partages.length - 20} autre(s)`);
  console.log('');
  console.log('  Un terme partagé censure le texte des deux sociétés. Ce n\'est pas');
  console.log('  toujours un défaut — « Cook » chez AAPL et un homonyme ailleurs coûte');
  console.log('  peu — mais un nom de PRODUIT partagé signale souvent une erreur.');
}

console.log('');

// ── Termes déjà écartés au chargement ────────────────────────────────────
// Les afficher est indispensable : une censure qui disparaît sans trace serait
// indétectable à la relecture, et on croirait le terme encore protégé.
const { TERMES_ECARTES } = await import('../llm/entities.js');
console.log(`── Termes écartés automatiquement : ${TERMES_ECARTES.length} ─────────────────`);
if (!TERMES_ECARTES.length) {
  console.log('  Aucun.');
} else {
  const parSymbole = new Map();
  for (const t of TERMES_ECARTES) {
    if (!parSymbole.has(t.symbol)) parSymbole.set(t.symbol, []);
    parSymbole.get(t.symbol).push(t.terme);
  }
  for (const [symbol, termes] of parSymbole) {
    console.log(`  ${symbol.padEnd(6)} ${termes.join(', ')}`);
  }
  console.log('');
  console.log('  Ces termes sont du vocabulaire de la presse financière : les censurer');
  console.log('  mutilerait les textes sans masquer personne. Le nom complet du dirigeant');
  console.log('  et le ticker restent censurés.');
}
console.log('');
