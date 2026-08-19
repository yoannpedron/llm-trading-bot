const fs = require('fs');
const D = require('docx');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, BorderStyle, ShadingType, LevelFormat, Header, Footer, PageNumber, PageBreak,
} = D;

const ACCENT = '0D5C63', OCHRE = '8A5A12', BRICK = '94322B', MUTED = '5B6C72', LINE = 'D3DBDB';
const WASH_A = 'E6F0F0', WASH_O = 'F7EEDE', WASH_B = 'F8E7E4', WASH_H = 'EEF2F1';
const BODY = 18;            // 9 pt
const CW = 10064;           // largeur utile : A4 (11906) - 2 x 921 twips (1,62 cm)

// mini-balisage : **gras**, `chemin`, {{champ à compléter}}
function runs(text, base = {}) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\{\{[^}]*\}\})/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), size: BODY, ...base }));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(new TextRun({ text: tok.slice(2, -2), bold: true, size: BODY, ...base }));
    else if (tok.startsWith('`')) out.push(new TextRun({ text: tok.slice(1, -1), font: 'Consolas', size: BODY - 2, color: ACCENT, ...base }));
    else out.push(new TextRun({ text: tok.slice(2, -2) || 'à compléter', highlight: 'yellow', italics: true, size: BODY, ...base }));
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), size: BODY, ...base }));
  return out;
}

const P = (t, o = {}) => new Paragraph({ children: runs(t), spacing: { after: 70, line: 250 }, ...o });
const SMALL = (t) => new Paragraph({ children: runs(t, { size: 16, color: MUTED }), spacing: { after: 70, line: 240 } });
const BUL = (t) => new Paragraph({ children: runs(t), numbering: { reference: 'puces', level: 0 }, spacing: { after: 40, line: 250 } });
const NUM = (t, ref) => new Paragraph({ children: runs(t), numbering: { reference: ref, level: 0 }, spacing: { after: 40, line: 250 } });
const H2 = (n, t) => new Paragraph({
  children: [
    new TextRun({ text: n + '   ', bold: true, size: 22, color: ACCENT }),
    new TextRun({ text: t, bold: true, size: 22 }),
  ],
  heading: HeadingLevel.HEADING_2, keepNext: true,
  spacing: { before: 200, after: 80 },
  border: { top: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 5 } },
});
const H3 = (t) => new Paragraph({
  children: [new TextRun({ text: t, bold: true, size: 18, color: MUTED })],
  heading: HeadingLevel.HEADING_3, keepNext: true, spacing: { before: 100, after: 50 },
});

function cell(children, w, opts = {}) {
  return new TableCell({
    width: { size: w, type: WidthType.DXA },
    margins: { top: 50, bottom: 50, left: 90, right: 90 },
    shading: opts.shading ? { type: ShadingType.CLEAR, fill: opts.shading, color: 'auto' } : undefined,
    children,
  });
}
function table(headers, rows, widths) {
  const trs = [];
  if (headers) {
    trs.push(new TableRow({
      tableHeader: true,
      children: headers.map((h, i) => cell(
        [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 14, color: MUTED, allCaps: true })], spacing: { after: 0 } })],
        widths[i], { shading: WASH_H })),
    }));
  }
  rows.forEach((r) => trs.push(new TableRow({
    children: r.map((c, i) => cell(
      [new Paragraph({ children: runs(String(c), { size: 17 }), spacing: { after: 0, line: 235 } })], widths[i])),
  })));
  const b = { style: BorderStyle.SINGLE, size: 4, color: LINE };
  return new Table({
    columnWidths: widths,
    width: { size: widths.reduce((a, x) => a + x, 0), type: WidthType.DXA },
    borders: { top: b, bottom: b, left: b, right: b, insideHorizontal: b, insideVertical: b },
    rows: trs,
  });
}
function note(label, text, tone) {
  const color = tone === 'warn' ? OCHRE : tone === 'stop' ? BRICK : ACCENT;
  const fill = tone === 'warn' ? WASH_O : tone === 'stop' ? WASH_B : WASH_A;
  const none = { style: BorderStyle.NONE };
  return new Table({
    columnWidths: [CW], width: { size: CW, type: WidthType.DXA },
    borders: { top: none, bottom: none, right: none, insideHorizontal: none, insideVertical: none, left: { style: BorderStyle.SINGLE, size: 18, color } },
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: CW, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill, color: 'auto' },
        margins: { top: 90, bottom: 90, left: 140, right: 140 },
        children: [
          new Paragraph({ children: [new TextRun({ text: label.toUpperCase(), bold: true, size: 14, color })], spacing: { after: 40 } }),
          new Paragraph({ children: runs(text, { size: 17 }), spacing: { after: 0, line: 235 } }),
        ],
      })],
    })],
  });
}
const RULE = (code, text) => new Paragraph({
  children: [new TextRun({ text: code + '   ', bold: true, size: 17, color: ACCENT }), ...runs(text, { size: 17 })],
  spacing: { after: 60, line: 240 },
  indent: { left: 420, hanging: 420 },
});
const CHECK = (t) => new Paragraph({
  children: [new TextRun({ text: '☐  ', size: 17 }), ...runs(t, { size: 17 })],
  spacing: { after: 30, line: 230 }, indent: { left: 260, hanging: 260 },
});
const BREAK = () => new Paragraph({ children: [new PageBreak()] });

