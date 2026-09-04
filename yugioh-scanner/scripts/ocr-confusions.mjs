/**
 * Matrice de confusion **de notre pipeline**, pas des formes idéales.
 *
 * Comparer les silhouettes de deux glyphes ne tranche rien : selon qu'on
 * préserve ou non le rapport largeur/hauteur, « 0 » et « O » sortent très
 * proches ou très différents. Ce qui décide, ce n'est ni la police idéale ni la
 * géométrie, c'est ce que Tesseract rend **après** notre binarisation, à la
 * résolution du viseur, sur une image dégradée comme une vraie prise de vue.
 *
 * Ce script fabrique donc des codes d'extension synthétiques, les rend à
 * l'échelle du viseur, les abîme (flou, reflet, bruit, rotation), les fait
 * passer par le vrai recadrage et la vraie binarisation, puis compare caractère
 * par caractère ce que l'OCR rend à ce qui était imprimé.
 *
 *     SP=<dossier de travail> node scripts/ocr-confusions.mjs
 *
 * Deux taux sont rapportés, et c'est le second qui compte :
 *
 *  - **lecture exacte** — le code relu caractère pour caractère ;
 *  - **carte identifiée** — la base retrouve la bonne carte malgré les erreurs.
 *
 * Le premier est une curiosité, le second est l'objectif. Un code lu
 * « RAO3-FR0O1 » est une réussite si la base en tire la bonne carte : c'est elle
 * le correcteur d'erreurs, pas les tables de transposition.
 *
 * Les codes sont tirés de l'index réel plutôt qu'inventés : un code au hasard
 * mesurerait la reconnaissance de chaînes aléatoires, ce que personne ne scanne.
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const SP = process.env.SP ?? '/tmp';
const HARNESS = process.env.HARNESS ?? path.join(SP, 'harness.js');
// Surchargeable : le script tourne parfois depuis un dossier de travail où
// `playwright` est résolvable, et le projet est alors ailleurs.
const APP = process.env.APP ?? path.resolve(import.meta.dirname, '..');
const COUNT = Number(process.env.COUNT ?? 36);

const REGIONS = ['EN', 'FR', 'DE', 'IT', 'SP', 'PT'];

/** Générateur déterministe : deux exécutions comparent les mêmes codes. */
function makeRandom(seed = 7) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const random = makeRandom();
const pick = (list) => list[Math.floor(random() * list.length)];

/**
 * Codes tirés de l'index embarqué, avec leur carte attendue.
 *
 * Un code sur deux est régionalisé : c'est le cas d'usage français, et il
 * éprouve au passage la résolution par retrait de la région.
 */
function sampleCodes(index, count) {
  const printed = [...index.byExactCode.keys()].filter((code) =>
    /^[A-Z0-9]{2,5}-[A-Z]{2}\d{3}$/.test(code),
  );

  const out = [];
  const seen = new Set();
  while (out.length < count && seen.size < printed.length) {
    const code = printed[Math.floor(random() * printed.length)];
    if (seen.has(code)) continue;
    seen.add(code);

    const position = [...index.byExactCode.get(code)][0];
    const attendu = index.cards[position].id;
    const regionalise =
      random() < 0.5 ? code.replace(/-[A-Z]{2}/, `-${pick(REGIONS)}`) : code;
    out.push({ imprime: regionalise, carte: attendu });
  }
  return out;
}

const APP_INDEX = path.join(APP, 'public/card-index.json');
const { buildSearchIndex, resolveSetCode } = await import(path.join(APP, 'src/lib/match.js'));
const index = buildSearchIndex(JSON.parse(fs.readFileSync(APP_INDEX, 'utf8')));

const echantillon = sampleCodes(index, COUNT);
const codes = echantillon.map((entry) => entry.imprime);
const levels = ['moyen', 'fort'];

/* --- 1. Fabrication des images, avec le vrai recadrage ------------------- */

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.setContent('<body style="margin:0"></body>');
await page.addScriptTag({ path: HARNESS });

