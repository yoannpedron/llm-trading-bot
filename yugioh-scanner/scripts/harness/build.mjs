/**
 * Construit le banc d'essai dans le dossier de travail.
 *
 *     SP=/tmp/ygo node scripts/harness/build.mjs
 *
 * Les variables `VITE_TESSERACT_*` sont reprises telles quelles : pour un banc
 * hors ligne, on les fait pointer vers un moteur servi en local.
 */
import path from 'node:path';
import { build } from 'vite';

const SP = process.env.SP ?? '/tmp';
const entry = path.resolve(import.meta.dirname, 'entry.js');

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    lib: { entry, formats: ['iife'], name: 'ygoHarness', fileName: () => 'harness.js' },
    outDir: SP,
    emptyOutDir: false,
    minify: false,
  },
});

console.log(`banc d'essai écrit dans ${SP}/harness.js`);