// ======================= PAGE 1 =======================
const body = [];
body.push(new Paragraph({
  children: [new TextRun({ text: 'PROCÉDURE INTERNE · PRO-ACH-001', bold: true, size: 15, color: ACCENT })],
  spacing: { after: 80 },
}));
body.push(new Paragraph({
  children: [new TextRun({ text: 'Commander sur le webshop Lyreco', bold: true, size: 34 })],
  spacing: { after: 60 },
}));
body.push(new Paragraph({
  children: [new TextRun({ text: "Mode opératoire à l'usage des centres : passer une commande, la suivre, réceptionner la livraison et traiter les anomalies.", size: 19, color: MUTED, italics: true })],
  spacing: { after: 100, line: 240 },
}));
body.push(new Paragraph({
  children: [
    new TextRun({ text: 'Version ', bold: true, size: 15 }), new TextRun({ text: '1.0      ', size: 15, color: MUTED }),
    new TextRun({ text: 'Application ', bold: true, size: 15 }), new TextRun({ text: 'à compléter', size: 15, highlight: 'yellow', italics: true }),
    new TextRun({ text: '      Diffusion ', bold: true, size: 15 }), new TextRun({ text: 'centres, DR, siège      ', size: 15, color: MUTED }),
    new TextRun({ text: 'Révision ', bold: true, size: 15 }), new TextRun({ text: 'annuelle      ', size: 15, color: MUTED }),
    new TextRun({ text: 'Contact ', bold: true, size: 15 }), new TextRun({ text: 'service achats', size: 15, highlight: 'yellow', italics: true }),
  ],
  spacing: { after: 60 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ACCENT, space: 6 } },
}));

body.push(H2('1', 'Ce que couvre cette procédure'));
body.push(P("Tout achat de fournitures de fonctionnement passé sur le webshop Lyreco : papier, cartouches et toners, fournitures de bureau, hygiène et entretien, alimentation et réception, EPI, emballage, petit équipement de bureau."));
body.push(P("**Ne passent pas par Lyreco** : le matériel médical et audiologique, l'informatique gérée par la DSI, le mobilier et les aménagements au-delà de {{seuil à compléter}}. Ces demandes sont adressées au service achats."));

