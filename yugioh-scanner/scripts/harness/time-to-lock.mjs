/**
 * Combien de temps le viseur met à identifier une carte.
 *
 * C'est la mesure qui compte pour l'utilisateur : pas le coût d'une
 * binarisation, mais le délai entre le moment où il cadre et celui où la carte
 * s'affiche. Le banc `ocr-bench.mjs` explique *pourquoi* c'est lent ; celui-ci
 * dit *combien*.
 *
 * Le protocole est le même que `ui-e2e.mjs` : caméra simulée par un fichier
 * MJPEG, application réellement bâtie et servie. On répète, parce qu'une seule
 * prise dépend de l'instant où la boucle démarre par rapport à l'image.
 *
 *     SP=/tmp/ygo node scripts/harness/time-to-lock.mjs
 */
import { chromium, devices } from 'playwright';

const SP = process.env.SP ?? '/tmp';
const URL = process.env.URL ?? 'http://127.0.0.1:4173/';
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PRISES = Number(process.env.PRISES ?? 5);
const PLAFOND = 60000;

const mesures = [];
for (let prise = 0; prise < PRISES; prise += 1) {
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${SP}/sniper.mjpeg`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await (
    await browser.newContext({ ...devices['iPhone 13'], permissions: ['camera'] })
  ).newPage();

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0, {
    timeout: 30000,
  });
  // On attend que le moteur soit chargé : sinon on mesure un téléchargement.
  await page
    .waitForFunction(() => !/moteur de lecture/.test(document.body.innerText), {
      timeout: 60000,
    })
    .catch(() => {});

  const depart = Date.now();
  const trouve = await page
    .waitForSelector('.ygo-card', { timeout: PLAFOND })
    .then(() => true)
    .catch(() => false);
  const duree = Date.now() - depart;

  const dimensions = await page.evaluate(() => {
    const v = document.querySelector('video');
    return v ? `${v.videoWidth}×${v.videoHeight}` : 'sans vidéo';
  });

  console.log(
    `prise ${prise + 1}/${PRISES}  ${trouve ? `${(duree / 1000).toFixed(2)} s` : 'ÉCHEC'}  (flux ${dimensions})`,
  );
  if (trouve) mesures.push(duree);
  await browser.close();
}

if (mesures.length === 0) {
  console.log('\nAUCUNE lecture n’a abouti.');
  process.exitCode = 1;
} else {
  const tri = [...mesures].sort((a, b) => a - b);
  const mediane = tri[Math.floor(tri.length / 2)];
  const moyenne = mesures.reduce((s, v) => s + v, 0) / mesures.length;
  console.log(
    `\n${mesures.length}/${PRISES} abouties — médiane ${(mediane / 1000).toFixed(2)} s, ` +
      `moyenne ${(moyenne / 1000).toFixed(2)} s, ` +
      `étendue ${(tri[0] / 1000).toFixed(2)}–${(tri[tri.length - 1] / 1000).toFixed(2)} s`,
  );
}
