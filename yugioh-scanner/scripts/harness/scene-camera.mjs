/**
 * Caméra simulée pour la chaîne complète : une carte posée sur une table,
 * filmée par un téléphone qui bouge un peu.
 *
 * Rend un fichier MJPEG (des JPEG concaténés) que Chromium lit comme une
 * caméra (`--use-file-for-fake-video-capture`). Les images viennent du même
 * générateur que le banc (`scripts/harness/banc-art/banc-art.js`) : visuel
 * officiel, perspective, éclairage, grain.
 *
 *     SP=… ARTS=… ID=46986414 node scripts/harness/scene-camera.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const APP = path.resolve(import.meta.dirname, '../..');
const SP = process.env.SP;
const ARTS = process.env.ARTS;
const ID = Number(process.env.ID ?? 46986414);
const IMAGES = Number(process.env.IMAGES ?? 60);
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const serveur = await createServer({ root: APP, configFile: false, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await serveur.listen();
const origine = serveur.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage();
await page.route('**/arts/*.jpg', (route) =>
  route.fulfill({ path: path.join(ARTS, route.request().url().split('/').pop()), contentType: 'image/jpeg' }),
);
try {
  await page.goto(`${origine}/scripts/harness/banc-art/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__pret, { timeout: 60000 });
  const morceaux = [];
  for (let i = 0; i < IMAGES; i += 1) {
    // Une carte moyenne, presque de face, sous un éclairage un peu inégal ;
    // la graine change à chaque image, comme une main qui tremble.
    const rendu = await page.evaluate(
      ([u, p]) => window.__scene(u, p),
      [`${origine}/arts/${ID}.jpg`, { graine: 500 + i, taille: 0.55, perspective: 0.05, rotation: 6, flou: 0.5, bruit: 8, eclairage: 0.3, reflet: 0.2, fondTexture: false, parasite: false, retournee: false }],
    );
    morceaux.push(Buffer.from(rendu.png, 'base64'));
  }
  fs.writeFileSync(path.join(SP, 'sniper.mjpeg'), Buffer.concat(morceaux));
  fs.writeFileSync(path.join(SP, 'scene-0.jpg'), morceaux[0]);
  console.log(`${IMAGES} images de la carte ${ID} → ${path.join(SP, 'sniper.mjpeg')}`);
} finally {
  await browser.close();
  await serveur.close();
}