const shots = await page.evaluate(
  ({ codes, levels }) => {
    const { preprocess, viewport } = window.YGO;
    const W = 1920;
    const H = 1080;
    const container = { width: 390, height: 844 };

    // Ce que le viseur découpe réellement dans la vidéo : c'est *dans* ce
    // rectangle que le code doit tenir, avec une marge, comme le cadre un
    // utilisateur. Une première version rendait le code à taille fixe, plus
    // large que le viseur : le banc coupait lui-même le premier et le dernier
    // caractère, et mesurait ses propres amputations comme des erreurs d'OCR
    // (« RA03-EN10 » pour « RA03-EN107 »).
    const rect = viewport.toVideoRect(
      viewport.reticleRect(container),
      { width: W, height: H },
      container,
    );
    const FILL = 0.78;

    const out = [];
    for (const code of codes) {
      for (const level of levels) {
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const context = canvas.getContext('2d', { willReadFrequently: true });

        // Fond beige de la bande où le code est imprimé, avec son dégradé.
        const fond = context.createLinearGradient(0, 0, W, H);
        fond.addColorStop(0, '#c8a765');
        fond.addColorStop(1, '#e0c58c');
        context.fillStyle = fond;
        context.fillRect(0, 0, W, H);

        context.save();
        context.translate(W / 2, H / 2);
        context.rotate(((level === 'fort' ? 2.2 : 1) * Math.PI) / 180);
        context.filter = level === 'fort' ? 'blur(1.4px)' : 'blur(0.6px)';
        context.fillStyle = '#1a1208';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.font = 'bold 100px "Liberation Sans", sans-serif';
        const size = Math.floor((100 * rect.width * FILL) / context.measureText(code).width);
        context.font = `bold ${size}px "Liberation Sans", sans-serif`;
        context.fillText(code, 0, 0);
        context.restore();

        const reflet = context.createLinearGradient(0, 0, W, H);
        reflet.addColorStop(0, 'rgba(255,255,255,0)');
        reflet.addColorStop(0.42, `rgba(255,255,255,${level === 'fort' ? 0.4 : 0.22})`);
        reflet.addColorStop(0.72, 'rgba(255,255,255,0)');
        context.fillStyle = reflet;
        context.fillRect(0, 0, W, H);

        const bruit = context.getImageData(0, 0, W, H);
        const amplitude = level === 'fort' ? 28 : 14;
        for (let i = 0; i < bruit.data.length; i += 4) {
          const n = (Math.random() - 0.5) * amplitude;
          bruit.data[i] += n;
          bruit.data[i + 1] += n;
          bruit.data[i + 2] += n;
        }
        context.putImageData(bruit, 0, 0);

        // Même règle que la boucle de lecture : viser une bande d'environ
        // 110 px, mesurée comme la plus rapide ET la plus fiable.
        const scale = preprocess.echelleDeLecture(rect.height);
        const variants = preprocess.cropVariants(canvas, rect, { scale });

        out.push({
          code,
          level,
          sharpness: variants.sharpness,
          // Otsu puis Sauvola : les deux polarités directes, comme la boucle.
          png: [variants[0].canvas.toDataURL('image/png'), variants[1].canvas.toDataURL('image/png')],
        });
      }
    }
    return out;
  },
  { codes, levels },
);

await browser.close();

const dir = path.join(SP, 'confusions');
fs.mkdirSync(dir, { recursive: true });
shots.forEach((shot, index) => {
  shot.files = shot.png.map((data, variant) => {
    const file = path.join(dir, `${index}-${variant}.png`);
    fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
    return file;
  });
  delete shot.png;
});

/* --- 2. OCR avec le profil réel ----------------------------------------- */

const { createWorker } = await import(
  path.join(APP, 'node_modules/tesseract.js/src/index.js')
);
const { configureSetCodeWorker } = await import(path.join(APP, 'src/lib/ocr.js'));
const { extractSetCodes } = await import(path.join(APP, 'src/lib/parse.js'));

const worker = await createWorker('eng', 1, { cachePath: SP });
await configureSetCodeWorker(worker);

const confusions = new Map();
const stats = Object.fromEntries(
  levels.map((level) => [level, { total: 0, brut: 0, identifie: 0, faux: 0 }]),
);
const attenduPour = new Map(echantillon.map((entry) => [entry.imprime, entry.carte]));
/** Lectures brutes conservées : le balayage de seuil se fait sans re-OCRiser. */
const lectures = [];

