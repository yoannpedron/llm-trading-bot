/**
 * Génère 05-formulaire-a-importer.docx à partir de form.json.
 *
 * Format volontairement pauvre : le convertisseur de Microsoft Forms ne lit que du texte
 * brut. Les listes à puces de Word, les tableaux et les titres stylés sont ignorés ou
 * fusionnés dans le libellé de la question. Le document n'utilise donc qu'un seul style
 * de paragraphe, sans numérotation Word, sans tableau et sans titre : la numérotation des
 * questions (« 1. ») et le marquage des propositions (« a. ») sont de vrais caractères
 * saisis, seule forme que le convertisseur reconnaît.
 *
 * Usage : python3 generate.py && node generate_docx.js
 */
const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun } = require('docx');

const HERE = __dirname;
const data = JSON.parse(fs.readFileSync(path.join(HERE, 'form.json'), 'utf8'));

const children = data.lines.map((line, i) => new Paragraph({
  spacing: { after: line === '' ? 0 : 60 },
  children: [new TextRun({ text: line, font: 'Calibri', size: i === 0 ? 28 : 22 })],
}));

const doc = new Document({
  creator: 'Services Généraux',
  title: data.title,
  sections: [{
    properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
    children,
  }],
});

Packer.toBuffer(doc).then(buf => {
  const out = path.join(HERE, '05-formulaire-a-importer.docx');
  fs.writeFileSync(out, buf);
  console.log(`05-formulaire-a-importer.docx   ${buf.length} octets`);
});
