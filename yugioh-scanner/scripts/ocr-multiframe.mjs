/**
 * Ce que plusieurs images successives apportent, sur une vraie carte.
 *
 * Le viseur ne dispose jamais d'une seule image : il en lit trois ou quatre par
 * seconde. La question est de savoir si les combiner vaut mieux que de prendre
 * la meilleure — et de combien.
 *
 * Le banc synthétique ne peut pas y répondre : depuis `user_patterns`, il lit
 * 95 % des codes du premier coup, et il ne reste rien à gagner. On simule donc
 * des images successives à partir des recadrages RÉELS de `scripts/fixtures/` :
 * même carte, même cadrage, mais le bruit du capteur, le micro-tremblement de
 * la main et le reflet changent d'une image à l'autre. C'est exactement ce qui
 * distingue deux images consécutives d'un viseur.
 *
 * Deux stratégies sont comparées :
 *
 *   - **meilleure lecture** — ce que fait la boucle aujourd'hui : on essaie, et
 *     la première lecture qui se résout gagne ;
 *   - **vote caractère** — on accumule les lectures et on élit chaque position
 *     à la majorité, puis on résout le consensus.
 *
 *     SP=/tmp/ygo APP=$PWD node scripts/ocr-multiframe.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const SP = process.env.SP ?? '/tmp';
const APP = process.env.APP ?? path.resolve(import.meta.dirname, '..');
const FIXTURES = path.join(APP, 'scripts/fixtures');
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
/** Nombre d'images simulées par carte : ce qu'un viseur produit en ~1,5 s. */
const IMAGES = Number(process.env.IMAGES ?? 6);

const fixtures = fs
  .readdirSync(FIXTURES)
  .filter((f) => /^viseur-.*\.png$/.test(f))
  .map((f) => ({
    fichier: path.join(FIXTURES, f),
    attendu: f.replace(/^viseur-/, '').replace(/\.png$/, '').toUpperCase(),
  }));

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage();
await page.setContent('<body></body>');
await page.addScriptTag({ path: path.join(SP, 'harness.js') });

const dossier = path.join(SP, 'multiframe');
fs.mkdirSync(dossier, { recursive: true });

const travaux = [];
for (const fixture of fixtures) {
  const b64 = fs.readFileSync(fixture.fichier).toString('base64');
  const rendus = await page.evaluate(
    async ({ b64, images }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const P = window.YGO.preprocess;
      const L = img.naturalWidth;
      const H = img.naturalHeight;

      // Générateur déterministe : deux exécutions comparent les mêmes images.
      let graine = 12345;
      const alea = () => {
        graine = (graine * 1103515245 + 12345) % 2147483648;
        return graine / 2147483648;
      };

      const sortie = [];
      for (let n = 0; n < images; n += 1) {
        const c = document.createElement('canvas');
        c.width = L;
        c.height = H;
        const cx = c.getContext('2d', { willReadFrequently: true });

        // Ce qui change réellement d'une image de viseur à la suivante :
        // un tremblement de main sous le pixel, une mise au point qui
        // respire, et le grain du capteur — qui, lui, est neuf à chaque fois.
        const dx = (alea() - 0.5) * 3;
        const dy = (alea() - 0.5) * 2;
        const flou = n === 0 ? 0 : alea() * 0.7;
        cx.filter = flou > 0.05 ? `blur(${flou.toFixed(2)}px)` : 'none';
        cx.drawImage(img, dx, dy, L, H);
        cx.filter = 'none';

        const donnees = cx.getImageData(0, 0, L, H);
        const amplitude = 10 + alea() * 14;
        for (let i = 0; i < donnees.data.length; i += 4) {
          const bruit = (alea() - 0.5) * amplitude;
          donnees.data[i] += bruit;
          donnees.data[i + 1] += bruit;
          donnees.data[i + 2] += bruit;
        }
        cx.putImageData(donnees, 0, 0);

        const scale = P.echelleDeLecture(H);
        const variantes = P.cropVariants(c, { x: 0, y: 0, width: L, height: H }, {
          scale,
          only: ['sauvola', 'sauvola-inverse'],
        });
        sortie.push({ image: n, png: variantes[0].canvas.toDataURL('image/png') });
      }
      return sortie;
    },
    { b64, images: IMAGES },
  );

  for (const rendu of rendus) {
    const fichier = path.join(dossier, `${fixture.attendu}-${rendu.image}.png`);
    fs.writeFileSync(fichier, Buffer.from(rendu.png.split(',')[1], 'base64'));
    travaux.push({ ...fixture, image: rendu.image, fichier });
  }
}
await browser.close();

