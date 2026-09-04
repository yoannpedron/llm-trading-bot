/**
 * Le viseur lit **plus d'une fois**.
 *
 * Ce script existe pour une panne précise, restée invisible pendant toute la
 * vie du projet : `<SniperView>` est démonté puis remonté à chaque aller-retour
 * — onglet Inventaire, écran de résultat, « Ce n’est pas ma carte ». React fabrique
 * alors un nouvel élément `<video>` vide, alors que l'effet qui ouvre la caméra
 * ne se rejoue pas. Le flux restait attaché au premier élément, détruit depuis.
 *
 * Mesuré avant correction : après un simple aller-retour vers l'Inventaire,
 * `srcObject` absent, `videoWidth` à zéro, vidéo en pause, et **plus aucune
 * lecture n'aboutissait** — sans message, sans erreur console. Le scanner ne
 * marchait qu'une fois par chargement de page.
 *
 * `ui-e2e.mjs` ne pouvait pas le voir : il ne scanne qu'une carte. D'où ce
 * second script, qui scanne deux fois de suite en passant par les deux chemins
 * de démontage.
 *
 *     SP=/tmp/ygo node scripts/harness/scan-twice.mjs
 *
 * Suppose l'application bâtie et servie — voir « Test navigateur hors ligne »
 * dans scripts/README.md.
 */
import { chromium, devices } from 'playwright';

const SP = process.env.SP ?? '/tmp';
const URL = process.env.URL ?? 'http://127.0.0.1:4173/';
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ATTENTE = 90000;

const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${SP}/sniper.mjpeg`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({ ...devices['iPhone 13'], permissions: ['camera'] });
const page = await context.newPage();

/** État du flux, tel que le navigateur le voit. */
const flux = () =>
  page.evaluate(() => {
    const video = document.querySelector('video');
    if (!video) return { present: false };
    return {
      present: true,
      largeur: video.videoWidth,
      attache: Boolean(video.srcObject),
      enPause: video.paused,
    };
  });

const verrouille = () =>
  page
    .waitForSelector('.ygo-card', { timeout: ATTENTE })
    .then(() => true)
    .catch(() => false);

const etapes = [];
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0, { timeout: 30000 });
console.log('démarrage            ', JSON.stringify(await flux()));

// 1. Aller-retour par l'onglet Inventaire, sans avoir rien scanné : c'est le
//    chemin le plus court vers la panne.
await page.getByRole('button', { name: /^Inventaire/ }).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: /^Scanner$/ }).click();
await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0, { timeout: 15000 });
console.log('après l’Inventaire   ', JSON.stringify(await flux()));

const premier = await verrouille();
console.log(`première lecture      ${premier ? 'aboutie' : 'ÉCHOUÉE'}`);
etapes.push(premier);

// 2. Retour depuis l'écran de résultat : second chemin de démontage.
await page.getByRole('button', { name: /n’est pas ma carte/i }).click();
await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0, { timeout: 15000 });
console.log('après un résultat    ', JSON.stringify(await flux()));

const second = await verrouille();
console.log(`seconde lecture       ${second ? 'aboutie' : 'ÉCHOUÉE'}`);
etapes.push(second);

await page.screenshot({ path: `${SP}/scan-twice.png` });
await browser.close();

const ok = etapes.every(Boolean);
console.log(`\n${ok ? 'le viseur lit deux fois de suite' : 'RÉGRESSION : le viseur ne lit qu’une fois'}`);
process.exitCode = ok ? 0 : 1;
