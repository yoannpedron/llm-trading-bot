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
page.on('console', (m) => {
  if (m.type() === 'error' && !external.test(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => {
  if (!external.test(e.message)) errors.push(`${e.message}\n${(e.stack ?? '').split('\n').slice(0, 4).join('\n')}`);
});

await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0, { timeout: 30000 });

// Le viseur.
await page.waitForSelector('text=Placez le code ici', { timeout: 15000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${SP}/ui-viseur.png` });
const torche = await page.getByRole('button', { name: /torche/i }).count();

// La lecture aboutit : l'écran bascule sur les deux zones.
const found = await page
  .waitForSelector('.ygo-card', { timeout: 90000 })
  .then(() => true)
  .catch(() => false);

if (found) {
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SP}/ui-resultat.png` });

  const code = await page.locator('.font-mono').first().innerText();
  const nom = await page.locator('h2').first().innerText();
  const rarete = await page.getByRole('button', { name: /Rare|Common|Secret/ }).count();
  const valider = await page.getByRole('button', { name: 'Valider' }).count();
  const tier = await page.locator('.ygo-card').getAttribute('data-rarity');

  console.log(`viseur : bouton torche=${torche}`);
  console.log(`résultat : code="${code.trim()}" nom="${nom}" palier-holo=${tier}`);
  console.log(`commandes : ${rarete} bouton(s) de rareté, ${valider} bouton Valider`);
} else {
  console.log(`viseur : bouton torche=${torche} — AUCUNE lecture aboutie`);
  const lu = await page.locator('text=/« .* »/').count();
  console.log(`  texte OCR affiché : ${lu ? 'oui' : 'non'}`);
  await page.screenshot({ path: `${SP}/ui-echec.png` });
}

console.log(errors.length ? `PREMIERE ERREUR :\n${errors[0]}` : 'aucune erreur console');
await browser.close();
