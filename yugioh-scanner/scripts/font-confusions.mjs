/**
 * Mesure les confusions de glyphes, au lieu de les deviner.
 *
 * Les tables de transposition de `parse.js` décident si un « O » lu est un zéro
 * ou une lettre. Écrites de mémoire, elles reflètent surtout des idées reçues.
 * Ce script les dérive de la **forme réelle des caractères** : chaque glyphe de
 * l'alphabet d'un code d'extension est rendu, binarisé, normalisé dans une boîte
 * commune, puis comparé à tous les autres.
 *
 * Deux précautions rendent le résultat exploitable :
 *
 *  - la comparaison se fait sur une **silhouette floutée**, à la résolution où
 *    l'OCR travaille vraiment. Comparer des bitmaps nets ne dirait rien : c'est
 *    la perte de définition qui crée la confusion, pas la forme idéale ;
 *  - plusieurs polices sont mesurées et **seules les paires confuses dans
 *    toutes** sont retenues. Une confusion propre à une fonte ne dit rien de la
 *    police d'une carte Yu-Gi-Oh, qu'on ne possède pas.
 *
 *     node scripts/font-confusions.mjs
 */

import { chromium } from 'playwright';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Grotesques condensées, proches de la fonte des codes d'extension. */
const FONTS = [
  '"Liberation Sans", sans-serif',
  '"DejaVu Sans", sans-serif',
  '"FreeSans", sans-serif',
];

/** Au-delà : la paire est tenue pour confuse. Calibré sur les paires connues. */
const SIMILAR = Number(process.env.SEUIL ?? 0.86);

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage();
await page.setContent('<body style="margin:0"></body>');

const measured = await page.evaluate(
  ({ alphabet, fonts }) => {
    const BOX = 24; // boîte de normalisation
    const RENDER = 64; // hauteur de rendu avant réduction

    /** Silhouette normalisée d'un glyphe : cadrée sur son encre, puis réduite. */
    function silhouette(character, font) {
      const canvas = document.createElement('canvas');
      canvas.width = RENDER;
      canvas.height = RENDER;
      const context = canvas.getContext('2d', { willReadFrequently: true });

      context.fillStyle = '#fff';
      context.fillRect(0, 0, RENDER, RENDER);
      context.fillStyle = '#000';
      context.font = `bold ${Math.round(RENDER * 0.72)}px ${font}`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(character, RENDER / 2, RENDER / 2);

      const { data } = context.getImageData(0, 0, RENDER, RENDER);

      // Cadrage sur l'encre : sans cela, on comparerait des positions autant
      // que des formes, et « I » ressemblerait à « J » par simple centrage.
      let minX = RENDER;
      let minY = RENDER;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < RENDER; y += 1) {
        for (let x = 0; x < RENDER; x += 1) {
          if (data[(y * RENDER + x) * 4] < 128) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return null;

      const inkWidth = maxX - minX + 1;
      const inkHeight = maxY - minY + 1;

      const box = document.createElement('canvas');
      box.width = BOX;
      box.height = BOX;
      const target = box.getContext('2d', { willReadFrequently: true });
      target.imageSmoothingEnabled = true;
      target.imageSmoothingQuality = 'high';
      target.fillStyle = '#fff';
      target.fillRect(0, 0, BOX, BOX);

      // On met à l'échelle **par la hauteur** en gardant le rapport, puis on
      // centre. Étirer dans un carré écraserait la largeur — or c'est
      // exactement ce qui sépare un « I » d'un « 1 » ou d'un « 4 » : les rendre
      // artificiellement de même largeur fabriquerait des confusions inexistantes
      // et en masquerait de réelles.
      const drawn = Math.max(1, Math.round((inkWidth / inkHeight) * BOX));
      const width = Math.min(BOX, drawn);
      // Le flou de la réduction est voulu : il reproduit la perte de définition
      // que subit une inscription de deux millimètres photographiée de loin.
      target.drawImage(
        canvas,
        minX, minY, inkWidth, inkHeight,
        Math.round((BOX - width) / 2), 0, width, BOX,
      );

      const reduced = target.getImageData(0, 0, BOX, BOX).data;
      const pixels = new Float32Array(BOX * BOX);
      for (let i = 0, p = 0; p < pixels.length; i += 4, p += 1) {
        pixels[p] = 1 - reduced[i] / 255; // 1 = encre
      }
      return pixels;
    }

    /** Corrélation cosinus de deux silhouettes. */
    function similarity(a, b) {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < a.length; i += 1) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      return na && nb ? dot / Math.sqrt(na * nb) : 0;
    }

    const perFont = {};
    for (const font of fonts) {
      const shapes = new Map();
      for (const character of alphabet) {
        const shape = silhouette(character, font);
        if (shape) shapes.set(character, shape);
      }

      const scores = {};
      for (const [a, shapeA] of shapes) {
        for (const [b, shapeB] of shapes) {
          if (a >= b) continue;
          scores[`${a}${b}`] = similarity(shapeA, shapeB);
        }
      }
      perFont[font] = scores;
    }

    return perFont;
  },
  { alphabet: ALPHABET, fonts: FONTS },
);

await browser.close();

/* --- Agrégation : on ne garde que ce qui vaut dans toutes les polices ------ */

const pairs = Object.keys(measured[FONTS[0]]);
const aggregated = pairs
  .map((pair) => {
    const scores = FONTS.map((font) => measured[font][pair] ?? 0);
    return { pair, min: Math.min(...scores), mean: scores.reduce((a, b) => a + b) / scores.length };
  })
  .filter((entry) => entry.min >= SIMILAR)
  .sort((a, b) => b.min - a.min);

const isDigit = (character) => character >= '0' && character <= '9';

console.log(`Paires confuses dans les ${FONTS.length} polices (seuil ${SIMILAR}) :\n`);
console.log('paire   min    moyenne  nature');
for (const { pair, min, mean } of aggregated) {
  const [a, b] = pair;
  const nature =
    isDigit(a) === isDigit(b)
      ? isDigit(a)
        ? 'chiffre/chiffre'
        : 'lettre/lettre'
      : 'LETTRE/CHIFFRE';
  console.log(
    `${a}/${b}   ${min.toFixed(3)}  ${mean.toFixed(3)}   ${nature}`,
  );
}

const crossed = aggregated.filter(({ pair }) => isDigit(pair[0]) !== isDigit(pair[1]));
console.log(`\n${crossed.length} paires lettre/chiffre — ce sont elles qui pilotent la transposition.`);

/* --- Contrôle : ce que valent les paires inscrites dans `parse.js` --------- */

const DECLAREES = ['0O', '1I', '2Z', '5S', '6G', '8B', '0Q', '0D', '1L'];
const score = (pair) => {
  const key = pair[0] < pair[1] ? pair : `${pair[1]}${pair[0]}`;
  const scores = FONTS.map((font) => measured[font][key] ?? 0);
  return { min: Math.min(...scores), mean: scores.reduce((a, b) => a + b) / scores.length };
};

console.log('\nParticipation des paires déclarées dans parse.js :\n');
console.log('paire   min    moyenne  verdict');
for (const pair of DECLAREES) {
  const { min, mean } = score(pair);
  const verdict = min >= SIMILAR ? 'confirmée' : min >= SIMILAR - 0.06 ? 'limite' : 'NON MESURÉE';
  console.log(`${pair[0]}/${pair[1]}   ${min.toFixed(3)}  ${mean.toFixed(3)}   ${verdict}`);
}
