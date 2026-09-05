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
 * Trois familles de scènes, parce qu'un scanner qui affiche une MAUVAISE carte
 * est pire qu'un scanner qui n'affiche rien :
 *
 *   - « connue »    : une carte de l'index (SCENES scènes) — mesure le rappel et
 *                     les fausses cartes en tête ;
 *   - « inconnue »  : une carte réelle MASQUÉE de l'index (INCONNUES passcodes,
 *                     graine fixe) — ce que la chaîne rend d'une carte qu'elle
 *                     ne peut pas connaître ;
 *   - « sansCarte » : un fond et un ou deux parasites, pas de carte (SANS_CARTE
 *                     scènes) — ce qu'elle invente sur une table.
 *
 * Chaque scène a un DOUBLON (même carte, autre graine : autre position, autre
 * bruit), pour juger la politique « deux images d'accord » de `VoteArt`. À la
 * fin, une grille de politiques d'acceptation (score ≥ S, marge ≥ M) donne le
 * rappel et les faux positifs de chaque famille, puis la politique en vigueur.
 *
 * Un banc synthétique a déjà menti une fois sur ce projet : celui-ci ne
 * remplace pas des photos réelles, il dit seulement où chercher.
 *
 *     ARTS=/chemin/arts/small INDEX=public/art-index.bin node scripts/art-bench.mjs
 *     SCENES=200 INCONNUES=60 SANS_CARTE=40 GRAINE=7 ...
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const APP = path.resolve(import.meta.dirname, '..');
const ARTS = process.env.ARTS;
const INDEX = path.resolve(process.env.INDEX ?? path.join(APP, 'public/art-index.bin'));
const SCENES = Number(process.env.SCENES ?? 120);
const INCONNUES = Number(process.env.INCONNUES ?? 60);
const SANS_CARTE = Number(process.env.SANS_CARTE ?? 40);
const GRAINE = Number(process.env.GRAINE ?? 1);
// Les cartes masquées de l'index ne dépendent pas de GRAINE : la même mesure
// « inconnue » d'un lancement à l'autre.
const GRAINE_INCONNUES = 7;
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SP = process.env.SP;
const OPTIONS = JSON.parse(process.env.OPTIONS ?? '{}');

const { lireIndexArt } = await import(path.join(APP, 'src/lib/art.js'));
const { SCORE_MINIMAL, VoteArt } = await import(path.join(APP, 'src/lib/verdictArt.js'));
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

// L'ordre des tirages est celui d'origine : les SCENES scènes « connues »
// d'une graine donnée sont les mêmes qu'avant l'ajout des familles négatives.
const conditions = () => ({
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
});
const connues = Array.from({ length: SCENES }, (_, i) => ({ famille: 'connue', id: choix(ids), graine: GRAINE * 100000 + i, ...conditions() }));

