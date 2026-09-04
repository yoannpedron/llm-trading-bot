/**
 * Trois parades au même défaut : le moteur lit mal certains caractères.
 *
 * Sur les recadrages réels, les échecs ne sont pas dus au bruit — ils se
 * répètent à l'identique d'une image à l'autre (mesuré par
 * `ocr-multiframe.mjs`, qui montre que le vote caractère n'apporte rien). Le
 * moteur lit systématiquement « R » comme « K », « 3 » comme « Z », « 1 »
 * comme « I », sur la police à empattements des cartes.
 *
 * On compare donc trois approches :
 *
 *   1. **actuelle** — une passe, alphabet lettres + chiffres + tiret ;
 *   2. **modèle « best »** — le même pipeline avec le modèle LSTM flottant de
 *      Tesseract au lieu du modèle entier « fast », trois fois plus gros ;
 *   3. **deux passes** — la bande entière pour le préfixe, puis le tiers droit
 *      relu avec un alphabet de CHIFFRES SEULS. Un « I » ou un « Z » y devient
 *      alors impossible : c'est la parade que le projet emploie déjà pour le
 *      passcode.
 *
 *     SP=/tmp/ygo APP=$PWD node scripts/ocr-strategies.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const SP = process.env.SP ?? '/tmp';
const APP = process.env.APP ?? path.resolve(import.meta.dirname, '..');
const FIXTURES = path.join(APP, 'scripts/fixtures');
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
/** Part droite de la bande relue en chiffres seuls. */
const PART_NUMERO = Number(process.env.PART_NUMERO ?? 0.34);

const fixtures = fs
  .readdirSync(FIXTURES)
  .filter((f) => /^viseur-.*\.png$/.test(f))
  .map((f) => ({
    fichier: path.join(FIXTURES, f),
    attendu: f.replace(/^viseur-/, '').replace(/\.png$/, '').toUpperCase(),
  }));

/* --- Images : la bande entière, et son tiers droit ----------------------- */

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage();
await page.setContent('<body></body>');
await page.addScriptTag({ path: path.join(SP, 'harness.js') });

const dossier = path.join(SP, 'strategies');
fs.mkdirSync(dossier, { recursive: true });

