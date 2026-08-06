/**
 * Gestion du pool de clés Gemini en ligne de commande.
 *
 *   npm run keys                       liste les clés et la capacité
 *   npm run keys:add -- <clé> [nom]    ajoute une clé
 *   npm run keys:remove -- <id>        retire une clé
 *
 * Les clés ajoutées ici sont écrites dans `data/llm-keys.json` (ignoré par git)
 * et prises en compte au prochain cycle, sans redémarrer le serveur.
 */
import { keyPool, recommendCron } from '../llm/keyPool.js';
import { config } from '../config.js';

const [action = 'list', ...args] = process.argv.slice(2);

await keyPool.init();

const printCapacity = async () => {
  const c = await keyPool.capacity();
  const total = Number.isFinite(c.totalPerDay) ? c.totalPerDay : 'illimité';
  const cycles = Number.isFinite(c.cyclesPerDay) ? c.cyclesPerDay : 'illimité';

  console.log('\n── CAPACITÉ ─────────────────────────────────────────');
  console.log(`  Clés dans le pool      : ${c.keys}${c.keysExhausted ? ` (${c.keysExhausted} épuisée(s))` : ''}`);
  console.log(`  Quota par clé et jour  : ${c.perKeyLimit || 'illimité'}`);
  console.log(`  Capacité totale/jour   : ${total} appels`);
  console.log(`  Consommé aujourd'hui   : ${c.used}`);
  console.log(`  Restant                : ${Number.isFinite(c.remaining) ? c.remaining : 'illimité'}`);
  console.log(`  Actifs suivis          : ${config.universe.symbols.join(', ')} (${c.callsPerCycle} appel(s)/cycle)`);
  console.log(`  → cycles possibles/jour: ${cycles}`);
  console.log(`  → CRON_SCHEDULE conseillé : ${c.recommendedCron}`);
  console.log(`  Réinitialisation       : ${c.resetsAt}`);
  console.log('─────────────────────────────────────────────────────\n');
};

const printList = async () => {
  const keys = await keyPool.list();
  if (!keys.length) {
    console.log('\nAucune clé dans le pool.');
    console.log('Ajoute-en une : npm run keys:add -- AIzaSy...\n');
    return;
  }
  console.log('\n── CLÉS ─────────────────────────────────────────────');
  for (const k of keys) {
    const status = k.exhausted ? 'ÉPUISÉE' : `${k.calls} utilisé(s), ${k.remaining ?? '∞'} restant(s)`;
    console.log(`  [${k.id}] ${k.masked.padEnd(14)} ${String(k.label).padEnd(16)} ${k.source.padEnd(6)} ${status}`);
  }
  console.log('─────────────────────────────────────────────────────');
};

switch (action) {
  case 'add': {
    const [key, ...labelParts] = args;
    if (!key) {
      console.error('Usage : npm run keys:add -- <clé> [nom]');
      process.exit(1);
    }
    try {
      const added = await keyPool.add(key, labelParts.join(' ') || null);
      console.log(`\n✓ Clé ${added.masked} ajoutée (${added.label}, id ${added.id}).`);
      await printList();
      await printCapacity();
      const c = await keyPool.capacity();
      console.log(`Pense à mettre CRON_SCHEDULE=${recommendCron(c.cyclesPerDay)} dans .env pour exploiter cette capacité.\n`);
    } catch (err) {
      console.error(`\n✗ ${err.message}\n`);
      process.exit(1);
    }
    break;
  }

  case 'remove': {
    const [id] = args;
    if (!id) {
      console.error('Usage : npm run keys:remove -- <id>');
      process.exit(1);
    }
    try {
      await keyPool.remove(id);
      console.log(`\n✓ Clé ${id} retirée.`);
      await printList();
      await printCapacity();
    } catch (err) {
      console.error(`\n✗ ${err.message}\n`);
      process.exit(1);
    }
    break;
  }

  case 'list':
  default:
    await printList();
    await printCapacity();
}

process.exit(0);