body.push(H2('2', 'Les six règles à respecter'));
body.push(RULE('R1', "Regrouper les besoins du centre : **une commande par** {{période à compléter}}, hors urgence justifiée."));
body.push(RULE('R2', "**75 € HT minimum** par commande : c'est le seuil de la livraison gratuite. En dessous, des frais de port sont facturés."));
body.push(RULE('R3', "Commander **dans le mini-catalogue et les listes de favoris**, qui contiennent les produits négociés. Besoin hors catalogue : passer par le service achats."));
body.push(RULE('R4', "**Vérifier le compte actif** avant de remplir le panier : il détermine l'adresse de livraison et l'imputation de la dépense."));
body.push(RULE('R5', "Renseigner la **référence interne**, le nom du contact et un **téléphone joignable** au moment de valider."));
body.push(RULE('R6', "Signaler toute **anomalie de livraison sous 48 heures**, réserves portées sur le bon de livraison."));
body.push(SMALL("Le webshop est réservé à un usage professionnel. Les identifiants sont personnels et ne se partagent pas : chaque commande est nominative."));

body.push(H2('3', 'Se connecter et choisir le bon compte'));
body.push(P("Connectez-vous sur `www.lyreco.com/webshop`, espace `Utilisateur`. L'identifiant est votre numéro de compte suivi de vos initiales, par exemple `4765875XY`. Mot de passe oublié : lien de réinitialisation sur la page de connexion."));
body.push(P("Le bandeau en haut de l'écran affiche le compte actif : `Compte : 4765875 · AUDIKA · C0092 · 1 rue du Général Fauconnet · 21000 DIJON`. Vérifiez qu'il correspond bien au centre à livrer. Pour en changer :"));
[
  "Cliquer sur `Changer de compte`.",
  "Déplier la hiérarchie, ou saisir le numéro dans `Chercher un numéro de compte` puis `Chercher`.",
  "Sur la ligne du centre — **affichée en bleu** — cliquer sur `Sélectionner`, puis contrôler le bandeau.",
].forEach((t) => body.push(NUM(t, 'compte')));
body.push(P("Dans la hiérarchie, les libellés en **noir** sont des niveaux d'organisation (administrateur, siège, réseau, direction régionale) : ils ne reçoivent pas de livraison. Seuls les libellés en **bleu** sont des adresses de livraison et peuvent commander."));
body.push(note('Message bloquant', "« Vous êtes connecté sur un compte qui ne peut pas commander » : vous êtes sur un niveau d'organisation, pas sur un centre. Ce n'est pas une panne — basculez via `Changer de compte`.", 'stop'));
body.push(new Paragraph({ text: '', spacing: { after: 60 } }));
body.push(note('Point de vigilance', "Changer de compte en cours de commande vide ou recalcule le panier : tarifs, catalogue et budgets sont propres à chaque compte. Choisissez le compte avant de remplir le panier.", 'warn'));

// ======================= PAGE 2 =======================
body.push(BREAK());
body.push(H2('4', 'Constituer le panier'));
body.push(H3("a. Listes de favoris — voie à privilégier"));
body.push(P("`Mes favoris › Produits préférés` : les listes partagées du réseau contiennent les produits validés par le siège. Ouvrez la liste, saisissez les quantités, ajoutez au panier."));
body.push(H3("b. Commande rapide — pour un réassort connu"));
body.push(P("`Commande rapide` (icône chronomètre à droite de la barre de recherche) : `Via les références produits` pour saisir directement les références et les quantités, ou `Via un fichier` pour importer un fichier Excel/CSV."));
body.push(H3("c. Catalogue et recherche"));
body.push(P("Recherche par mot-clé ou par référence. Pour les consommables d'impression, l'`Outil de recherche de cartouche` donne la référence exacte à partir du modèle d'imprimante. Une commande passée peut être rejouée depuis `Mon historique de commande`."));
body.push(P("Un panier peut être préparé puis repris plus tard : `Mettre la commande en attente`, avec un titre explicite (C0092 – réappro mars). Utilisez-le pendant la collecte des besoins du centre plutôt que de multiplier les petites commandes."));
body.push(note('Point de vigilance', "Contrôlez l'**unité de vente** : boîte de 100, lot de 12, carton de 5 ramettes. La quantité saisie porte sur le conditionnement affiché, pas sur l'unité. C'est la première cause de sur-commande.", 'warn'));

