/**
 * Génère 06-formulaire-a-importer.pdf à partir de form.json — version de secours si
 * l'import du .docx dans Microsoft Forms donne un résultat imparfait.
 *
 * Usage : python3 generate.py && node generate_pdf.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HERE = __dirname;
const data = JSON.parse(fs.readFileSync(path.join(HERE, 'form.json'), 'utf8'));
const e = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const parts = [];
parts.push(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${e(data.title)}</title>
<style>
@page{size:A4;margin:18mm 16mm}
body{font-family:Calibri,"Segoe UI",Arial,sans-serif;font-size:11pt;color:#16202b;line-height:1.45;margin:0}
h1{font-size:19pt;color:#0b3c5d;margin:0 0 12px}
h2{font-size:13pt;color:#0b3c5d;margin:22px 0 8px;padding-bottom:4px;border-bottom:1.5px solid #0b3c5d;
 page-break-after:avoid}
.intro{font-size:10.5pt;margin:0 0 8px}
.desc{font-size:10pt;color:#5b6b7c;font-style:italic;margin:0 0 10px}
.q{font-weight:700;margin:14px 0 4px;page-break-after:avoid}
ul{margin:0 0 6px;padding-left:22px}
li{margin:2px 0}
table{border-collapse:collapse;width:100%;font-size:9pt;margin:6px 0 10px;page-break-inside:avoid}
th,td{border:1px solid #dde3ea;padding:5px 4px;text-align:center}
th{background:#e8f0f6;font-weight:600}
th:first-child,td:first-child{text-align:left;width:26%}
.process{font-size:10pt;margin:0 0 8px}
</style></head><body>`);
parts.push(`<h1>${e(data.title)}</h1>`);
data.intro.forEach(t => parts.push(`<p class="intro">${e(t)}</p>`));

data.sections.forEach(sec => {
  parts.push(`<h2>Section ${sec.num} — ${e(sec.title)}</h2>`);
  if (sec.desc) parts.push(`<p class="desc">${e(sec.desc)}</p>`);
  if (sec.process) {
    const pr = data.process;
    parts.push(`<p class="process"><strong>${e(pr.title)}</strong></p>`);
    pr.paras.forEach(t => parts.push(`<p class="process">${e(t)}</p>`));
    parts.push('<ul>' + pr.bullets.map(b => `<li>${e(b)}</li>`).join('') + '</ul>');
    pr.after.forEach(t => parts.push(`<p class="process">${e(t)}</p>`));
  }
  sec.questions.forEach(q => {
    parts.push(`<p class="q">${q.n}. ${e(q.text)}</p>`);
    if (q.typ === 'likert') {
      const cols = data.likert.cols;
      parts.push('<table><thead><tr><th></th>' + cols.map(c => `<th>${e(c)}</th>`).join('') +
        '</tr></thead><tbody>' + data.likert.rows.map(r =>
          `<tr><td>${e(r)}</td>${'<td></td>'.repeat(cols.length)}</tr>`).join('') + '</tbody></table>');
    } else if (q.options && q.options.length) {
      parts.push('<ul>' + q.options.map(o => `<li>${e(o)}</li>`).join('') + '</ul>');
    }
  });
});

parts.push('<h2>Message de fin</h2>');
data.fin.forEach(t => parts.push(`<p class="intro">${e(t)}</p>`));
parts.push('</body></html>');

const HTML = parts.join('\n');
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
