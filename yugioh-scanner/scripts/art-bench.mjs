/**
 * Banc d'identification par illustration, sans carte physique.
 *
 * Des photos de téléphone SIMULÉES : le visuel officiel posé sur un fond, en
 * perspective, sous un éclairage inégal avec reflet, balance des blancs
 * décalée, flou de mise au point et grain. Chaque scène connaît ses vrais
 * coins et sa vraie carte. On mesure :
 *
 *   - la détection du quadrilatère (trouvé ? erreur de coin en px) ;
 *   - l'identification (bonne carte en tête ? marge sur la deuxième) ;
 *   - la borne haute : l'identification avec les VRAIS coins, qui sépare les
 *     échecs de détection des échecs d'appariement ;
 *   - le temps par étape.
 *
 * Un banc synthétique a déjà menti une fois sur ce projet : celui-ci ne
 * remplace pas des photos réelles, il dit seulement où chercher.
 *
 *     ARTS=/chemin/arts/small INDEX=public/art-index.bin node scripts/art-bench.mjs
 *     SCENES=200 GRAINE=7 ...
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const APP = path.resolve(import.meta.dirname, '..');
const ARTS = process.env.ARTS;
const INDEX = path.resolve(process.env.INDEX ?? path.join(APP, 'public/art-index.bin'));
const SCENES = Number(process.env.SCENES ?? 120);
const GRAINE = Number(process.env.GRAINE ?? 1);
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SP = process.env.SP;
const OPTIONS = JSON.parse(process.env.OPTIONS ?? '{}');

const { lireIndexArt } = await import(path.join(APP, 'src/lib/art.js'));
const octets = fs.readFileSync(INDEX);
const index = lireIndexArt(octets.buffer.slice(octets.byteOffset, octets.byteOffset + octets.byteLength));
const ids = Array.from(index.ids);

let g = GRAINE;
const alea = () => {
  g = (g * 1103515245 + 12345) % 2147483648;
  return g / 2147483648;
};
const choix = (liste) => liste[Math.floor(alea() * liste.length)];

/** Conditions : de la photo soignée à la photo bâclée. */
const CONDITIONS = {
  taille: [0.25, 0.4, 0.6, 0.8],
  perspective: [0, 0.08, 0.16, 0.25],
  rotation: [0, 8, 20, 45],
  flou: [0, 0.8, 1.6, 2.5],
  bruit: [0, 12, 24],
  eclairage: [0, 0.4, 0.8],
  reflet: [0, 0.35, 0.7],
};

const scenes = Array.from({ length: SCENES }, (_, i) => ({
  id: choix(ids),
  graine: GRAINE * 100000 + i,
  taille: choix(CONDITIONS.taille),
  perspective: choix(CONDITIONS.perspective),
  rotation: choix(CONDITIONS.rotation),
  flou: choix(CONDITIONS.flou),
  bruit: choix(CONDITIONS.bruit),
  eclairage: choix(CONDITIONS.eclairage),
  reflet: choix(CONDITIONS.reflet),
  fondTexture: alea() < 0.4,
  parasite: alea() < 0.4,
  retournee: alea() < 0.15,
}));

const serveur = await createServer({ root: APP, configFile: false, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await serveur.listen();
const origine = serveur.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('erreur page :', e.message));
await page.route('**/arts/*.jpg', (route) => {
  route.fulfill({ path: path.join(ARTS, route.request().url().split('/').pop()), contentType: 'image/jpeg' });
});

// Erreur de coin, au décalage cyclique près : une carte tournée d'un quart ou
// à l'envers a les mêmes coins dans un autre ordre.
const erreurCoins = (a, b) => Math.min(...[0, 1, 2, 3].map((d) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[(i + d) % 4].x, p.y - b[(i + d) % 4].y)))));

