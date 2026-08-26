/**
 * Génère 05-formulaire-a-importer.docx à partir de form.json.
 * Document volontairement épuré : Microsoft Forms déduit les questions et leurs
 * propositions de réponses de la mise en forme, donc pas d'annotations parasites.
 *
 * Usage : python3 generate.py && node generate_docx.js
 */
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle, LevelFormat,
} = require('docx');

const HERE = __dirname;
const data = JSON.parse(fs.readFileSync(path.join(HERE, 'form.json'), 'utf8'));

const BRAND = '0B3C5D';
const GREY = '5B6B7C';
const FONT = 'Calibri';

const p = (text, o = {}) => new Paragraph({
  spacing: { after: o.after === undefined ? 120 : o.after, before: o.before || 0 },
  alignment: o.align,
  indent: o.indent,
  numbering: o.numbering,
  border: o.border,
  children: [new TextRun({
    text, bold: o.bold, italics: o.italics, size: o.size || 22,
    color: o.color, font: FONT,
  })],
});

const children = [];

/* ---- titre + description du formulaire ---- */
children.push(new Paragraph({
  spacing: { after: 200 },
  children: [new TextRun({ text: data.title, bold: true, size: 34, color: BRAND, font: FONT })],
}));
data.intro.forEach(t => children.push(p(t, { size: 21 })));

/* ---- sections ---- */
data.sections.forEach(sec => {
  children.push(new Paragraph({
    spacing: { before: 360, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: BRAND, space: 4 } },
    children: [new TextRun({
      text: `Section ${sec.num} — ${sec.title}`,
      bold: true, size: 26, color: BRAND, font: FONT,
    })],
    heading: HeadingLevel.HEADING_2,
  }));

  if (sec.desc) children.push(p(sec.desc, { italics: true, color: GREY, size: 20 }));

  if (sec.process) {
    const pr = data.process;
    children.push(p(pr.title, { bold: true, size: 21 }));
    pr.paras.forEach(t => children.push(p(t, { size: 20 })));
    pr.bullets.forEach(t => children.push(p(t, { size: 20, numbering: { reference: 'puces', level: 0 } })));
    pr.after.forEach(t => children.push(p(t, { size: 20 })));
  }

  sec.questions.forEach(q => {
    children.push(new Paragraph({
      spacing: { before: 200, after: 60 },
      children: [new TextRun({ text: `${q.n}. ${q.text}`, bold: true, size: 22, font: FONT })],
    }));

    if (q.typ === 'likert') {
      const cols = data.likert.cols;
      const total = 9360;                       // largeur utile A4 en DXA
      const first = 2760;
      const w = Math.floor((total - first) / cols.length);
      const widths = [first, ...cols.map(() => w)];
      widths[widths.length - 1] += total - widths.reduce((a, b) => a + b, 0);
      const cell = (text, i, head) => new TableCell({
        width: { size: widths[i], type: WidthType.DXA },
        shading: head ? { type: ShadingType.CLEAR, fill: 'E8F0F6' } : undefined,
        children: [p(text, { size: 18, bold: head, after: 40, align: i ? AlignmentType.CENTER : undefined })],
      });
      children.push(new Table({
        columnWidths: widths,
        width: { size: total, type: WidthType.DXA },
        rows: [
          new TableRow({
            tableHeader: true,
            children: ['', ...cols].map((c, i) => cell(c, i, true)),
          }),
          ...data.likert.rows.map(r => new TableRow({
            children: [r, ...cols.map(() => '')].map((c, i) => cell(c, i, false)),
          })),
        ],
      }));
      children.push(p('', { after: 60 }));
    } else if (q.options && q.options.length) {
      q.options.forEach(o => children.push(
        p(o, { size: 22, numbering: { reference: 'puces', level: 0 } })));
    }
  });
});

/* ---- message de fin ---- */
children.push(new Paragraph({
  spacing: { before: 360, after: 120 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: BRAND, space: 4 } },
  children: [new TextRun({ text: 'Message de fin', bold: true, size: 26, color: BRAND, font: FONT })],
  heading: HeadingLevel.HEADING_2,
}));
data.fin.forEach(t => children.push(p(t, { size: 21 })));

const doc = new Document({
  creator: 'Services Généraux',
  title: data.title,
  numbering: {
    config: [{
      reference: 'puces',
      levels: [{
        level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 420, hanging: 240 } } },
      }],
    }],
  },
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
