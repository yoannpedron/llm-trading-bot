/**
 * Génère 06-formulaire-a-importer.pdf à partir de form.json — même contenu et même format
 * plat que le .docx, à essayer si l'import du Word donne un résultat imparfait.
 *
 * Usage : python3 generate.py && NODE_PATH=/opt/node22/lib/node_modules node generate_pdf.js
 *         (DUMP_HTML=/chemin/print.html pour inspecter le rendu intermédiaire)
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HERE = __dirname;
const data = JSON.parse(fs.readFileSync(path.join(HERE, 'form.json'), 'utf8'));
const e = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const body = data.lines.map((line, i) => line === ''
  ? '<p class="sp">&nbsp;</p>'
  : `<p${i === 0 ? ' class="t"' : ''}>${e(line)}</p>`).join('\n');

const HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>${e(data.title)}</title><style>
@page{size:A4;margin:18mm 16mm}
body{font-family:Calibri,"Segoe UI",Arial,sans-serif;font-size:11pt;color:#000;line-height:1.35;margin:0}
p{margin:0 0 3px}
p.t{font-size:14pt;margin-bottom:10px}
p.sp{margin:0 0 7px;height:1px}
</style></head><body>
${body}
</body></html>`;

if (process.env.DUMP_HTML) fs.writeFileSync(process.env.DUMP_HTML, HTML);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(HTML, { waitUntil: 'load' });
  const out = path.join(HERE, '06-formulaire-a-importer.pdf');
  await page.pdf({ path: out, format: 'A4', printBackground: true });
  await browser.close();
  console.log(`06-formulaire-a-importer.pdf   ${fs.statSync(out).size} octets`);
})();