try {
  await page.goto(`${origine}/scripts/harness/banc-art/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__pret, { timeout: 60000 });
  const taille = await page.evaluate((o) => window.__chargerIndex(o), Array.from(octets));
  console.log(`index : ${taille} cartes — ${SCENES} scènes, graine ${GRAINE}\n`);

  const lignes = [];
  const debut = Date.now();
  for (const [n, scene] of scenes.entries()) {
    const rendu = await page.evaluate(([url, p]) => window.__scene(url, p), [`${origine}/arts/${scene.id}.jpg`, scene]);
    const r = await page.evaluate(([b, c, o]) => window.__identifier(b, c, o), [rendu.png, rendu.coins, OPTIONS]);
    const trouve = Boolean(r.quad);
    const erreur = trouve ? erreurCoins(rendu.coins, r.quad) : null;
    const bonne = r.candidats[0]?.id === scene.id;
    const dansTrois = (r.candidats ?? []).slice(0, 3).some((c) => c.id === scene.id);
    // Union des cartes en tête des trois meilleures hypothèses.
    const dansTroisHypotheses = (r.toutes ?? []).slice(0, 3).some((h) => h.id === scene.id) || bonne;
    const marge = r.candidats.length > 1 ? r.candidats[0].score - r.candidats[1].score : 0;
    const borne = r.borne?.[0]?.id === scene.id;
    // Parmi toutes les hypothèses : la plus proche de la vérité, et si elle
    // désignait la bonne carte. Sépare « la bonne n'était pas proposée » de
    // « elle l'était mais une autre a gagné ».
    const proches = (r.toutes ?? []).map((h) => ({ ...h, erreur: erreurCoins(rendu.coins, h.coins) }));
    const meilleureProche = proches.reduce((m, h) => (!m || h.erreur < m.erreur ? h : m), null);
    lignes.push({ ...scene, trouve, erreur, bonne, dansTrois, dansTroisHypotheses, marge, borne, hypothese: r.hypothese, trouveId: r.candidats[0]?.id ?? null, sens: r.sens,
      procheErreur: meilleureProche?.erreur ?? null, procheBonne: meilleureProche?.id === scene.id, procheScore: meilleureProche?.score ?? 0, score: r.candidats[0]?.score ?? 0, msQuad: r.msQuad, msTotal: r.msTotal });
    if (SP && (!bonne || !trouve) && n < 400) {
      fs.mkdirSync(path.join(SP, 'art-echecs'), { recursive: true });
      const dessin = await page.evaluate(([b, t, v]) => window.__dessiner(b, t, v), [rendu.png, r.quad, rendu.coins]);
      fs.writeFileSync(path.join(SP, 'art-echecs', `${n}-${scene.id}-${erreur === null ? 'x' : Math.round(erreur)}.jpg`), Buffer.from(dessin, 'base64'));
    }
    if (n % 20 === 19) process.stdout.write(`\r${n + 1}/${SCENES}  ${Math.round((Date.now() - debut) / 1000)} s`);
  }
  process.stdout.write('\r');

  const pct = (liste, f) => `${Math.round((100 * liste.filter(f).length) / Math.max(1, liste.length))} %`;
  const mediane = (v) => { const t = [...v].sort((a, b) => a - b); return t.length ? t[Math.floor(t.length / 2)] : NaN; };

  console.log('Global :');
  console.log(`  quadrilatère trouvé      ${pct(lignes, (l) => l.trouve)}   erreur de coin médiane ${Math.round(mediane(lignes.filter((l) => l.trouve).map((l) => l.erreur)))} px (scène 1080×1920)`);
  console.log(`  bonne carte en tête      ${pct(lignes, (l) => l.bonne)}   dans les 3 premières ${pct(lignes, (l) => l.dansTrois)}   en tête d'une des 3 meilleures hypothèses ${pct(lignes, (l) => l.dansTroisHypotheses)}`);
  console.log(`  bonne carte, vrais coins ${pct(lignes, (l) => l.borne)}   (borne haute de l'appariement)`);
  console.log(`  une hypothèse à <60 px    ${pct(lignes, (l) => l.procheErreur !== null && l.procheErreur < 60)}   dont bonne carte ${pct(lignes.filter((l) => l.procheErreur !== null && l.procheErreur < 60), (l) => l.procheBonne)}   perdue au classement ${lignes.filter((l) => l.procheBonne && !l.bonne).length}`);
  console.log(`  marge médiane (bonnes)   ${mediane(lignes.filter((l) => l.bonne).map((l) => l.marge)).toFixed(3)}   score médian ${mediane(lignes.filter((l) => l.bonne).map((l) => l.score)).toFixed(3)}`);
  const fausses = lignes.filter((l) => l.trouve && !l.bonne && l.candidats?.length);
  console.log(`  temps médian             quad ${mediane(lignes.map((l) => l.msQuad))} ms, total ${mediane(lignes.map((l) => l.msTotal))} ms`);

  // Seuil d'acceptation : quelle marge sépare bonnes et fausses en tête ?
  const margesFausses = lignes.filter((l) => l.trouve && !l.bonne).map((l) => l.marge);
  console.log(`  marge médiane des fausses en tête ${margesFausses.length ? mediane(margesFausses).toFixed(3) : '—'} (${margesFausses.length} cas)`);
  const hyp = {};
  for (const l of lignes) if (l.hypothese) hyp[l.hypothese] = (hyp[l.hypothese] ?? 0) + 1;
  console.log(`  hypothèse retenue        ${Object.entries(hyp).sort((a, b) => b[1] - a[1]).map(([h, n]) => `${h}×${n}`).join('  ')}`);

  console.log('\nPar condition (bonne carte en tête / quadrilatère trouvé) :');
  for (const [cle, valeurs] of Object.entries(CONDITIONS)) {
    const cases = valeurs.map((v) => {
      const sous = lignes.filter((l) => l[cle] === v);
      return `${v}: ${pct(sous, (l) => l.bonne)} / ${pct(sous, (l) => l.trouve)} (${sous.length})`;
    });
    console.log(`  ${cle.padEnd(12)} ${cases.join('   ')}`);
  }
  for (const cle of ['fondTexture', 'parasite', 'retournee']) {
    const oui = lignes.filter((l) => l[cle]);
    const non = lignes.filter((l) => !l[cle]);
    console.log(`  ${cle.padEnd(12)} oui: ${pct(oui, (l) => l.bonne)} / ${pct(oui, (l) => l.trouve)} (${oui.length})   non: ${pct(non, (l) => l.bonne)} / ${pct(non, (l) => l.trouve)} (${non.length})`);
  }
  if (SP) fs.writeFileSync(path.join(SP, 'art-bench.json'), JSON.stringify(lignes, null, 1));
} finally {
  await browser.close();
  await serveur.close();
}
