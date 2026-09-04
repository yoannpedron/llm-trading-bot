/**
 * Lecture de vrais recadrages de viseur, par le vrai pipeline.
 *
 * Le banc synthétique (`ocr-confusions.mjs`) ne produit ni la trame
 * d'impression résolue par le capteur, ni la bordure de la carte qui entre
 * dans le viseur, ni un code gris sur fond sombre. Ces trois choses ont fait
 * échouer l'application sur un téléphone réel alors que le banc annonçait
 * 90 % de bonnes cartes. D'où ce script, qui rejoue `scripts/fixtures/*.png`
 * — des recadrages de viseur pris sur l'appareil — dans `cropVariants` puis
 * Tesseract, et dit ce que chaque binarisation en tire.
 *
 *     SP=/tmp/ygo node scripts/harness/real-crops.mjs
 *
 * Pour ajouter une fixture : dans l'application, appuyer sur la vignette en
 * haut à gauche du viseur enregistre le recadrage tel que le moteur le
 * reçoit. Nommer le fichier `viseur-<code>.png` : le code attendu est lu dans
 * le nom.
 *
 * Les deux premières fixtures sont des captures d'écran recadrées, pas des
 * recadrages natifs : la résolution est celle de l'affichage, et le motif de
 * trame peut y différer de ce que voit l'OCR. Elles gardent leur valeur pour
 * la bordure et le contraste ; les remplacer par des recadrages natifs dès
 * qu'il y en a.
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const SP = process.env.SP ?? '/tmp';
const APP = process.env.APP ?? path.resolve(import.meta.dirname, '../..');
const FIXTURES = process.env.FIXTURES ?? path.join(APP, 'scripts/fixtures');
/** Réglages à comparer : chaque entrée est passée telle quelle à `cropVariants`. */
const SETTINGS = {
  'ancien (ni lissage ni rognage)': { smoothRadius: 0, trimToLine: false },
  'lissage Sauvola seul': { trimToLine: false },
  'lissage Otsu + Sauvola, sans rognage': { smoothOtsu: true, trimToLine: false },
  'rognage seul': { smoothRadius: 0 },
  'lissage Sauvola + rognage (défaut)': {},
};

const fixtures = fs
  .readdirSync(FIXTURES)
  .filter((file) => /^viseur-.*\.png$/.test(file))
  .map((file) => ({
    file: path.join(FIXTURES, file),
    expected: file.replace(/^viseur-/, '').replace(/\.png$/, '').toUpperCase(),
  }));

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage();
await page.setContent('<body></body>');
await page.addScriptTag({ path: path.join(SP, 'harness.js') });

const jobs = [];
for (const fixture of fixtures) {
  const b64 = fs.readFileSync(fixture.file).toString('base64');
  for (const [settingIndex, [name, options]] of Object.entries(SETTINGS).entries()) {
    const result = await page.evaluate(
      async ({ b64, options }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const rect = { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
        // Même agrandissement que la boucle de lecture.
        const scale = Math.max(1.5, Math.min(4, 240 / rect.height));
        const variants = window.YGO.preprocess.cropVariants(img, rect, { scale, ...options });
        return {
          sharpness: variants.sharpness,
          variants: variants.map((v) => ({ label: v.label, png: v.canvas.toDataURL('image/png') })),
        };
      },
      { b64, options },
    );
    result.variants.forEach((variant, i) => {
      const file = path.join(
        SP,
        `real-${path.basename(fixture.file, '.png')}-${settingIndex}-${i}.png`,
      );
      fs.writeFileSync(file, Buffer.from(variant.png.split(',')[1], 'base64'));
      jobs.push({ fixture, setting: name, label: variant.label, file, sharpness: result.sharpness });
    });
  }
}
await browser.close();

const { createWorker } = await import(path.join(APP, 'node_modules/tesseract.js/src/index.js'));
const { PROFILES } = await import(path.join(APP, 'src/lib/ocr.js'));
const { buildSearchIndex, resolveSetCode } = await import(path.join(APP, 'src/lib/match.js'));
const index = buildSearchIndex(
  JSON.parse(fs.readFileSync(path.join(APP, 'public/card-index.json'), 'utf8')),
);

const worker = await createWorker('eng', 1, { cachePath: SP });
await worker.setParameters(PROFILES.setCode);

let current = '';
for (const job of jobs) {
  const heading = `${job.expected ?? job.fixture.expected}  (netteté ${job.sharpness.toFixed(3)})`;
  if (heading !== current) {
    current = heading;
    console.log(`\n${heading}`);
  }
  const { data } = await worker.recognize(job.file, {}, { text: true, blocks: false });
  const text = (data.text ?? '').trim().replace(/\s+/g, '');
  const resolved = resolveSetCode(index, text);
  let verdict = resolved.status;
  if (resolved.status === 'matched') {
    const ok = resolved.printings.some(
      (p) => p.setCode.replace(/-[A-Z]{2}/, '') === job.fixture.expected.replace(/-[A-Z]{2}/, ''),
    );
    verdict = `${ok ? 'BONNE' : 'FAUSSE'} ${resolved.matchedCode} (${resolved.method})`;
  } else if (resolved.reason) verdict += ` (${resolved.reason})`;
  console.log(`  ${job.setting.padEnd(32)} ${job.label.padEnd(16)} « ${text} »  → ${verdict}`);
}

await worker.terminate();
