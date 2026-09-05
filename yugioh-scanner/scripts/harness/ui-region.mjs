/**
 * Le choix de la langue des cartes, dans le navigateur.
 *
 * Fausse caméra diffusant l'image du viseur -> identification par
 * l'illustration -> écran de résultat. On vérifie, en lisant le DOM et non en
 * regardant une capture :
 *  - le viseur montre « Région : FR » et le réglage « Langue de vos cartes » ;
 *  - la liste des tirages est en français par défaut, sa région en tête ;
 *  - changer la langue sur l'écran de résultat change les codes de la liste
 *    et le code retenu, et enregistre le code dans cette langue ;
 *  - la préférence survit à un rechargement.
 *
 *   npx vite build && npx vite preview --port 4180 &
 *   SP=$SP PORT=4180 node scripts/harness/ui-region.mjs
 *
 * Écrit `$SP/region.png` (écran de résultat après changement de langue) et
 * `$SP/region-viseur.png` (le réglage ouvert dans le viseur).
 */
import { chromium, devices } from 'playwright';

const SP = process.env.SP;
const PORT = process.env.PORT ?? '4180';
const URL = `http://127.0.0.1:${PORT}/`;
const errors = [];
const constats = [];
let echecs = 0;

const dire = (texte) => {
  constats.push(texte);
  console.log(texte);
};
const verifier = (condition, texte) => {
  if (!condition) echecs += 1;
  dire(`${condition ? 'OK ' : 'KO '} ${texte}`);
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${SP}/sniper.mjpeg`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const context = await browser.newContext({ ...devices['iPhone 13'], permissions: ['camera'] });
const page = await context.newPage();

const external = /fonts\.(googleapis|gstatic)|ERR_|Failed to load resource|net::/i;
page.on('console', (m) => {
  if (m.type() === 'error' && !external.test(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => {
  if (!external.test(e.message)) errors.push(`${e.message}\n${(e.stack ?? '').split('\n').slice(0, 4).join('\n')}`);
});

/** Codes de la liste des tirages, dans l'ordre affiché. */
const codesAffiches = () => page.locator('[data-tirages] [data-set-code]').evaluateAll((els) => els.map((e) => e.dataset.setCode));
const codeRetenu = () => page.locator('p[data-code]').first().getAttribute('data-code');
const attendreResultat = () => page.waitForSelector('[data-tirages]', { timeout: 90000 });
const regionDe = (code) => /^[A-Z0-9]+-([A-Z]{2})[A-Z]{0,2}\d/.exec(code)?.[1] ?? /^[A-Z0-9]+-([A-Z])\d/.exec(code)?.[1] ?? '';

/* --- 1. Le viseur, avant le verrouillage ---------------------------------- */

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0, { timeout: 30000 });

const boutonRegion = page.getByRole('button', { name: /^Région/ });
const texteBouton = await boutonRegion.innerText({ timeout: 5000 }).catch(() => null);
verifier(texteBouton?.replace(/\s+/g, ' ') === 'Région : FR', `viseur : bouton « ${texteBouton} » (attendu « Région : FR »)`);

if (texteBouton) {
  await boutonRegion.click();
  // `textContent`, pas `innerText` : l'intitulé est rendu en capitales par le CSS.
  const intitule = await page.locator('label[for="choix-region-viseur"]').textContent({ timeout: 3000 }).catch(() => null);
  verifier(intitule === 'Langue de vos cartes', `viseur : intitulé du réglage « ${intitule} »`);
  const options = await page.locator('#choix-region-viseur option').evaluateAll((els) => els.map((e) => `${e.value}=${e.textContent}`));
  verifier(options.length === 11 && options[0].startsWith('FR=') && options[1].includes('Danemark'), `viseur : ${options.length} régions, première « ${options[0]} », deuxième « ${options[1]} »`);
  await page.screenshot({ path: `${SP}/region-viseur.png` });
  // On ne referme pas le réglage : le viseur verrouille souvent avant, et
  // l'écran de résultat a remplacé le bouton.
}

/* --- 2. L'écran de résultat, en français --------------------------------- */

await attendreResultat();
await page.waitForTimeout(500);
const nom = await page.locator('section h2').first().innerText();
const codesFr = await codesAffiches();
const regionsFr = codesFr.map(regionDe);
const enTeteFr = regionsFr.findIndex((r) => r !== 'FR' && r !== 'F');
verifier(codesFr.length > 0 && regionsFr.every((r) => ['FR', 'F', ''].includes(r)), `résultat « ${nom} » : ${codesFr.length} tirages, régions {${[...new Set(regionsFr)].join(', ')}}`);
verifier(enTeteFr === -1 || regionsFr.slice(enTeteFr).every((r) => r === ''), `français en tête : ${codesFr.slice(0, 4).join(', ')} … ${codesFr.slice(-2).join(', ')}`);
verifier((await codeRetenu()) === '', 'code retenu vide tant qu’aucun tirage n’est choisi');
const selectFiche = page.locator('#choix-region-fiche');
verifier((await selectFiche.inputValue()) === 'FR', 'le sélecteur de la fiche est sur FR');
await page.screenshot({ path: `${SP}/region-fr.png` });

/* --- 3. Changement de langue sur l'écran de résultat ----------------------- */

await selectFiche.selectOption('DE');
await page.waitForTimeout(300);
const codesDe = await codesAffiches();
const regionsDe = codesDe.map(regionDe);
verifier(codesDe.length === codesFr.length && regionsDe.every((r) => ['DE', 'G', ''].includes(r)), `après DE : ${codesDe.length} tirages, régions {${[...new Set(regionsDe)].join(', ')}}, premiers ${codesDe.slice(0, 3).join(', ')}`);
verifier(codesDe.every((code, i) => code === codesFr[i].replace(/-FR/, '-DE').replace(/^([A-Z0-9]+)-F(\d)/, '$1-G$2')), 'chaque code DE est le code FR avec la région substituée, dans le même ordre');
const stocke = await page.evaluate(() => localStorage.getItem('ygo.region'));
verifier(stocke === 'DE', `localStorage ygo.region = ${stocke}`);
await page.screenshot({ path: `${SP}/region.png` });

/* --- 4. Choix d'un tirage, enregistrement ------------------------------------ */

const premier = codesDe[0];
await page.locator('[data-tirages] button').first().click();
await page.waitForTimeout(300);
verifier((await codeRetenu()) === premier, `tirage choisi : code retenu « ${await codeRetenu()} » (attendu « ${premier} »)`);
await page.getByRole('button', { name: 'Enregistrer' }).click();
await page.waitForTimeout(300);
const inventaire = await page.evaluate(() => JSON.parse(localStorage.getItem('ygo-scanner:collection:v1') ?? '[]'));
verifier(inventaire.length === 1 && inventaire[0].setCode === premier, `inventaire : ${inventaire.length} entrée, code « ${inventaire[0]?.setCode} »`);

/* --- 5. Rechargement : la préférence survit ---------------------------------- */

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0, { timeout: 30000 });
const texteApres = await page.getByRole('button', { name: /^Région/ }).innerText({ timeout: 3000 }).catch(() => null);
dire(`après rechargement, viseur : bouton « ${texteApres ?? 'non vu (verrouillé avant)'} »`);
await attendreResultat();
await page.waitForTimeout(500);
const codesApres = await codesAffiches();
verifier((await page.locator('#choix-region-fiche').inputValue()) === 'DE', 'après rechargement : le sélecteur est sur DE');
verifier(codesApres.join() === codesDe.join(), `après rechargement : ${codesApres.length} tirages, premiers ${codesApres.slice(0, 3).join(', ')}`);

console.log(errors.length ? `PREMIERE ERREUR :\n${errors[0]}` : 'aucune erreur console');
console.log(echecs ? `${echecs} vérification(s) en échec` : 'toutes les vérifications passent');
await browser.close();
process.exit(echecs ? 1 : 0);
