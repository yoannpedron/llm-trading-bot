/**
 * Construit l'index des empreintes d'illustration (`public/art-index.bin`).
 *
 * Source : les visuels officiels `cards_small` (268×391) de YGOPRODeck,
 * téléchargés une fois dans un dossier local (voir `ARTS`), une image par
 * passcode. L'empreinte est calculée par le VRAI code de l'application, dans
 * Chromium, page servie par Vite — jamais par une réimplémentation Node qui
 * divergerait en silence.
 *
 *     ARTS=/chemin/vers/arts/small node scripts/build-art-index.mjs [sortie]
 *     LIMITE=3000 ... (pour un essai rapide)
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const APP = path.resolve(import.meta.dirname, '..');
const ARTS = process.env.ARTS;
const SORTIE = path.resolve(process.argv[2] ?? path.join(APP, 'public/art-index.bin'));
const LIMITE = Number(process.env.LIMITE ?? Infinity);
/** Variantes de cadrage par carte : contractions du contour (0 = bord exact). */
const VARIANTES = (process.env.VARIANTES ?? '0').split(',').map(Number);
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (!ARTS || !fs.existsSync(ARTS)) {
  console.error('ARTS doit pointer vers le dossier des visuels cards_small (<id>.jpg)');
  process.exit(1);
}

const { construireIndexArt, serialiserIndexArt } = await import(path.join(APP, 'src/lib/art.js'));

const ids = fs
  .readdirSync(ARTS)
  .filter((f) => /^\d+\.jpg$/.test(f))
  .map((f) => Number(f.replace('.jpg', '')))
  .sort((a, b) => a - b)
  .slice(0, LIMITE);

const serveur = await createServer({ root: APP, configFile: false, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await serveur.listen();
const origine = serveur.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage();
await page.route('**/arts/*.jpg', (route) => {
  const nom = route.request().url().split('/').pop();
  route.fulfill({ path: path.join(ARTS, nom), contentType: 'image/jpeg' });
});

try {
  await page.goto(`${origine}/scripts/harness/banc-art/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__pret, { timeout: 60000 });

  const entrees = [];
  let manquantes = 0;
  const debut = Date.now();
  for (let i = 0; i < ids.length; i += 100) {
    const lot = ids.slice(i, i + 100);
    const urls = lot.map((id) => `${origine}/arts/${id}.jpg`);
    for (const contraction of VARIANTES) {
      const empreintes = await page.evaluate(([u, c]) => window.__empreintes(u, c), [urls, contraction]);
      empreintes.forEach((e, j) => {
        if (e) entrees.push({ id: lot[j], empreinte: Uint8Array.from(e) });
        else manquantes += 1;
      });
    }
    if ((i / 100) % 20 === 0) process.stdout.write(`\r${entrees.length} empreintes, ${Math.round((Date.now() - debut) / 1000)} s`);
  }
  const index = construireIndexArt(entrees);
  fs.mkdirSync(path.dirname(SORTIE), { recursive: true });
  fs.writeFileSync(SORTIE, serialiserIndexArt(index));
  console.log(`\nindex écrit : ${SORTIE} — ${index.taille} cartes, ${manquantes} illisibles, ${Math.round(fs.statSync(SORTIE).size / 1024)} Ko`);
} finally {
  await browser.close();
  await serveur.close();
}
