/**
 * Où passe le temps, et ce qu'on perd à aller plus vite.
 *
 * Le mode sniper lit en continu : chaque tour coûte un prétraitement, puis une
 * ou deux reconnaissances. Tant qu'on ne sait pas ce que coûte chaque poste, on
 * optimise à l'aveugle — et l'on rend le pipeline moins fiable pour rien.
 *
 * Ce banc mesure trois choses sur les vrais recadrages de `scripts/fixtures/` :
 *
 *   1. le coût de chaque étage de prétraitement, séparément ;
 *   2. le coût d'une reconnaissance selon l'agrandissement, le mode de
 *      segmentation, et le réglage `tessedit_do_invert` ;
 *   3. ce que chaque configuration lit, et si la carte est retrouvée.
 *
 * On ne retient un réglage plus rapide que s'il ne perd aucune identification.
 *
 *     SP=/tmp/ygo APP=$PWD node scripts/ocr-bench.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const SP = process.env.SP ?? '/tmp';
const APP = process.env.APP ?? path.resolve(import.meta.dirname, '..');
const FIXTURES = path.join(APP, 'scripts/fixtures');
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
/** Répétitions par mesure : une seule prise est dominée par le bruit. */
const PASSES = Number(process.env.PASSES ?? 3);

const fixtures = fs
  .readdirSync(FIXTURES)
  .filter((f) => /^viseur-.*\.png$/.test(f))
  .map((f) => ({
    fichier: path.join(FIXTURES, f),
    attendu: f.replace(/^viseur-/, '').replace(/\.png$/, '').toUpperCase(),
  }));

const mediane = (valeurs) => {
  const tri = [...valeurs].sort((a, b) => a - b);
  return tri[Math.floor(tri.length / 2)];
};

/* --- 1. Prétraitement, étage par étage, dans le navigateur --------------- */

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage();
await page.setContent('<body></body>');
await page.addScriptTag({ path: path.join(SP, 'harness.js') });

console.log('PRÉTRAITEMENT — millisecondes par étage, médiane sur', PASSES, 'passes\n');
console.log('fixture            taille    gris  lissage  otsu  sauvola  bande  TOTAL  variantes');

