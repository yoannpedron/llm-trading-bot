/**
 * Chaîne complète dans le navigateur : fausse caméra diffusant l'image du
 * viseur -> OCR -> résolution locale -> écran de résultat en deux zones.
 */
import { chromium, devices } from 'playwright';

const SP = process.env.SP;
const errors = [];

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${SP}/sniper.mjpeg`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const context = await browser.newContext({
  ...devices['iPhone 13'],
  permissions: ['camera'],
});
const page = await context.newPage();

const external = /fonts\.(googleapis|gstatic)|ERR_|Failed to load resource|net::/i;
const traces = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !external.test(m.text())) errors.push(m.text());
  if (m.text().startsWith('[viseur]')) traces.push(m.text());
});
page.on('pageerror', (e) => {
  if (!external.test(e.message)) errors.push(`${e.message}\n${(e.stack ?? '').split('\n').slice(0, 4).join('\n')}`);
});

const depart = Date.now();
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0, { timeout: 30000 });

// Le viseur peut verrouiller dès la première image, en moins d'une seconde :
// on n'attend pas un texte intermédiaire, on attend l'écran de résultat, et
// l'on note au passage si le viseur a été vu.
const viseurVu = await page
  .waitForSelector('text=/Montrez une carte|Aucune carte|Carte repérée|Carte reconnue|Téléchargement de l’index|Préparation de l’index/', { timeout: 3000 })
  .then(() => true)
  .catch(() => false);
const torche = await page.getByRole('button', { name: /torche/i }).count();

// La lecture aboutit : l'écran bascule sur les deux zones.
const found = await page
  .waitForSelector('.ygo-card', { timeout: 90000 })
  .then(() => true)
  .catch(() => false);
const verrou = (Date.now() - depart) / 1000;
console.log(`viseur vu avant le verrouillage : ${viseurVu ? 'oui' : 'non (verrouillé avant l’affichage)'}`);

if (found) {
  console.log(`verrouillage ${verrou.toFixed(1)} s après l'ouverture de la page (index compris)`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SP}/ui-resultat.png` });

  const code = await page.locator('section p.donnee').first().innerText();
  const nom = await page.locator('section h2').first().innerText();
  const rarete = await page.getByRole('button', { name: /Rare|Common|Secret/ }).count();
  const valider = await page.getByRole('button', { name: 'Enregistrer' }).count();
  const tier = await page.locator('.ygo-card').getAttribute('data-rarity');

  console.log(`viseur : bouton torche=${torche}`);
  console.log(`résultat : code="${code.trim()}" nom="${nom}" palier-holo=${tier}`);
  console.log(`commandes : ${rarete} bouton(s) de rareté, ${valider} bouton Enregistrer`);
} else {
  console.log(`viseur : bouton torche=${torche} — AUCUNE lecture aboutie`);
  const etat = await page.locator('p[aria-live]').first().innerText().catch(() => '?');
  console.log(`  ligne d'état : ${etat}`);
  await page.screenshot({ path: `${SP}/ui-echec.png` });
  await page.screenshot({ path: `${SP}/ui-echec.png` });
}

console.log(traces.slice(0, 12).map((t) => `  ${t}`).join('\n'));
console.log(errors.length ? `PREMIERE ERREUR :\n${errors[0]}` : 'aucune erreur console');
await browser.close();