// Les cartes inconnues : tirées à graine fixe, hors des cartes des scènes
// connues, sans doublon (l'index porte deux cadrages par carte).
g = GRAINE_INCONNUES;
const idsConnus = new Set(connues.map((s) => s.id));
const inconnus = [];
while (inconnus.length < INCONNUES) {
  const id = choix(ids);
  if (!idsConnus.has(id) && !inconnus.includes(id)) inconnus.push(id);
}
const inconnues = inconnus.map((id, i) => ({ famille: 'inconnue', id, graine: GRAINE * 100000 + SCENES + i, ...conditions() }));
const sansCarte = Array.from({ length: SANS_CARTE }, (_, i) => ({
  famille: 'sansCarte', id: null, graine: GRAINE * 100000 + SCENES + INCONNUES + i, ...conditions(), sansCarte: true, parasite: false, retournee: false, parasites: 1 + (alea() < 0.5 ? 1 : 0),
}));
const scenes = [...connues, ...inconnues, ...sansCarte];
// Le doublon : même carte, mêmes conditions, autre graine (position, bruit,
// fond, reflet, parasites changent). La graine reste hors de celles des scènes.
const doublon = (scene, i) => ({ ...scene, graine: GRAINE * 100000 + 50000 + i });

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
  const chargement = await page.evaluate(([o, masque]) => window.__chargerIndex(o, masque), [Array.from(octets), inconnus]);
  console.log(`index : ${chargement.taille} entrées, ${chargement.masquees} masquées (${inconnus.length} cartes inconnues) — ${SCENES} connues + ${INCONNUES} inconnues + ${SANS_CARTE} sans carte, chacune en double, graine ${GRAINE}\n`);

  /** Une scène rendue puis identifiée : ce que la politique d'acceptation verra. */
  const passe = async (scene) => {
    const rendu = await page.evaluate(([url, p]) => window.__scene(url, p), [scene.id === null ? '' : `${origine}/arts/${scene.id}.jpg`, scene]);
    const r = await page.evaluate(([b, c, o]) => window.__identifier(b, c, o), [rendu.png, rendu.coins, OPTIONS]);
    const marge = r.candidats.length > 1 ? r.candidats[0].score - r.candidats[1].score : 0;
    return { rendu, r, trouve: Boolean(r.quad), trouveId: r.candidats[0]?.id ?? null, score: r.candidats[0]?.score ?? 0, marge, candidats: r.candidats.slice(0, 3) };
  };

  let lignes = [];
  const debut = Date.now();
  for (const [n, scene] of scenes.entries()) {
    const { rendu, r, trouve, trouveId, score, marge, candidats } = await passe(scene);
    const seconde = await passe(doublon(scene, n));
    const bis = { graine: doublon(scene, n).graine, trouve: seconde.trouve, trouveId: seconde.trouveId, score: seconde.score, marge: seconde.marge, candidats: seconde.candidats };
    const erreur = trouve && rendu.coins ? erreurCoins(rendu.coins, r.quad) : null;
    const bonne = scene.id !== null && r.candidats[0]?.id === scene.id;
    const dansTrois = (r.candidats ?? []).slice(0, 3).some((c) => c.id === scene.id);
    // Union des cartes en tête des trois meilleures hypothèses.
    const dansTroisHypotheses = (r.toutes ?? []).slice(0, 3).some((h) => h.id === scene.id) || bonne;
    const borne = scene.id !== null && r.borne?.[0]?.id === scene.id;
    // Parmi toutes les hypothèses : la plus proche de la vérité, et si elle
    // désignait la bonne carte. Sépare « la bonne n'était pas proposée » de
    // « elle l'était mais une autre a gagné ».
    const proches = rendu.coins ? (r.toutes ?? []).map((h) => ({ ...h, erreur: erreurCoins(rendu.coins, h.coins) })) : [];
    const meilleureProche = proches.reduce((m, h) => (!m || h.erreur < m.erreur ? h : m), null);
    lignes.push({ ...scene, idVrai: scene.id, trouve, erreur, bonne, dansTrois, dansTroisHypotheses, marge, borne, hypothese: r.hypothese, trouveId, sens: r.sens,
      procheErreur: meilleureProche?.erreur ?? null, procheBonne: meilleureProche?.id === scene.id, procheScore: meilleureProche?.score ?? 0, score, candidats, bis, msQuad: r.msQuad, msTotal: r.msTotal, ms: r.ms, evaluees: r.evaluees });
    // Pour l'œil : les échecs des scènes connues, et les scènes négatives où
    // une carte passe le score minimal (de possibles faux positifs).
    const suspect = scene.famille !== 'connue' && score >= SCORE_MINIMAL;
    if (SP && ((scene.famille === 'connue' && (!bonne || !trouve)) || suspect) && n < 400) {
      fs.mkdirSync(path.join(SP, 'art-echecs'), { recursive: true });
      const dessin = await page.evaluate(([b, t, v]) => window.__dessiner(b, t, v), [rendu.png, r.quad, rendu.coins]);
      const nom = scene.famille === 'connue' ? `${n}-${scene.id}-${erreur === null ? 'x' : Math.round(erreur)}` : `${scene.famille}-${n}-${scene.id ?? 'aucune'}-${trouveId}-${score.toFixed(2)}`;
      fs.writeFileSync(path.join(SP, 'art-echecs', `${nom}.jpg`), Buffer.from(dessin, 'base64'));
    }
    if (n % 20 === 19) process.stdout.write(`\r${n + 1}/${scenes.length}  ${Math.round((Date.now() - debut) / 1000)} s`);
  }
  process.stdout.write('\r');
  // Les rapports qui suivent portent sur les scènes connues, comme avant.
  const toutesLignes = lignes;
  const negatives = { inconnue: toutesLignes.filter((l) => l.famille === 'inconnue'), sansCarte: toutesLignes.filter((l) => l.famille === 'sansCarte') };
  lignes = toutesLignes.filter((l) => l.famille === 'connue');

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
  const etapes = ['quad', 'gradient', 'hough', 'candidats', 'tri', 'nbCandidats', 'gris', 'etage1', 'zoom', 'etage2'];
  console.log(`  par étape (médiane)      ${etapes.map((e) => `${e} ${mediane(lignes.map((l) => l.ms?.[e] ?? 0))}`).join(', ')}   évaluées ${mediane(lignes.map((l) => l.evaluees ?? 0))}`);

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

  /* --- Faux positifs : quelle politique d'acceptation ? ------------------ */

  // Une politique rend l'id accepté, ou null. Immédiate : sur la première
  // image seule. Deux images : les deux passes rendent le même id, chacune au
  // moins au score minimal (ce que fait VoteArt entre 0,70 et 0,85). Actuelle :
  // VoteArt telle qu'elle est, nourrie des deux passes dans l'ordre.
  const immediate = (S, M) => (l) => (l.trouveId !== null && l.score >= S && l.marge >= M ? l.trouveId : null);
  const deuxImages = (l) => (l.trouveId !== null && l.trouveId === l.bis.trouveId && l.score >= SCORE_MINIMAL && l.bis.score >= SCORE_MINIMAL ? l.trouveId : null);
  const actuelle = (l) => {
    const vote = new VoteArt();
    const premiere = vote.cast(l.candidats);
    if (premiere.accepted) return premiere.id;
    const seconde = vote.cast(l.bis.candidats);
    return seconde.accepted ? seconde.id : null;
  };
  const taux = (liste, f) => Math.round((1000 * liste.filter(f).length) / Math.max(1, liste.length)) / 10;
  const evaluer = (politique, decision) => ({
    politique,
    rappel: taux(lignes, (l) => decision(l) === l.idVrai),
    fauxConnues: taux(lignes, (l) => { const d = decision(l); return d !== null && d !== l.idVrai; }),
    fauxInconnues: taux(negatives.inconnue, (l) => decision(l) !== null),
    fauxSansCarte: taux(negatives.sansCarte, (l) => decision(l) !== null),
  });
  const politiques = [];
  for (const S of [0.7, 0.75, 0.8, 0.85, 0.9]) for (const M of [0.02, 0.05, 0.08, 0.12]) politiques.push(evaluer(`immédiat score ≥ ${S.toFixed(2)}, marge ≥ ${M.toFixed(2)}`, immediate(S, M)));
  politiques.push(evaluer(`deux images d'accord, score ≥ ${SCORE_MINIMAL.toFixed(2)}`, deuxImages));
  const politiqueActuelle = evaluer('actuelle (VoteArt : immédiat 0,85/0,05, sinon deux images ≥ 0,70)', actuelle);

  console.log(`\nPolitiques d'acceptation (connues ${lignes.length}, inconnues ${negatives.inconnue.length}, sans carte ${negatives.sansCarte.length}) :`);
  console.log(`  ${'politique'.padEnd(46)} rappel   faux connues   faux inconnues   faux sans carte`);
  for (const p of [...politiques, politiqueActuelle]) {
    console.log(`  ${p.politique.padEnd(46)} ${String(p.rappel).padStart(5)} %  ${String(p.fauxConnues).padStart(9)} %  ${String(p.fauxInconnues).padStart(12)} %  ${String(p.fauxSansCarte).padStart(13)} %`);
  }
  const scoresNegatifs = (liste) => liste.map((l) => l.score).sort((a, b) => b - a).slice(0, 5).map((v) => v.toFixed(2)).join(' ');
  console.log(`  contour trouvé : inconnues ${pct(negatives.inconnue, (l) => l.trouve)}, sans carte ${pct(negatives.sansCarte, (l) => l.trouve)}`);
  console.log(`  cinq meilleurs scores : inconnues ${scoresNegatifs(negatives.inconnue)} — sans carte ${scoresNegatifs(negatives.sansCarte)}`);

  if (SP) {
    fs.writeFileSync(path.join(SP, 'art-bench.json'), JSON.stringify(toutesLignes, null, 1));
    fs.writeFileSync(path.join(SP, 'art-politiques.json'), JSON.stringify({ politiques, politiqueActuelle }, null, 1));
  }
} finally {
  await browser.close();
  await serveur.close();
}