for (const shot of shots) {
  const attendu = shot.code;
  stats[shot.level].total += 1;

  let brut = '';
  for (const file of shot.files) {
    const { data } = await worker.recognize(file, {}, { text: true, blocks: false });
    const texte = (data.text ?? '').trim().replace(/\s+/g, '');
    if (texte) {
      brut = texte;
      break;
    }
  }

  if (brut === attendu) stats[shot.level].brut += 1;

  // Le vrai critère : la base retrouve-t-elle la bonne carte ?
  const resolu = resolveSetCode(index, brut);
  if (resolu.status === 'matched') {
    if (resolu.card.id === attenduPour.get(attendu)) stats[shot.level].identifie += 1;
    else stats[shot.level].faux += 1;
  }

  lectures.push({ level: shot.level, imprime: attendu, brut, carte: attenduPour.get(attendu) });

  // Confusions caractère par caractère, seulement quand les longueurs
  // correspondent : une lettre perdue décalerait tout et fabriquerait des
  // confusions imaginaires.
  if (brut.length === attendu.length) {
    for (let i = 0; i < attendu.length; i += 1) {
      if (attendu[i] === brut[i]) continue;
      const key = `${attendu[i]}->${brut[i]}`;
      confusions.set(key, (confusions.get(key) ?? 0) + 1);
    }
  }
}

await worker.terminate();

/* --- 3. Rapport ---------------------------------------------------------- */

console.log(`${COUNT} codes réels, ${levels.length} niveaux de dégradation\n`);
console.log('niveau   lecture exacte   carte identifiée   mauvaise carte');
for (const level of levels) {
  const { total, brut, identifie, faux } = stats[level];
  const pct = (n) => `${String(n).padStart(3)}/${total} (${String(Math.round((n / total) * 100)).padStart(3)}%)`;
  console.log(`${level.padEnd(8)} ${pct(brut)}    ${pct(identifie)}     ${pct(faux)}`);
}

/* --- Balayage du seuil et de la marge d'ambiguïté ----------------------- */

/**
 * Chaque ligne rejoue les lectures conservées avec un autre réglage. Les
 * correspondances exactes et régionales ne dépendent d'aucun des deux : ce que
 * la ligne « 100 » affiche est le socle, et le reste dit ce que l'approché
 * ajoute — en bonnes cartes comme en fausses.
 */
function balayage(options) {
  let bonnes = 0;
  let fausses = 0;
  for (const { brut, carte } of lectures) {
    const resolu = resolveSetCode(index, brut, options);
    if (resolu.status !== 'matched') continue;
    if (resolu.card.id === carte) bonnes += 1;
    else fausses += 1;
  }
  return { bonnes, fausses, abandons: lectures.length - bonnes - fausses };
}

const pct = (n) => `${String(Math.round((n / lectures.length) * 100)).padStart(3)}%`;
const ligne = (libelle, { bonnes, fausses, abandons }) =>
  console.log(
    `${libelle}    ${String(bonnes).padStart(3)} ${pct(bonnes)}   ` +
      `${String(fausses).padStart(3)} ${pct(fausses)}   ${String(abandons).padStart(3)} ${pct(abandons)}`,
  );

console.log('\nEffet du seuil approché, sans marge (toutes dégradations confondues) :\n');
console.log('seuil   identifiées   fausses   abandons');
for (const cutoff of [82, 86, 88, 90, 92, 94, 96, 100]) {
  ligne(String(cutoff).padStart(4), balayage({ cutoff, margin: 0 }));
}

console.log('\nEffet de la marge d\'ambiguïté (second candidat distinct trop proche = refus) :\n');
console.log('seuil  marge   identifiées   fausses   abandons');
for (const cutoff of [82, 86, 88]) {
  for (const margin of [0, 1, 12.5]) {
    ligne(`${String(cutoff).padStart(4)}  ${String(margin).padStart(5)}`, balayage({ cutoff, margin }));
  }
}

fs.writeFileSync(path.join(SP, 'lectures.json'), JSON.stringify(lectures, null, 1));

const classees = [...confusions.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\nConfusions observées (${classees.length} distinctes) :\n`);
for (const [key, count] of classees.slice(0, 24)) {
  const [attendu, lu] = key.split('->');
  const nature =
    /\d/.test(attendu) === /\d/.test(lu) ? 'même famille' : 'LETTRE <-> CHIFFRE';
  console.log(`  ${attendu} lu « ${lu} »   x${String(count).padStart(2)}   ${nature}`);
}
