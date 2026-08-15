/**
 * État de la couverture d'anonymisation. Lecture seule, aucun appel réseau.
 *
 * `npm run entities`
 */
import { config } from '../config.js';
import { entityCoverage } from '../llm/entities.js';
import { sectorBreakdown } from '../data/universe.js';

const symbols = config.universe.symbols;
const c = entityCoverage(symbols);
const s = sectorBreakdown(symbols);

console.log(`\n── Univers : ${c.total} symbole(s) ──────────────────────────────────`);
for (const r of s.rows) {
  console.log(`  ${r.sector.padEnd(30)} ${String(r.n).padStart(3)}  ${(r.part * 100).toFixed(1)} %`);
}
if (s.unknown) console.log(`  ${'(hors référentiel sectoriel)'.padEnd(30)} ${String(s.unknown).padStart(3)}`);

console.log(`\n── Anonymisation ────────────────────────────────────────────────`);
console.log(`  Dictionnaire manuel  : ${c.manuels} entrée(s)`);
console.log(`  Dictionnaire généré  : ${c.generes} entrée(s)`);
console.log(`  Couverts             : ${c.couverts}/${c.total}  (${(c.part * 100).toFixed(1)} %)`);
console.log(`  Partiels             : ${c.partiels.length}${c.partiels.length ? ` — ${c.partiels.slice(0, 12).join(', ')}${c.partiels.length > 12 ? '…' : ''}` : ''}`);
console.log(`  Absents              : ${c.absents.length}${c.absents.length ? ` — ${c.absents.slice(0, 12).join(', ')}${c.absents.length > 12 ? '…' : ''}` : ''}`);

const manquants = c.partiels.length + c.absents.length;
console.log('\n── Ce que ça implique ───────────────────────────────────────────');
if (manquants === 0) {
  console.log('  Tous les symboles sont anonymisables. Les décisions du carnet fantôme');
  console.log('  portent sur des textes dont l\'entreprise n\'est pas identifiable.\n');
} else {
  console.log(`  ${manquants} symbole(s) partiront avec leur ticker et leur raison sociale masqués,`);
  console.log('  mais leurs DIRIGEANTS et leurs PRODUITS en clair. Un seul nom de dirigeant');
  console.log('  suffit à désigner l\'entreprise : pour ces symboles, l\'anonymisation ne tient pas.');
  console.log('');
  console.log('  Conséquence sur la mesure : leurs décisions sont contaminées par la mémoire');
  console.log('  du modèle et ne devraient pas peser dans le verdict au même titre que les autres.');
  console.log('');
  console.log('  Pour combler :  npm run entities:build\n');
}
