/**
 * Simule ce que voit le viseur « sniper » : le téléphone braqué de près sur le
 * code d'extension, zoom optique engagé. On dessine la carte à l'échelle qu'elle
 * aurait dans ce cadrage, on dégrade l'image comme une vraie prise de vue, puis
 * on extrait la fenêtre de visée avec le VRAI code de l'application.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const SP = process.env.SP;
const CARD = fs.readFileSync(`${SP}/beb.jpg`).toString('base64');
const SET_CODE = process.env.SET_CODE ?? 'RA03-FR001';
const DEGRADE = process.env.DEGRADE ?? 'moyen';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.setContent('<body style="margin:0"></body>');
await page.addScriptTag({ path: `${SP}/harness.js` });

const result = await page.evaluate(
  async ({ card, setCode, degrade }) => {
    const { preprocess, viewport } = window.YGO;

    const img = new Image();
    img.src = `data:image/jpeg;base64,${card}`;
    await img.decode();

    // --- 1. La carte avec son code imprimé ------------------------------
    const cw = img.naturalWidth;
    const ch = img.naturalHeight;
    const cardCanvas = document.createElement('canvas');
    cardCanvas.width = cw;
    cardCanvas.height = ch;
    const cc = cardCanvas.getContext('2d');
    cc.drawImage(img, 0, 0);
    cc.fillStyle = '#1a1208';
    cc.textAlign = 'right';
    cc.font = `bold ${Math.round(ch * 0.0175)}px "Liberation Sans", Arial, sans-serif`;
    cc.fillText(setCode, cw * 0.932, ch * 0.7365);

    // --- 2. La prise de vue rapprochée ----------------------------------
    // Le viseur cadre une bande de ~4 cm de large sur une carte de 5,9 cm :
    // la carte occupe donc environ 1,5 fois la largeur de l'écran, et le code
    // tombe au centre. C'est ce que donne un zoom x2,5 tenu à 10 cm.
    const W = 1920;
    const H = 1080;
    const shot = document.createElement('canvas');
    shot.width = W;
    shot.height = H;
    const sc = shot.getContext('2d');
    sc.fillStyle = '#171b22';
    sc.fillRect(0, 0, W, H);

    // Le code est aligné à droite, il finit à 0,932 de la largeur de la carte
    // et fait ~0,16 de large. On amène son milieu (0,852) au centre de l'écran,
    // et sa ligne (0,7285 de la hauteur) sur l'axe horizontal médian.
    const cardWidth = W * 0.95;
    const cardHeight = cardWidth * (ch / cw);
    const originX = W / 2 - cardWidth * 0.852;
    const originY = H / 2 - cardHeight * 0.7285;

    sc.save();
    sc.translate(W / 2, H / 2);
    sc.rotate((degrade === 'aucun' ? 0 : degrade === 'fort' ? 2.2 : 1.0) * (Math.PI / 180));
    sc.translate(-W / 2, -H / 2);
    sc.imageSmoothingQuality = 'high';
    if (degrade !== 'aucun') sc.filter = degrade === 'fort' ? 'blur(1.4px)' : 'blur(0.6px)';
    sc.drawImage(cardCanvas, originX, originY, cardWidth, cardHeight);
    sc.restore();

    if (degrade !== 'aucun') {
      const glare = sc.createLinearGradient(0, 0, W, H);
      glare.addColorStop(0, 'rgba(255,255,255,0)');
      glare.addColorStop(0.42, `rgba(255,255,255,${degrade === 'fort' ? 0.4 : 0.22})`);
      glare.addColorStop(0.72, 'rgba(255,255,255,0)');
      sc.fillStyle = glare;
      sc.fillRect(0, 0, W, H);

      const noise = sc.getImageData(0, 0, W, H);
      const amount = degrade === 'fort' ? 28 : 14;
      for (let i = 0; i < noise.data.length; i += 4) {
        const n = (Math.random() - 0.5) * amount;
        noise.data[i] += n;
        noise.data[i + 1] += n;
        noise.data[i + 2] += n;
      }
      sc.putImageData(noise, 0, 0);
    }

    // --- 3. Extraction par le code réel ---------------------------------
    const container = { width: 390, height: 844 };
    const rect = viewport.toVideoRect(
      viewport.reticleRect(container),
      { width: W, height: H },
      container,
    );

    const variants = preprocess
      .cropVariants(shot, rect, { scale: 2 })
      .map((variant) => ({ label: variant.label, png: variant.canvas.toDataURL('image/png') }));

    return { shot: shot.toDataURL('image/jpeg', 0.92), rect, variants, sharpness: preprocess.cropVariants(shot, rect, { scale: 2 }).sharpness };
  },
  { card: CARD, setCode: SET_CODE, degrade: DEGRADE },
);

fs.writeFileSync(`${SP}/sniper-${DEGRADE}.jpg`, Buffer.from(result.shot.split(',')[1], 'base64'));
const manifest = result.variants.map(({ label, png }) => {
  const file = `${SP}/sniper-${DEGRADE}-${label}.png`;
  fs.writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'));
  return { label, file };
});
fs.writeFileSync(`${SP}/sniper-${DEGRADE}.json`, JSON.stringify(manifest, null, 2));

console.log(
  `viseur « ${DEGRADE} » : recadrage ${Math.round(result.rect.width)}x${Math.round(result.rect.height)} px, nettete ${result.sharpness.toFixed(4)}`,
);
await browser.close();
