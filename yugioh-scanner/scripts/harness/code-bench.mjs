/**
 * À partir de quelle taille de carte à l'écran le code de tirage se lit-il ?
 *
 * Les visuels officiels sont des « Replica » sans code : on l'imprime à sa
 * place sur la carte haute résolution (813×1185), on met la carte en scène
 * (1080×1920, perspective, flou, grain), on la redresse depuis ses VRAIS coins
 * (borne haute : la détection n'entre pas en jeu), on découpe la bande du
 * code et on la lit avec le moteur OCR de l'application. Le code lu est
 * comparé aux tirages de la carte de deux façons : tel quel (région ignorée),
 * et par le plus proche des codes de CETTE carte — c'est ce que fera
 * l'application, qui connaît la carte avant de lire son code.
 *
 *     SP=… FULL=…/arts/full node scripts/harness/code-bench.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const APP = path.resolve(import.meta.dirname, '../..');
const SP = process.env.SP;
const FULL = process.env.FULL;
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TAILLES = [0.5, 0.6, 0.7, 0.8, 0.9];
const FLOUS = [0, 0.8, 1.6];

const { codeSimilarity } = await import(path.join(APP, 'src/lib/match.js'));
const index = JSON.parse(fs.readFileSync(path.join(APP, 'public/card-index.json'), 'utf8'));
const parId = new Map(index.cards.map((c) => [c[0], c]));
const ids = fs.readFileSync(path.join(FULL, 'ids.txt'), 'utf8').trim().split(/\s+/).map(Number).filter((id) => fs.existsSync(path.join(FULL, `${id}.jpg`)));
const sansRegion = (code) => String(code ?? '').toUpperCase().replace(/^([A-Z0-9]+)-[A-Z]{1,2}(?=[A-Z]?\d)/, '$1-');

const serveur = await createServer({ root: APP, configFile: false, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await serveur.listen();
const origine = serveur.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('erreur page :', e.message));
await page.route('**/full/*.jpg', (route) => route.fulfill({ path: path.join(FULL, route.request().url().split('/').pop()), contentType: 'image/jpeg' }));

const lignes = [];
try {
  await page.goto(`${origine}/scripts/harness/banc-art/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__pret, { timeout: 60000 });
  const fournisseur = await page.evaluate(() => window.__ocrPret());
  console.log(`OCR prêt (${fournisseur}) — ${ids.length} cartes × ${TAILLES.length} tailles × ${FLOUS.length} flous\n`);
  let n = 0;
  for (const id of ids) {
    const carte = parId.get(id);
    const codes = carte[2].map((p) => p[1]).filter(Boolean);
    const code = codes[0];
    for (const taille of TAILLES) {
      for (const flou of FLOUS) {
        n += 1;
        const p = { graine: 3000 + n, taille, perspective: 0.06, rotation: 5, flou, bruit: 8, eclairage: 0.3, reflet: 0, fondTexture: false, parasite: false, retournee: false };
        const rendu = await page.evaluate(([u, c, p]) => window.__sceneCode(u, c, p), [`${origine}/full/${id}.jpg`, code, p]);
        const r = await page.evaluate(([b, c]) => window.__lireCode(b, c), [rendu.png, rendu.coins]);
        const lu = r.texte.replace(/\s+/g, '').toUpperCase();
        const exact = codes.some((c) => sansRegion(c) === sansRegion(lu)) || (lu.length >= 6 && codes.some((c) => sansRegion(lu).includes(sansRegion(c))));
        // Le plus proche parmi les codes de CETTE carte.
        let meilleur = null;
        for (const c of codes) {
          const s = codeSimilarity(sansRegion(lu), sansRegion(c));
          if (!meilleur || s > meilleur.s) meilleur = { c, s };
        }
        const restreint = meilleur && meilleur.s >= 70 && sansRegion(meilleur.c) === sansRegion(code);
        lignes.push({ id, taille, flou, code, lu, exact, restreint, similarite: meilleur?.s ?? 0, msOcr: r.msOcr });
        if (SP && !exact && n <= 30) {
          fs.mkdirSync(path.join(SP, 'code-echecs'), { recursive: true });
          fs.writeFileSync(path.join(SP, 'code-echecs', `${n}-${taille}-${flou}.png`), Buffer.from(r.bande, 'base64'));
        }
      }
    }
    process.stdout.write(`\r${n}/${ids.length * TAILLES.length * FLOUS.length}`);
  }
  process.stdout.write('\r');
  const pct = (l, f) => `${Math.round((100 * l.filter(f).length) / Math.max(1, l.length))} %`;
  console.log('taille de la carte (fraction de la hauteur de l’image) → code lu tel quel / lu par le plus proche des tirages de la carte');
  for (const t of TAILLES) {
    const s = lignes.filter((l) => l.taille === t);
    console.log(`  ${t}   ${pct(s, (l) => l.exact)} / ${pct(s, (l) => l.restreint)}   ` + FLOUS.map((f) => `flou ${f}: ${pct(s.filter((l) => l.flou === f), (l) => l.restreint)}`).join('  '));
  }
  const ms = lignes.map((l) => l.msOcr).sort((a, b) => a - b);
  console.log(`OCR par bande : ${ms[Math.floor(ms.length / 2)]} ms médian`);
  console.log('exemples : ' + lignes.slice(0, 6).map((l) => `${l.code}→« ${l.lu} »`).join(' ; '));
  if (SP) fs.writeFileSync(path.join(SP, 'code-bench.json'), JSON.stringify(lignes, null, 1));
} finally {
  await browser.close();
  await serveur.close();
}
