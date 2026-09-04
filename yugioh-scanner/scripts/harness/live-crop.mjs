import { chromium, devices } from 'playwright';

const SP = process.env.SP;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
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

await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=Placez le code ici', { timeout: 20000 });
await page.waitForTimeout(3000);
await page.addScriptTag({ path: `${SP}/harness-live.js` });

const out = await page.evaluate(async () => {
  const { ocr, preprocess, viewport } = window.YGO;
  const video = document.querySelector('video');
  const container = { width: video.clientWidth, height: video.clientHeight };
  const source = { width: video.videoWidth, height: video.videoHeight };

  const rect = viewport.toVideoRect(viewport.reticleRect(container), source, container);
  const still = preprocess.grabFrame(video);
  const variants = preprocess.cropVariants(still, rect, { scale: 2 });

  const lectures = [];
  for (const variant of variants.slice(0, 2)) {
    const r = await ocr.recognize('setCode', variant.canvas);
    lectures.push({
      variante: variant.label,
      texte: r.text.trim(),
      confiance: Math.round(r.confidence),
      taille: `${variant.canvas.width}x${variant.canvas.height}`,
      png: variant.canvas.toDataURL('image/png'),
    });
  }

  return { container, source, rect, lectures, brut: still.toDataURL('image/jpeg', 0.9) };
});

console.log('conteneur :', JSON.stringify(out.container));
console.log('flux      :', JSON.stringify(out.source));
console.log('recadrage :', JSON.stringify(out.rect));
import fs from 'node:fs';
fs.writeFileSync(`${SP}/live-brut.jpg`, Buffer.from(out.brut.split(',')[1], 'base64'));
for (const l of out.lectures) {
  const { png, ...reste } = l;
  fs.writeFileSync(`${SP}/live-${l.variante}.png`, Buffer.from(png.split(',')[1], 'base64'));
  console.log('  ', JSON.stringify(reste));
}

await browser.close();