body.push(H2('5', 'Valider la commande'));
[
  "Dans le panier : `Afficher`, puis `Voir mes offres et valider ma commande`.",
  "`Suivant` pour accéder aux informations de livraison : adresse, nom du contact du centre, téléphone joignable par le chauffeur.",
  "Renseigner la référence interne, puis confirmer. Un e-mail de confirmation vous parvient avec le numéro de commande et la date de livraison estimée.",
].forEach((t) => body.push(NUM(t, 'valider')));
body.push(P("Commande validée avant 18 h : livraison le lendemain dans 99 % des cas."));
body.push(P("Si le message « **reçu, en attente de validation** » s'affiche, la commande n'est pas encore partie chez Lyreco : elle attend votre valideur, qui reçoit un e-mail et peut la valider, la modifier ou la refuser. Ce contrôle se déclenche en cas de dépassement de budget, de produit signalé comme contrôlé, ou selon votre profil. Délai de traitement attendu : {{}} — au-delà, relancez votre valideur."));

body.push(H2('6', 'Suivre la commande'));
body.push(P("`Commandes en cours` affiche les commandes transmises et celles en attente de validation ; `Mon historique de commande` permet de rechercher par numéro, date ou produit. Le lien de suivi figure dans l'e-mail de confirmation."));
body.push(P("Une modification ou une annulation doit être demandée **immédiatement** au Service Clients Lyreco. Une fois la préparation lancée, elle relève d'un retour."));

body.push(H2('7', 'Réceptionner la livraison'));
[
  "**Avant de signer** : compter les colis et comparer avec le bon de livraison (BL).",
  "**Colis abîmé** : le refuser, ou porter une réserve écrite précise sur le BL — « carton n° 2 éventré, contenu à vérifier ». La mention « sous réserve de déballage » n'a aucune valeur.",
  "**Après déballage** : contrôler références et quantités ligne à ligne, photographier tout produit manquant, cassé ou non conforme.",
  "**Livraison sans contact** : pas de signature, la preuve est une photo du lieu de dépose et le nom du réceptionnaire.",
  "**Conserver le BL** : il est exigé pour toute réclamation et tout retour.",
].forEach((t) => body.push(NUM(t, 'reception')));

// ======================= PAGE 3 =======================
body.push(BREAK());
body.push(H2('8', 'Anomalies et retours'));
body.push(table(['Situation', 'Ce que vous faites', 'Délai'], [
  ['Produit manquant, colis non livré', 'Réserve sur le BL, puis appel au Service Clients avec le n° de commande et le n° de BL', '48 h'],
  ['Produit cassé ou détérioré', "Photos, conservation de l'emballage, déclaration", '48 h'],
  ['Erreur de référence livrée', "Demande d'échange : reprise par un chauffeur Lyreco", '48 h'],
  ['Produit inutile ou erreur de saisie', "Demande de reprise : produit non utilisé, non marqué, emballage d'origine intact, copie du BL jointe", '30 jours'],
  ['Écart sur la facture', 'Rapprochement facture / BL / commande, puis demande d\'avoir', 'À réception'],
], [2900, 5664, 1500]));
body.push(new Paragraph({ text: '', spacing: { after: 80 } }));
body.push(P("La reprise est gratuite dans les **30 jours** suivant la livraison. Passé ce délai, aucun retour ni avoir n'est possible. Certains produits ne sont pas retournables : articles personnalisés, denrées alimentaires, produits d'hygiène ouverts."));

body.push(H2('9', 'Retrouver vos documents'));
body.push(P("`Mon Espace › Mes documents` donne accès aux bons de livraison, aux **BL émargés** (preuve de réception), aux factures et avoirs, et à la liste de prix. Recherchez par numéro de livraison, de commande ou par période, sélectionnez les documents puis cliquez sur `Demande` : ils arrivent en PDF par e-mail. Les BL émargés sont aussi accessibles depuis `Mon historique de commande`, en ouvrant la commande puis `Voir les BL émargés`."));

