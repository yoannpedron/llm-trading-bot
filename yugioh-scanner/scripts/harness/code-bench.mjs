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
const TAILLES = (process.env.TAILLES ?? '0.45,0.5,0.6,0.7,0.8,0.9').split(',').map(Number);
const FLOUS = (process.env.FLOUS ?? '0,0.8,1.6').split(',').map(Number);
/** Options passées à lireTirage (bande, hauteurBande, contraste), pour comparer des variantes. */
const OPTIONS = JSON.parse(process.env.OPTIONS ?? '{}');
/** Scène de nuit : luminosité de l'image entière (1 = jour), grain du capteur, dominante chaude. */
const LUMINOSITE = Number(process.env.LUMINOSITE ?? 1);
const BRUIT = Number(process.env.BRUIT ?? 8);
const CHALEUR = Number(process.env.CHALEUR ?? 0);

const { ConcordanceTirage } = await import(path.join(APP, 'src/lib/tirage.js'));
const index = JSON.parse(fs.readFileSync(path.join(APP, 'public/card-index.json'), 'utf8'));
const parId = new Map(index.cards.map((c) => [c[0], c]));
const ids = fs.readFileSync(path.join(FULL, 'ids.txt'), 'utf8').trim().split(/\s+/).map(Number).filter((id) => fs.existsSync(path.join(FULL, `${id}.jpg`)));
const sansRegion = (code) => String(code ?? '').toUpperCase().replace(/^([A-Z0-9]+)-[A-Z]{1,2}(?=[A-Z]?\d)/, '$1-');

const serveur = await createServer({ root: APP, configFile: false, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false, watch: { ignored: ['**'] } } });
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
  const sets = index.sets;
  const rarities = index.rarities;
  for (const id of ids) {
    const carte = parId.get(id);
    const printings = carte[2].map(([si, code, ri]) => ({ setName: sets[si], setCode: code, rarity: rarities[ri] }));
    const code = printings[0].setCode;
    for (const taille of TAILLES) {
      for (const flou of FLOUS) {
        n += 1;
        // Deux images de la même carte (graines différentes) : la règle de
        // l'application — exact tout de suite, sinon deux lectures d'accord.
        const concordance = new ConcordanceTirage();
        const lectures = [];
        let retenu = null;
        let premiereImage = false;
        for (const bis of [0, 1]) {
          const p = { graine: 3000 + n * 2 + bis, taille, perspective: 0.06, rotation: 5, flou, bruit: BRUIT, eclairage: 0.3, reflet: 0, fondTexture: false, parasite: false, retournee: false, luminosite: LUMINOSITE, chaleur: CHALEUR };
          const rendu = await page.evaluate(([u, c, p]) => window.__sceneCode(u, c, p), [`${origine}/full/${id}.jpg`, code, p]);
          const r = await page.evaluate(([b, c, pr, o]) => window.__lireTirageApp(b, c, pr, o), [rendu.png, rendu.coins, printings, OPTIONS]);
          lectures.push(r);
          if (!retenu && r.tirage) {
            const decision = concordance.ajouter({ tirage: { setCode: r.tirage }, exact: r.exact, net: r.net, ambigu: r.ambigu, similarite: r.similarite });
            if (decision) {
              retenu = decision.setCode;
              premiereImage = bis === 0;
            }
          }
        }
        const juste = retenu !== null && sansRegion(retenu) === sansRegion(code);
        lignes.push({ id, taille, flou, code, lectures: lectures.map((l) => l.lecture), bruts: lectures.map((l) => l.brut ?? ''), tirages: lectures.map((l) => l.tirage ?? null), exacts: lectures.map((l) => Boolean(l.exact)), printings: printings.map((p) => p.setCode), retenu, juste, faux: retenu !== null && !juste, exact: lectures.some((l) => l.exact), premiereImage: premiereImage && juste, msOcr: lectures[0].msOcr ?? 0 });
        if (SP && !juste && n <= 40) {
          fs.mkdirSync(path.join(SP, 'code-echecs'), { recursive: true });
          fs.writeFileSync(path.join(SP, 'code-echecs', `${n}-${taille}-${flou}.txt`), `${code}\n${lectures.map((l) => `${l.lecture} sim ${l.similarite} ${l.raison ?? ''}`).join('\n')}\n`);
        }
      }
    }
    process.stdout.write(`\r${n}/${ids.length * TAILLES.length * FLOUS.length}`);
  }
  process.stdout.write('\r');
  const pct = (l, f) => `${Math.round((100 * l.filter(f).length) / Math.max(1, l.length))} %`;
  console.log(`options : ${JSON.stringify(OPTIONS)}${LUMINOSITE !== 1 ? ` — nuit : luminosité ${LUMINOSITE}, grain ${BRUIT}, chaleur ${CHALEUR}` : ''} — règle : exacte ou nette tout de suite, sinon deux lectures d'accord (deux images par cas)`);
  console.log('taille → tirage retenu juste / FAUX retenu / au moins une lecture exacte / retenu dès la première image');
  for (const t of TAILLES) {
    const s = lignes.filter((l) => l.taille === t);
    console.log(`  ${String(t).padEnd(5)} ${pct(s, (l) => l.juste).padStart(5)} / ${pct(s, (l) => l.faux).padStart(5)} / ${pct(s, (l) => l.exact).padStart(5)} / ${pct(s, (l) => l.premiereImage).padStart(5)}   ` + FLOUS.map((f) => `flou ${f}: ${pct(s.filter((l) => l.flou === f), (l) => l.juste)}`).join('  '));
  }
  console.log(`  total ${pct(lignes, (l) => l.juste)} justes, ${lignes.filter((l) => l.faux).length} faux sur ${lignes.length}`);
  console.log('exemples : ' + lignes.slice(0, 4).map((l) => `${l.code}→« ${l.lectures.join(' | ')} »`).join(' ; '));
  if (SP) fs.writeFileSync(path.join(SP, 'code-bench.json'), JSON.stringify(lignes, null, 1));
} finally {
  await browser.close();
  await serveur.close();
}
