/**
 * Le mode série, de bout en bout dans le navigateur : la carte reconnue entre
 * au classeur sans écran, le bandeau le dit, « Annuler » la retire.
 *
 *     npx vite build && npx vite preview --port 4173 &
 *     SP=… node scripts/harness/ui-serie.mjs
 *
 * Caméra simulée : le fichier MJPEG de `scene-camera.mjs` (un « Dark Magician »
 * posé sur une table, 55 % de la hauteur : trop petit pour lire le code, donc
 * l'entrée est « à préciser »).
 */
import { chromium, devices } from 'playwright';

const SP = process.env.SP;
const PORT = process.env.PORT ?? '4173';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
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
const errors = [];
const traces = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !external.test(m.text())) errors.push(m.text());
  if (m.text().startsWith('[viseur]')) traces.push(m.text());
});
page.on('pageerror', (e) => !external.test(e.message) && errors.push(e.message));

const depart = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0, { timeout: 30000 });

const bouton = page.getByRole('button', { name: /Série : (oui|non)/ });
await bouton.waitFor({ timeout: 15000 });
console.log(`interrupteur : « ${(await bouton.innerText()).trim()} »`);

const bandeau = await page.waitForSelector('[data-ajout]', { timeout: 60000 }).then(() => true).catch(() => false);
console.log(`bandeau « ajouté » : ${bandeau ? 'oui' : 'NON'} (${((Date.now() - depart) / 1000).toFixed(1)} s après l'ouverture)`);
if (bandeau) {
  console.log(`  texte : ${(await page.locator('[data-ajout]').innerText()).replace(/\s+/g, ' ').trim()}`);
  console.log(`  ligne d'état : ${(await page.locator('p[aria-live]').first().innerText()).trim()}`);
  const resultat = await page.locator('.ygo-card').count();
  console.log(`  écran de résultat affiché : ${resultat ? 'oui (défaut)' : 'non (attendu)'}`);
  const entrees = await page.evaluate(() => JSON.parse(localStorage.getItem('ygo-scanner:collection:v1') ?? '[]'));
  console.log(`  inventaire : ${entrees.length} entrée(s) — ${entrees.map((e) => `${e.name} ${e.setCode} ×${e.count} ${e.tirageAPreciser ? 'à préciser' : 'précisée'}`).join(' ; ')}`);
  await page.screenshot({ path: `${SP}/ui-serie.png` });
  await page.getByRole('button', { name: 'Annuler' }).click();
  await page.waitForTimeout(500);
  const apres = await page.evaluate(() => JSON.parse(localStorage.getItem('ygo-scanner:collection:v1') ?? '[]'));
  console.log(`  après Annuler : ${apres.length} entrée(s)`);
  // La même carte reste devant l'objectif : pas de nouvel ajout avant 8 s.
  await page.waitForTimeout(3000);
  const rejoue = await page.evaluate(() => JSON.parse(localStorage.getItem('ygo-scanner:collection:v1') ?? '[]'));
  console.log(`  3 s plus tard, même carte devant l'objectif : ${rejoue.length} entrée(s) (0 attendu : anti-doublon)`);
}
console.log(traces.filter((t) => /tirage|passe/.test(t)).slice(0, 4).map((t) => `  ${t}`).join('\n'));
console.log(errors.length ? `PREMIERE ERREUR :\n${errors[0]}` : 'aucune erreur console');
await browser.close();