body.push(H2('10', 'Que faire si…'));
body.push(table(['Symptôme', 'Cause', 'Solution'], [
  ["Les prix ne s'affichent pas", "Compte positionné sur un niveau d'organisation", '`Changer de compte` vers le centre (ligne bleue)'],
  ['Alerte budget à la validation', 'Montant supérieur au budget du compte', 'Réduire le panier ou justifier auprès du valideur'],
  ['Un produit connu est introuvable', 'Article hors mini-catalogue', 'Demande au service achats, sans contourner par une référence approchante'],
  ['La commande reste en attente de validation', 'Valideur non intervenu', "Le relancer : rien n'est parti chez Lyreco"],
  ['Livraison arrivée dans un autre centre', 'Mauvais compte actif à la validation', 'Prévenir les deux centres et le service achats (règle R4)'],
  ['Panier vidé après un changement de compte', 'Le panier est propre à chaque compte', "Choisir le compte d'abord, utiliser la mise en attente"],
], [3000, 3000, 4064]));

body.push(H2('11', 'Qui contacter'));
body.push(table(null, [
  ['**Livraison, retour, échange, SAV**', 'Service Clients Lyreco — 0825 09 08 07 (0,15 €/min + prix appel), ou `Contactez-nous` depuis le webshop'],
  ['**Accès, mot de passe, droits**', 'Administrateur webshop — {{nom et e-mail à compléter}}'],
  ['**Besoin hors catalogue, question sur la procédure**', 'Service achats — {{nom et e-mail à compléter}}'],
  ['**Écart de facturation**', 'Comptabilité fournisseurs — {{}}'],
], [3600, 6464]));
body.push(new Paragraph({ text: '', spacing: { after: 100 } }));

body.push(new Paragraph({
  children: [new TextRun({ text: 'CHECK-LIST AVANT DE VALIDER', bold: true, size: 15, color: ACCENT })],
  spacing: { before: 60, after: 70 },
  border: { top: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 5 } },
}));
const CHECKS = [
  "Le compte affiché est celui du centre à livrer.",
  "Montant supérieur ou égal à 75 € HT.",
  "Les besoins du centre sont regroupés.",
  "Budget respecté, ou dépassement justifié.",
  "Références, unités de vente et quantités vérifiées.",
  "Référence interne, contact et téléphone renseignés.",
  "Produits issus du mini-catalogue ou des favoris.",
  "Commande passée avant 18 h si livraison attendue le lendemain.",
];
const none = { style: BorderStyle.NONE };
body.push(new Table({
  columnWidths: [5032, 5032],
  width: { size: CW, type: WidthType.DXA },
  borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
  rows: [0, 1, 2, 3].map((i) => new TableRow({
    children: [CHECKS[i * 2], CHECKS[i * 2 + 1]].map((t) => new TableCell({
      width: { size: 5032, type: WidthType.DXA },
      margins: { top: 20, bottom: 20, left: 0, right: 120 },
      children: [CHECK(t)],
    })),
  })),
}));

// ======================= DOCUMENT =======================
const numbering = {
  config: [
    { reference: 'puces', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 400, hanging: 240 } } } }] },
    ...['compte', 'valider', 'reception'].map((ref) => ({
      reference: ref,
      levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 400, hanging: 240 } } } }],
    })),
  ],
};

const doc = new Document({
  creator: 'Service achats',
  title: 'PRO-ACH-001 — Commander sur le webshop Lyreco',
  description: 'Procédure interne — mode opératoire',
  numbering,
  styles: {
    default: { document: { run: { font: 'Calibri', size: BODY, color: '17232A' } } },
    paragraphStyles: [
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Calibri', size: 22, bold: true, color: '17232A' } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Calibri', size: 18, bold: true, color: MUTED } },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 },
        margin: { top: 851, right: 921, bottom: 794, left: 921 },
      },
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [
            new TextRun({ text: 'PRO-ACH-001 · Version 1.0 · Document interne          ', size: 14, color: MUTED }),
            new TextRun({ children: ['Page ', PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], size: 14, color: MUTED }),
          ],
        })],
      }),
    },
    children: body,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync('PRO-ACH-001_Procedure_Lyreco.docx', buf);
  console.log('OK', buf.length, 'octets');
});