/* --- Reconnaissance ------------------------------------------------------ */

const { createWorker } = await import(path.join(APP, 'node_modules/tesseract.js/src/index.js'));
const { configureSetCodeWorker } = await import(path.join(APP, 'src/lib/ocr.js'));
const { buildSearchIndex, resolveSetCode } = await import(path.join(APP, 'src/lib/match.js'));
const { CharacterVote } = await import(path.join(APP, 'src/lib/vote.js'));

const index = buildSearchIndex(
  JSON.parse(fs.readFileSync(path.join(APP, 'public/card-index.json'), 'utf8')),
);
const worker = await createWorker('eng', 1, { cachePath: SP });
await configureSetCodeWorker(worker);

const sansRegion = (code) => String(code ?? '').replace(/-[A-Z]{2}/, '-');
const juge = (texte, attendu) => {
  const resolu = resolveSetCode(index, texte);
  if (resolu.status !== 'matched') return 'abandon';
  return sansRegion(resolu.matchedCode) === sansRegion(attendu) ? 'bonne' : 'fausse';
};

const lecturesPar = new Map();
for (const travail of travaux) {
  const { data } = await worker.recognize(travail.fichier, {}, { text: true, blocks: false });
  const texte = (data.text ?? '').trim().replace(/\s+/g, '');
  const groupe = lecturesPar.get(travail.attendu) ?? [];
  groupe.push(texte);
  lecturesPar.set(travail.attendu, groupe);
}
await worker.terminate();

/* --- Rapport ------------------------------------------------------------- */

console.log(`${fixtures.length} cartes réelles, ${IMAGES} images simulées chacune\n`);

const bilan = { meilleure: { bonne: 0, fausse: 0, abandon: 0 }, vote: { bonne: 0, fausse: 0, abandon: 0 } };

for (const [attendu, lectures] of lecturesPar) {
  console.log(attendu);
  for (const [rang, texte] of lectures.entries()) {
    console.log(`   image ${rang}  « ${texte} »  ${juge(texte, attendu)}`);
  }

  // Stratégie actuelle : la première lecture qui se résout l'emporte.
  const verdicts = lectures.map((t) => juge(t, attendu));
  const meilleure = verdicts.includes('bonne')
    ? 'bonne'
    : verdicts.includes('fausse')
      ? 'fausse'
      : 'abandon';
  bilan.meilleure[meilleure] += 1;

  // Stratégie proposée : consensus caractère par caractère.
  const vote = new CharacterVote({ needed: 2, now: () => 0 });
  let consensus = null;
  for (const texte of lectures) consensus = vote.cast(texte) ?? consensus;
  const verdictVote = consensus ? juge(consensus, attendu) : meilleure;
  bilan.vote[verdictVote] += 1;

  console.log(`   consensus « ${consensus ?? '—'} »  ${verdictVote}`);
  console.log(`   meilleure lecture : ${meilleure}   ·   vote caractère : ${verdictVote}\n`);
}

console.log('BILAN');
console.log('stratégie            bonnes  fausses  abandons');
for (const [nom, compte] of Object.entries(bilan)) {
  console.log(
    `${nom.padEnd(20)} ${String(compte.bonne).padStart(6)} ${String(compte.fausse).padStart(8)} ${String(compte.abandon).padStart(9)}`,
  );
}
