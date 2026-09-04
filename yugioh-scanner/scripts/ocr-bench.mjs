/**
 * Banc de lecture : le vrai moteur, sur les vrais recadrages.
 *
 * Deux mesures, sur chaque image de `scripts/fixtures/viseur-*.png` (des
 * recadrages enregistrés depuis le viseur d'un téléphone, nom = code attendu) :
 *
 *   1. **une passe** sur l'image telle quelle : ce que lit le moteur, en
 *      combien de temps, et si la résolution retrouve la bonne carte ;
 *   2. **six images bruitées** dérivées de chacune (tremblement, mise au
 *      point, grain — ce qui change d'une image de viseur à la suivante) : à
 *      quelle image la carte se verrouille, et combien d'images se lisent.
 *
 * Une carte FAUSSE compte plus qu'une carte manquée : l'utilisateur enregistre
 * ce que le viseur affiche. Le banc sert le vrai code par Vite (le moteur vit
 * dans un worker, ce qu'un empaquetage en bibliothèque ne sait pas faire).
 *
 *     node scripts/ocr-bench.mjs            # IMAGES=6 par défaut
 *     IMAGES=10 node scripts/ocr-bench.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const APP = process.env.APP ?? path.resolve(import.meta.dirname, '..');
const FIXTURES = path.join(APP, 'scripts/fixtures');
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const IMAGES = Number(process.env.IMAGES ?? 6);

const fixtures = fs
  .readdirSync(FIXTURES)
  .filter((f) => /^viseur-.*\.png$/.test(f))
  .map((f) => ({
    attendu: f.replace(/^viseur-/, '').replace(/\.png$/, '').toUpperCase(),
    b64: fs.readFileSync(path.join(FIXTURES, f)).toString('base64'),
  }));
if (fixtures.length === 0) {
  console.error(`aucun recadrage dans ${FIXTURES}`);
  process.exit(1);
}

const serveur = await createServer({
  root: APP,
  configFile: false,
  logLevel: 'error',
  server: { port: 0, strictPort: false, host: '127.0.0.1' },
});
await serveur.listen();
const origine = serveur.resolvedUrls.local[0].replace(/\/$/, '');

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage();
const erreurs = [];
page.on('pageerror', (e) => erreurs.push(e.message));
page.on('console', (m) => m.type() === 'error' && erreurs.push(m.text().slice(0, 160)));

try {
  await page.goto(`${origine}/scripts/harness/banc/index.html`, { waitUntil: 'domcontentloaded' });
  const depart = Date.now();
  const etat = await page.evaluate(() => window.__pret);
  console.log(`moteur prêt en ${Date.now() - depart} ms (${etat.provider})`);

  const cartes = JSON.parse(fs.readFileSync(path.join(APP, 'public/card-index.json'), 'utf8'));
  const codes = await page.evaluate((c) => window.__index(c), cartes);
  console.log(`index : ${codes} codes\n`);

  const sansRegion = (code) => String(code ?? '').replace(/-[A-Z]{2}/, '-');
  const juger = (resolu, attendu) => {
    if (resolu.status !== 'matched') return resolu.reason === 'ambiguous' ? 'ambigu' : 'rien';
    return sansRegion(resolu.matchedCode) === sansRegion(attendu) ? 'BONNE' : 'FAUSSE';
  };

  /* --- 1. une passe ------------------------------------------------------ */
  console.log('Une passe, image telle quelle :');
  const bilan = { BONNE: 0, FAUSSE: 0, rien: 0, ambigu: 0 };
  const durees = [];
  for (const { attendu, b64 } of fixtures) {
    const lecture = await page.evaluate((b) => window.__lire(b), b64);
    const verdict = juger(lecture.resolu, attendu);
    bilan[verdict] += 1;
    durees.push(lecture.ms);
    console.log(
      `  ${attendu.padEnd(12)} ${String(lecture.ms).padStart(4)} ms  « ${lecture.text} »  → ${verdict}` +
        (lecture.resolu.matchedCode ? ` ${lecture.resolu.matchedCode} (${lecture.resolu.method})` : ''),
    );
  }
  durees.sort((a, b) => a - b);
  console.log(
    `  bonnes ${bilan.BONNE}/${fixtures.length}  fausses ${bilan.FAUSSE}  rien ${bilan.rien}  ambiguës ${bilan.ambigu}` +
      `  médiane ${durees[Math.floor(durees.length / 2)]} ms\n`,
  );

  /* --- 2. images successives -------------------------------------------- */
  console.log(`${IMAGES} images bruitées par carte (B bonne · F fausse · · rien) :`);
  let bonnes = 0;
  let fausses = 0;
  let verrouillees = 0;
  const tousMs = [];
  for (const { attendu, b64 } of fixtures) {
    const images = await page.evaluate(([b, n]) => window.__bruiter(b, n), [b64, IMAGES]);
    const suite = [];
    let verrou = null;
    for (const image of images) {
      const lecture = await page.evaluate((b) => window.__lire(b), image);
      tousMs.push(lecture.ms);
      const verdict = juger(lecture.resolu, attendu);
      if (verdict === 'BONNE') bonnes += 1;
      if (verdict === 'FAUSSE') fausses += 1;
      suite.push(verdict === 'BONNE' ? 'B' : verdict === 'FAUSSE' ? 'F' : '·');
      if (verdict === 'BONNE' && verrou === null) verrou = suite.length;
    }
    if (verrou !== null) verrouillees += 1;
    console.log(`  ${attendu.padEnd(12)} ${suite.join('')}  verrou à l'image ${verrou ?? '—'}`);
  }
  tousMs.sort((a, b) => a - b);
  console.log(
    `  cartes verrouillées ${verrouillees}/${fixtures.length}  images bonnes ${bonnes}/${IMAGES * fixtures.length}` +
      `  fausses ${fausses}  médiane ${tousMs[Math.floor(tousMs.length / 2)]} ms`,
  );

  if (erreurs.length) console.log(`\nerreurs navigateur : ${erreurs.slice(0, 3).join(' | ')}`);
  process.exitCode = fausses > 0 || bilan.FAUSSE > 0 ? 1 : 0;
} finally {
  await browser.close();
  await serveur.close();
}