const echelles = {};
for (const fixture of fixtures) {
  const b64 = fs.readFileSync(fixture.fichier).toString('base64');
  const mesure = await page.evaluate(
    async ({ b64, passes }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const P = window.YGO.preprocess;
      const rect = { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
      const scale = Math.max(1.5, Math.min(4, 240 / rect.height));
      const w = Math.round(rect.width * scale);
      const h = Math.round(rect.height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const cx = canvas.getContext('2d', { willReadFrequently: true });
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(img, 0, 0, rect.width, rect.height, 0, 0, w, h);
      const pixels = cx.getImageData(0, 0, w, h);

      const chrono = (fn) => {
        const debut = performance.now();
        const valeur = fn();
        return [performance.now() - debut, valeur];
      };

      const releves = { gris: [], lissage: [], otsu: [], sauvola: [], bande: [], total: [], variantes: [] };
      let gris;
      for (let n = 0; n < passes; n += 1) {
        const [tGris, g] = chrono(() => P.toGrayscale(pixels));
        gris = g;
        const [tLissage, lisse] = chrono(() => P.smooth(gris, w, h, Math.round(h / 120)));
        const [tOtsu, o] = chrono(() => P.preprocessGray(gris));
        const [tSauvola, s] = chrono(() => P.sauvolaThreshold(lisse, w, h));
        const [tBande] = chrono(() => P.textBand(s, w, h));
        const [tVariantes] = chrono(() => P.cropVariants(img, rect, { scale }));
        releves.gris.push(tGris);
        releves.lissage.push(tLissage);
        releves.otsu.push(tOtsu);
        releves.sauvola.push(tSauvola);
        releves.bande.push(tBande);
        releves.total.push(tGris + tLissage + tOtsu + tSauvola + tBande);
        releves.variantes.push(tVariantes);
        void o;
      }
      return { w, h, scale, releves };
    },
    { b64, passes: PASSES },
  );

  echelles[fixture.attendu] = mesure.scale;
  const m = (cle) => mediane(mesure.releves[cle]).toFixed(0).padStart(5);
  console.log(
    `${fixture.attendu.padEnd(18)} ${String(mesure.w + '×' + mesure.h).padEnd(9)}` +
      `${m('gris')} ${m('lissage')} ${m('otsu')} ${m('sauvola')} ${m('bande')} ${m('total')}  ${m('variantes')}`,
  );
}

/* --- 2. Images à soumettre, pour chaque agrandissement testé ------------- */

const AGRANDISSEMENTS = [1.5, 2, 2.5, 3.5];
const dossier = path.join(SP, 'bench');
fs.mkdirSync(dossier, { recursive: true });

const images = [];
for (const fixture of fixtures) {
  const b64 = fs.readFileSync(fixture.fichier).toString('base64');
  const rendus = await page.evaluate(
    async ({ b64, agrandissements }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const P = window.YGO.preprocess;
      const rect = { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
      const out = [];
      for (const scale of agrandissements) {
        const variantes = P.cropVariants(img, rect, { scale });
        // Seul Sauvola lit une vraie carte : Otsu sert de témoin.
        for (const rang of [0, 1]) {
          out.push({
            scale,
            label: variantes[rang].label,
            hauteur: variantes[rang].canvas.height,
            largeur: variantes[rang].canvas.width,
            png: variantes[rang].canvas.toDataURL('image/png'),
          });
        }
      }
      return out;
    },
    { b64, agrandissements: AGRANDISSEMENTS },
  );

  for (const rendu of rendus) {
    const fichier = path.join(dossier, `${fixture.attendu}-${rendu.scale}-${rendu.label}.png`);
    fs.writeFileSync(fichier, Buffer.from(rendu.png.split(',')[1], 'base64'));
    images.push({ ...rendu, fichier, attendu: fixture.attendu });
  }
}
await browser.close();

/* --- 3. Reconnaissance : coût et résultat selon les réglages ------------- */

const { createWorker, PSM } = await import(path.join(APP, 'node_modules/tesseract.js/src/index.js'));
const { setCodePatterns, PROFILES } = await import(path.join(APP, 'src/lib/ocr.js'));
const { buildSearchIndex, resolveSetCode } = await import(path.join(APP, 'src/lib/match.js'));
const index = buildSearchIndex(
  JSON.parse(fs.readFileSync(path.join(APP, 'public/card-index.json'), 'utf8')),
);

const CONFIGURATIONS = [
  { nom: 'PSM6 · invert on (actuel)', psm: PSM.SINGLE_BLOCK, invert: null },
  { nom: 'PSM6 · invert off', psm: PSM.SINGLE_BLOCK, invert: '0' },
  { nom: 'PSM7 · invert off', psm: PSM.SINGLE_LINE, invert: '0' },
  { nom: 'PSM13 · invert off', psm: PSM.RAW_LINE, invert: '0' },
];

console.log('\n\nRECONNAISSANCE — millisecondes par image, médiane sur', PASSES, 'passes');
console.log('Une configuration n’est retenue que si elle ne perd aucune identification.\n');

const resultats = [];
for (const config of CONFIGURATIONS) {
  const worker = await createWorker('eng', 1, { cachePath: SP });
  await worker.writeText('/setcode-patterns.txt', setCodePatterns());
  const reglages = { user_patterns_file: '/setcode-patterns.txt' };
  if (config.invert !== null) reglages.tessedit_do_invert = config.invert;
  await worker.reinitialize('eng', 1, reglages);
  await worker.setParameters({ ...PROFILES.setCode, tessedit_pageseg_mode: config.psm });

  for (const image of images) {
    const temps = [];
    let texte = '';
    for (let n = 0; n < PASSES; n += 1) {
      const debut = performance.now();
      const { data } = await worker.recognize(image.fichier, {}, { text: true, blocks: false });
      temps.push(performance.now() - debut);
      texte = (data.text ?? '').trim().replace(/\s+/g, '');
    }
    const resolu = resolveSetCode(index, texte);
    const base = (code) => String(code).replace(/-[A-Z]{2}/, '-');
    const bonne =
      resolu.status === 'matched' && base(resolu.matchedCode) === base(image.attendu);
    resultats.push({ config: config.nom, ...image, ms: mediane(temps), texte, bonne, statut: resolu.status });
  }
  await worker.terminate();
}

/* --- 4. Rapport ---------------------------------------------------------- */

for (const config of CONFIGURATIONS) {
  const lot = resultats.filter((r) => r.config === config.nom);
  console.log(`\n${config.nom}`);
  console.log('  échelle  hauteur  binarisation      ms   carte   lecture');
  for (const scale of AGRANDISSEMENTS) {
    for (const label of ['otsu', 'sauvola']) {
      const lignes = lot.filter((r) => r.scale === scale && r.label === label);
      if (!lignes.length) continue;
      const ms = Math.round(lignes.reduce((s, r) => s + r.ms, 0) / lignes.length);
      const bonnes = lignes.filter((r) => r.bonne).length;
      const exemple = lignes.find((r) => r.label === 'sauvola') ?? lignes[0];
      console.log(
        `  ×${String(scale).padEnd(7)} ${String(lignes[0].hauteur).padStart(6)}  ${label.padEnd(10)} ${String(ms).padStart(6)}   ${bonnes}/${lignes.length}   « ${exemple.texte.slice(0, 30)} »`,
      );
    }
  }
}

console.log('\n\nSYNTHÈSE — Sauvola seul, la seule binarisation qui lit une vraie carte\n');
console.log('configuration                échelle    ms   cartes retrouvées');
for (const config of CONFIGURATIONS) {
  for (const scale of AGRANDISSEMENTS) {
    const lignes = resultats.filter(
      (r) => r.config === config.nom && r.scale === scale && r.label === 'sauvola',
    );
    if (!lignes.length) continue;
    const ms = Math.round(lignes.reduce((s, r) => s + r.ms, 0) / lignes.length);
    const bonnes = lignes.filter((r) => r.bonne).length;
    console.log(
      `${config.nom.padEnd(28)} ×${String(scale).padEnd(6)} ${String(ms).padStart(5)}   ${bonnes}/${lignes.length}` +
        (bonnes === lignes.length ? '  ✓' : ''),
    );
  }
}