const cartes = [];
for (const fixture of fixtures) {
  const b64 = fs.readFileSync(fixture.fichier).toString('base64');
  const rendu = await page.evaluate(
    async ({ b64, partNumero }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const P = window.YGO.preprocess;
      const rect = { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
      const scale = P.echelleDeLecture(rect.height);
      const variantes = P.cropVariants(img, rect, { scale, only: ['sauvola'] });
      const bande = variantes[0].canvas;

      // Le tiers droit : le numéro y est, et rien d'autre.
      const largeur = Math.round(bande.width * partNumero);
      const numero = document.createElement('canvas');
      numero.width = largeur;
      numero.height = bande.height;
      numero
        .getContext('2d')
        .drawImage(bande, bande.width - largeur, 0, largeur, bande.height, 0, 0, largeur, bande.height);

      return { bande: bande.toDataURL('image/png'), numero: numero.toDataURL('image/png') };
    },
    { b64, partNumero: PART_NUMERO },
  );

  const bande = path.join(dossier, `${fixture.attendu}-bande.png`);
  const numero = path.join(dossier, `${fixture.attendu}-numero.png`);
  fs.writeFileSync(bande, Buffer.from(rendu.bande.split(',')[1], 'base64'));
  fs.writeFileSync(numero, Buffer.from(rendu.numero.split(',')[1], 'base64'));
  cartes.push({ ...fixture, bande, numero });
}
await browser.close();

/* --- Reconnaissance ------------------------------------------------------ */

const { createWorker, PSM } = await import(path.join(APP, 'node_modules/tesseract.js/src/index.js'));
const { setCodePatterns, PROFILES } = await import(path.join(APP, 'src/lib/ocr.js'));
const { buildSearchIndex, resolveSetCode } = await import(path.join(APP, 'src/lib/match.js'));
const index = buildSearchIndex(
  JSON.parse(fs.readFileSync(path.join(APP, 'public/card-index.json'), 'utf8')),
);

const sansRegion = (code) => String(code ?? '').replace(/-[A-Z]{2}/, '-');
const juge = (texte, attendu) => {
  const resolu = resolveSetCode(index, texte);
  if (resolu.status !== 'matched') return { verdict: 'abandon', code: null };
  const bon = sansRegion(resolu.matchedCode) === sansRegion(attendu);
  return { verdict: bon ? 'bonne' : 'FAUSSE', code: resolu.matchedCode };
};

async function ouvrir({ cache, chiffresSeuls = false }) {
  const worker = await createWorker('eng', 1, { cachePath: cache });
  await worker.writeText('/setcode-patterns.txt', setCodePatterns());
  await worker.reinitialize('eng', 1, { user_patterns_file: '/setcode-patterns.txt' });
  await worker.setParameters(
    chiffresSeuls
      ? { tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: '0123456789' }
      : PROFILES.setCode,
  );
  return worker;
}

const lire = async (worker, fichier) => {
  const debut = performance.now();
  const { data } = await worker.recognize(fichier, {}, { text: true, blocks: false });
  return { texte: (data.text ?? '').trim().replace(/\s+/g, ''), ms: performance.now() - debut };
};

const resultats = [];

/* 1 — une passe, telle que la boucle la fait aujourd'hui.
 *
 * Le modèle « best » (LSTM flottant) a été essayé et ÉCARTÉ, pour deux raisons
 * qu'il ne sert à rien de redécouvrir : il exige une compilation SIMD de
 * Tesseract que le moteur WebAssembly de ce projet n'embarque pas — il
 * s'interrompt sur « missing function: DotProductSSE », et l'erreur remonte
 * hors de toute portée `try` puisqu'elle vient du worker ; et il pèse 12,8 Mo
 * contre 5,2 pour le modèle « fast », ce qui est rédhibitoire sur un réseau
 * mobile où le modèle est déjà le plus gros téléchargement de l'application. */
{
  const worker = await ouvrir({ cache: SP });
  for (const carte of cartes) {
    const { texte, ms } = await lire(worker, carte.bande);
    resultats.push({
      strategie: 'actuelle (une passe)',
      attendu: carte.attendu,
      texte,
      ms,
      ...juge(texte, carte.attendu),
    });
  }
  await worker.terminate();
}

/* 3 — deux passes : bande entière, puis numéro en chiffres seuls. */
{
  const large = await ouvrir({ cache: SP });
  const chiffres = await ouvrir({ cache: SP, chiffresSeuls: true });
  for (const carte of cartes) {
    const a = await lire(large, carte.bande);
    const b = await lire(chiffres, carte.numero);
    // On remplace les trois derniers caractères par ce que la passe chiffres a
    // lu, quand elle en a rendu exactement trois.
    const numero = b.texte.slice(-3);
    const recompose =
      numero.length === 3 && a.texte.length >= 3
        ? a.texte.slice(0, -3) + numero
        : a.texte;
    resultats.push({
      strategie: 'deux passes (numéro en chiffres seuls)',
      attendu: carte.attendu,
      texte: `${a.texte} + ${b.texte} = ${recompose}`,
      ms: a.ms + b.ms,
      ...juge(recompose, carte.attendu),
    });
  }
  await large.terminate();
  await chiffres.terminate();
}

/* --- Rapport ------------------------------------------------------------- */

const strategies = [...new Set(resultats.map((r) => r.strategie))];
for (const strategie of strategies) {
  const lot = resultats.filter((r) => r.strategie === strategie);
  const bonnes = lot.filter((r) => r.verdict === 'bonne').length;
  const fausses = lot.filter((r) => r.verdict === 'FAUSSE').length;
  const ms = Math.round(lot.reduce((s, r) => s + r.ms, 0) / lot.length);
  console.log(`\n${strategie}  —  ${bonnes}/${lot.length} bonnes, ${fausses} fausses, ${ms} ms en moyenne`);
  for (const r of lot) {
    console.log(`   ${r.attendu.padEnd(12)} « ${r.texte} »  → ${r.verdict}${r.code ? ' ' + r.code : ''}`);
  }
}
