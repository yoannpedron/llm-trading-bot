/* Recueil de procédures — Services Généraux Audika
   Word (.docx) mis en page dans le style des versions web. */
const fs = require('fs');
const D = require('docx');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, BorderStyle, ShadingType, LevelFormat, Footer, PageNumber, ImageRun, PageBreak,
} = D;

/* ---------- jeton graphique ---------- */
const ACCENT = '0D5C63', OCHRE = '8A5A12', BRICK = '94322B', MUTED = '5B6C72',
      LINE = 'D3DBDB', INK = '17232A';
const WASH_A = 'E6F0F0', WASH_O = 'F7EEDE', WASH_B = 'F8E7E4', WASH_H = 'EEF2F1', CHIP = 'EDF2F1';
const SERIF = 'Cambria', SANS = 'Arial', MONO = 'Consolas';
const BODY = 18;                 // 9 pt
const CW = 9864;                 // A4 (11906) moins 2 x 1021 twips (1,8 cm)
const cols = (f) => { const w = f.map((x) => Math.round(x * CW)); w[w.length - 1] += CW - w.reduce((a, b) => a + b, 0); return w; };

/* ---------- balisage : **gras**, `chemin`, {{à compléter}}, //italique// ---------- */
const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\{\{[^}]*\}\}|\/\/[^/]+\/\/)/g;
function runs(text, o = {}) {
  const size = o.size || BODY, color = o.color || INK, font = o.font || SERIF;
  const out = [];
  for (const part of String(text).split(TOKEN)) {
    if (!part) continue;
    if (part.startsWith('**')) out.push(new TextRun({ text: part.slice(2, -2), bold: true, size, color, font }));
    else if (part.startsWith('//')) out.push(new TextRun({ text: part.slice(2, -2), italics: true, size, color, font }));
    else if (part.startsWith('`')) out.push(new TextRun({
      text: part.slice(1, -1), font: MONO, size: size - 2, color: ACCENT,
      shading: { type: ShadingType.CLEAR, fill: CHIP, color: 'auto' },
    }));
    else if (part.startsWith('{{')) out.push(new TextRun({
      text: part.slice(2, -2) || 'à compléter', italics: true, size: size - 1,
      color: '6B4B12', highlight: 'yellow', font: SANS,
    }));
    else out.push(new TextRun({ text: part, size, color, font, bold: o.bold }));
  }
  return out;
}

/* ---------- briques de mise en page ---------- */
const P = (t, o = {}) => new Paragraph({
  children: runs(t, o),
  spacing: { after: o.after == null ? 58 : o.after, line: o.line || 240 },
  indent: o.indent,
  alignment: o.align,
});
const SMALL = (t) => P(t, { size: 16, color: MUTED, after: 100 });

const EYEBROW = (t) => new Paragraph({
  children: [new TextRun({ text: t, font: SANS, size: 15, bold: true, color: ACCENT, characterSpacing: 30 })],
  spacing: { after: 70 },
});
const TITLE = (t) => new Paragraph({
  children: [new TextRun({ text: t, font: SANS, size: 36, bold: true, color: INK })],
  spacing: { after: 70 }, keepNext: true,
});
const LEDE = (t) => new Paragraph({
  children: [new TextRun({ text: t, font: SERIF, size: 19, color: MUTED, italics: true })],
  spacing: { after: 90, line: 240 },
});
const META = (pairs) => new Paragraph({
  children: pairs.flatMap(([k, v], i) => [
    new TextRun({ text: (i ? '     ' : '') + k + ' ', font: SANS, size: 15, bold: true, color: INK }),
    ...(v.startsWith('{{')
      ? runs(v, { size: 15 })
      : [new TextRun({ text: v, font: SANS, size: 15, color: MUTED })]),
  ]),
  spacing: { after: 40 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 14, color: ACCENT, space: 7 } },
});

const H2 = (num, t) => new Paragraph({
  children: [
    new TextRun({ text: num + '   ', font: SANS, size: 22, bold: true, color: ACCENT }),
    new TextRun({ text: t, font: SANS, size: 22, bold: true, color: INK }),
  ],
  keepNext: true,
  spacing: { before: 140, after: 62 },
  border: { top: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 8 } },
});
const H3 = (t) => new Paragraph({
  children: [new TextRun({ text: t, font: SANS, size: 18, bold: true, color: INK })],
  keepNext: true, spacing: { before: 100, after: 45 },
});

const BUL = (t) => new Paragraph({
  children: runs(t), numbering: { reference: 'puces', level: 0 },
  spacing: { after: 38, line: 240 },
});
const NUM = (t, ref) => new Paragraph({
  children: runs(t), numbering: { reference: ref, level: 0 },
  spacing: { after: 45, line: 250 },
});
const RULE = (k, t) => new Paragraph({
  children: [new TextRun({ text: k + '   ', font: SANS, size: 17, bold: true, color: ACCENT }), ...runs(t, { size: 18 })],
  spacing: { after: 45, line: 238 },
  indent: { left: 520, hanging: 520 },
});
const CHECK = (t) => new Paragraph({
  children: [new TextRun({ text: '☐  ', size: 18, font: SERIF }), ...runs(t, { size: 17 })],
  spacing: { after: 40, line: 235 }, indent: { left: 260, hanging: 260 },
});

function cell(children, w, opts = {}) {
  return new TableCell({
    width: { size: w, type: WidthType.DXA },
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    shading: opts.shading ? { type: ShadingType.CLEAR, fill: opts.shading, color: 'auto' } : undefined,
    children,
  });
}
function table(headers, rows, widths, opts = {}) {
  const trs = [];
  if (headers) trs.push(new TableRow({
    tableHeader: true,
    children: headers.map((h, i) => cell(
      [new Paragraph({ children: [new TextRun({ text: h, font: SANS, bold: true, size: 13, color: MUTED, allCaps: true, characterSpacing: 20 })], spacing: { after: 0 } })],
      widths[i], { shading: WASH_H })),
  }));
  rows.forEach((r) => trs.push(new TableRow({
    children: r.map((c, i) => cell(
      [new Paragraph({
        children: runs(c, { size: 17, color: (!headers && i === 0) ? ACCENT : INK, bold: !headers && i === 0 }),
        spacing: { after: 0, line: 235 },
      })], widths[i])),
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
    borders: { top: none, bottom: none, right: none, insideHorizontal: none, insideVertical: none,
               left: { style: BorderStyle.SINGLE, size: 18, color } },
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: CW, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill, color: 'auto' },
        margins: { top: 100, bottom: 100, left: 150, right: 150 },
        children: [
          new Paragraph({
            children: [new TextRun({ text: label.toUpperCase(), font: SANS, bold: true, size: 13, color, characterSpacing: 25 })],
            spacing: { after: 45 },
          }),
          new Paragraph({ children: runs(text, { size: 17 }), spacing: { after: 0, line: 235 } }),
        ],
      })],
    })],
  });
}
const CAPTURE = (t) => new Paragraph({
  children: runs('{{' + t + '}}', { size: 16 }),
  alignment: AlignmentType.CENTER,
  spacing: { before: 60, after: 120 },
});
const GAP = (h = 90) => new Paragraph({ text: '', spacing: { after: h } });
const STEP = (n, t) => [
  new Paragraph({
    children: [new TextRun({ text: 'ÉTAPE ' + n, font: SANS, bold: true, size: 13, color: ACCENT, characterSpacing: 25 })],
    spacing: { before: 180, after: 30 }, keepNext: true,
  }),
  new Paragraph({
    children: [new TextRun({ text: t, font: SANS, bold: true, size: 19, color: INK })],
    spacing: { after: 60 }, keepNext: true,
  }),
];

const foot = () => new Footer({
  children: [new Paragraph({
    alignment: AlignmentType.RIGHT,
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 6 } },
    children: [
      new TextRun({ text: 'Document interne          ', font: SANS, size: 13, color: MUTED }),
      new TextRun({ children: ['Page ', PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], font: SANS, size: 13, color: MUTED }),
    ],
  })],
});
const pageProps = {
  page: { size: { width: 11906, height: 16838 }, margin: { top: 880, right: 1021, bottom: 780, left: 1021 } },
};

/* ================= PROCÉDURE 1 — LYRECO ================= */
const P1 = [];
P1.push(EYEBROW('PROCÉDURE INTERNE'));
P1.push(TITLE('Commander sur le webshop Lyreco'));
P1.push(LEDE("Mode opératoire à l'usage des centres : passer une commande, la suivre, réceptionner la livraison et traiter les anomalies."));
P1.push(META([['Version', '1.0'], ['Diffusion', 'centres, DR, siège']]));

P1.push(H2('1', 'Mémento'));
P1.push(RULE('R1', "**Regrouper les besoins du centre**, hors urgence justifiée."));
P1.push(RULE('R2', "**Vérifier le compte actif** avant de remplir le panier : il détermine l'adresse de livraison."));
P1.push(RULE('R3', "Renseigner la **référence interne**, le nom du contact et un **téléphone joignable** au moment de valider."));

P1.push(H2('2', 'Se connecter, choisir le bon compte et constituer le panier'));
P1.push(P("Connectez-vous sur `www.lyreco.com/webshop`, espace `Utilisateur`."));
P1.push(P("Le bandeau en haut de l'écran affiche le compte actif : `Compte : 4765875 · AUDIKA · C0092 · 1 rue du Général Fauconnet · 21000 DIJON`. Vérifiez qu'il correspond bien au centre à livrer. Pour en changer :"));
P1.push(NUM("Cliquer sur `Changer de compte`.", 'n1'));
P1.push(NUM("Déplier la hiérarchie, ou saisir le numéro dans `Chercher un numéro de compte` puis `Chercher` le compte concerné.", 'n1'));
P1.push(NUM("Le centre concerné est désigné par deux numéros distincts : le premier correspond au numéro client Lyreco, et le second au numéro interne Audika.", 'n1'));
P1.push(P("Une fois le bon compte affiché, ajoutez les produits en les recherchant par mot-clé ou par référence dans le catalogue."));

P1.push(H2('3', 'Valider la commande'));
P1.push(NUM("Dans le panier : `Afficher`, puis `Voir et valider la commande`.", 'n2'));
P1.push(NUM("`Suivant` pour accéder aux informations de livraison : adresse, nom du contact du centre, téléphone joignable par le chauffeur.", 'n2'));
P1.push(NUM("Renseigner la référence interne, puis confirmer. Un e-mail de confirmation vous parvient avec le numéro de commande et la date de livraison estimée.", 'n2'));

P1.push(H2('4', 'Suivre la commande'));
P1.push(P("`Commandes en cours` affiche les commandes transmises et celles en attente de validation ; `Mon historique de commande` permet de rechercher par numéro, date ou produit. Le lien de suivi figure dans l'e-mail de confirmation."));

P1.push(H2('5', 'Anomalies et retours'));
P1.push(table(['Situation', 'Ce que vous faites'], [
  ['Produit manquant, colis non livré', 'Réserve sur le BL, puis appel au Service Clients avec le n° de commande et le n° de BL'],
  ['Produit cassé ou détérioré', "Photos, conservation de l'emballage, déclaration"],
  ['Erreur de référence livrée', "Demande d'échange : reprise par un chauffeur Lyreco"],
], cols([0.34, 0.66])));

P1.push(H2('6', 'Qui contacter'));
P1.push(table(null, [
  ['Livraison, retour, échange, SAV', 'Service Clients Lyreco — 0825 09 08 07 (0,15 €/min + prix appel), ou `Contactez-nous` depuis le webshop'],
  ['Ingénieure Commerciale Régionale dédiée', 'Celine QUESNEL — 06 32 54 66 41 — celine.quesnel@lyreco.com'],
  ['Écart de facturation', 'Comptabilité fournisseurs — facture@audika.com'],
], cols([0.34, 0.66])));

/* ================= PROCÉDURE 2 — CLOISONS MOBILES ================= */
const P2 = [];
P2.push(EYEBROW('PROCÉDURE INTERNE'));
P2.push(TITLE('Déverrouillage et manutention des cloisons mobiles'));
P2.push(LEDE("Mode opératoire pour replier, déplacer et remiser les murs de cloisons mobiles d'une salle de réunion, dans l'ordre imposé par le plan d'implantation."));
P2.push(META([['Version', '1.0'], ['Site', '{{à compléter}}'], ['Diffusion', 'services généraux']]));

P2.push(H2('1', 'Plan, outillage et prérequis'));
P2.push(P("Avant toute manipulation, se référer au plan d'implantation ci-dessous pour identifier les zones d'intervention."));
P2.push(new Paragraph({
  children: [new ImageRun({ data: fs.readFileSync('plan.jpg'), type: 'jpg', transformation: { width: 500, height: 707 } })],
  alignment: AlignmentType.CENTER, spacing: { before: 60, after: 40 },
}));
P2.push(new Paragraph({
  children: [new TextRun({ text: "Plan d'implantation — les pastilles rouges numérotées repèrent les six zones de cloisons mobiles.", font: SANS, size: 14, color: MUTED })],
  alignment: AlignmentType.CENTER, spacing: { after: 140 },
}));

P2.push(H3("Ordre d'ouverture"));
P2.push(P("Il est **strictement impératif** de suivre l'ordre d'ouverture des murs de cloisons indiqué par les pastilles rouges numérotées sur le plan, en procédant chronologiquement de la zone 1 jusqu'à la zone 6."));
P2.push(new Paragraph({
  children: [
    new TextRun({ text: 'ORDRE IMPOSÉ    ', font: SANS, size: 13, bold: true, color: MUTED, characterSpacing: 25 }),
    new TextRun({ text: 'Zone 1  →  Zone 2  →  Zone 3  →  Zone 4  →  Zone 5  →  Zone 6', font: SANS, size: 18, bold: true, color: ACCENT }),
  ],
  spacing: { after: 130 },
}));
P2.push(H3('Outillage'));
P2.push(P("Manivelle de manœuvre extractible."));

P2.push(H2('2', 'Protocole opératoire de déverrouillage'));
P2.push(...STEP(1, 'Libération du module télescopique (compensateur final)'));
P2.push(P("Pour chaque zone, en suivant l'ordre de 1 à 6, le repli de la cloison doit impérativement débuter par le module télescopique."));
P2.push(BUL("Localiser le panneau télescopique situé en extrémité de cloison."));
P2.push(BUL("Insérer la manivelle de commande dans l'orifice situé sur la face frontale du panneau."));
P2.push(BUL("Actionner la manivelle afin de rétracter simultanément le compensateur vertical (course jusqu'à 120 mm) et les plinthes d'étanchéité supérieure et inférieure."));
P2.push(...STEP(2, 'Déverrouillage des modules standards et des portes'));
P2.push(P("Une fois le module télescopique dégagé, procéder séquentiellement avec les panneaux adjacents."));
P2.push(BUL("Insérer la manivelle sur le chant (la tranche) de chaque panneau standard."));
P2.push(BUL("Effectuer la rotation pour rétracter les plinthes télescopiques haute et basse en aluminium (course de 25 mm)."));
P2.push(BUL("S'assurer visuellement et physiquement que le panneau est totalement désolidarisé du sol avant d'initier tout mouvement latéral."));
P2.push(...STEP(3, 'Translation et remisage'));
P2.push(BUL("Les éléments étant suspendus de manière indépendante par des chariots à roulements radiaux, la translation doit s'effectuer sans à-coups."));
P2.push(BUL("Faire glisser les modules individuellement le long du rail de guidage plafonnier."));
P2.push(BUL("Acheminer les panneaux vers leur zone de remisage (parking) désignée sur le plan d'implantation du site."));
P2.push(BUL("Empiler les éléments selon le calepinage prévu afin d'éviter tout encombrement ou détérioration des finitions."));
P2.push(GAP(120));
P2.push(note('Point critique', "L'infrastructure ne comporte **aucun rail au sol** : les panneaux sont suspendus au rail plafonnier. Aucun mouvement latéral ne doit être engagé tant que le panneau n'est pas totalement désolidarisé du sol.", 'stop'));


/* ================= PROCÉDURE 3 — GESTION DES ACCÈS ================= */
const P3 = [];
P3.push(EYEBROW('PROCÉDURE INTERNE'));
P3.push(TITLE('Gestion des accès au siège social'));
P3.push(LEDE("Créer, enrôler et révoquer les badges qui sécurisent l'accès des collaborateurs aux différentes zones du bâtiment."));
P3.push(META([['Version', '1.0'], ['Site', 'siège social'], ['Diffusion', 'services généraux']]));

P3.push(H2('1', 'Objet et contact'));
P3.push(P("L'objectif principal est de créer et délivrer les badges pour sécuriser l'accès des collaborateurs aux différentes zones du bâtiment. La procédure couvre trois opérations : la création d'une étiquette, la création et l'enrôlement du badge, la suppression et la révocation d'un accès."));
P3.push(P("Contact : **Sébastien Bourbon**, responsable des services généraux — {{numéro à compléter}}"));

P3.push(H2('2', "Création d'une étiquette"));
P3.push(P("{{mode opératoire à rédiger}}"));

P3.push(H2('3', "Création et enrôlement du badge"));

P3.push(...STEP(1, 'Connexion au système VISOR'));
P3.push(BUL("Se rendre physiquement sur le PC situé dans la salle serveur, au 3ᵉ étage."));
P3.push(BUL("Ouvrir le logiciel VISOR, qui centralise la gestion des badges d'accès."));
P3.push(BUL("Saisir le code d'authentification pour entrer dans le logiciel."));
P3.push(CAPTURE("capture à insérer : icône VISOR"));

P3.push(...STEP(2, "Création de l'utilisateur et convention de nommage"));
P3.push(P("Dans le menu principal de VISOR, cliquer sur `Utilisateurs` puis sur `Ajouter` (ou `Créer des utilisateurs` pour lancer l'assistant). Dans l'onglet `Identité`, appliquer strictement le format suivant :"));
P3.push(BUL("**Champ Nom** : NOM Prénom (4 initiales Teams). Les initiales exactes se récupèrent dans Microsoft Teams. Exemple : DUPONT Jean (JDSE)."));
P3.push(BUL("**Champ Prénom** : saisir le numéro de la carte, figurant sur le badge."));
P3.push(CAPTURE("capture à insérer : Teams et création de la fiche"));

P3.push(...STEP(3, 'Création du badge (identifiants)'));
P3.push(P("Toujours dans la fiche de l'utilisateur, se rendre dans l'onglet `Identifiants` et cliquer sur `Ajouter` : seuls les identifiants **non attribués** apparaissent, un badge ne pouvant être associé qu'à un seul utilisateur. Deux méthodes permettent d'associer un badge vierge."));
P3.push(H3('Option A — mode apprentissage'));
P3.push(BUL("Dans la fenêtre d'ajout d'identifiant, cliquer sur l'option `Apprentissage`."));
P3.push(BUL("Prendre le badge vierge."));
P3.push(BUL("Passer le badge sur le lecteur du contrôle d'accès situé juste devant la porte de la salle serveur."));
P3.push(BUL("Le système lit et enregistre le numéro automatiquement."));
P3.push(BUL("Sélectionner le type d'identifiant approprié et vérifier que le statut est bien sur `En service` — les autres valeurs possibles étant `Suspendu` et `Volé` — avant de valider."));
P3.push(H3('Option B — saisie via les logs de passage'));
P3.push(BUL("Prendre le badge vierge et le badger sur le lecteur situé juste devant la porte."));
P3.push(BUL("Dans VISOR, afficher la liste des évènements en bas de l'écran via `Affichage › Liste des évènements`, onglet `Évènement`. Cette liste ne contient que les évènements survenus depuis le démarrage du logiciel ; sinon passer par `Évènements › Voir la liste`, qui donne les 2 000 derniers."));
P3.push(BUL("Repérer l'événement de refus d'accès et copier l'UUID du badge, un identifiant d'environ 10 chiffres."));
P3.push(BUL("Coller cet UUID dans le champ identifiant de la nouvelle fiche."));

P3.push(...STEP(4, 'Profil, autorisations et permissions'));
P3.push(BUL("Se rendre dans l'onglet `Autorisations` de la fiche utilisateur."));
P3.push(BUL("Dans la section dédiée aux groupes d'accès, cliquer sur `Ajouter`."));
P3.push(BUL("Double-cliquer sur le groupe correspondant à la personne et à son statut pour l'attribuer. Un utilisateur peut cumuler jusqu'à dix groupes d'accès."));
P3.push(GAP(70));
P3.push(note('Règle impérative', "Ne jamais présumer des permissions à accorder. En cas de doute, demander validation au responsable des services généraux.", 'stop'));
P3.push(CAPTURE("capture à insérer : onglet Autorisations"));

P3.push(...STEP(5, 'Vérification et remise en main propre'));
P3.push(BUL("Une fois la programmation terminée et la fiche validée par `OK`, tester personnellement le badge sur un lecteur pour vérifier que les accès sont valides."));
P3.push(BUL("Insérer le badge validé dans sa protection plastique."));
P3.push(BUL("Procéder obligatoirement à la remise en main propre du badge à l'utilisateur."));

P3.push(H2('4', "Suppression et révocation d'un accès"));
P3.push(P("Ouvrir `Utilisateurs › Utilisateurs`, sélectionner la fiche du collaborateur concerné et cliquer sur `Supprimer`. Confirmer la suppression, puis répondre à la seconde question : VISOR demande si les identifiants rattachés doivent être supprimés eux aussi. Répondre **oui** pour un départ définitif, **non** pour réattribuer le badge à quelqu'un d'autre."));
P3.push(CAPTURE("capture à insérer : suppression d'une fiche"));

/* ================= GÉNÉRATION ================= */
const numbering = {
  config: [
    { reference: 'puces', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 400, hanging: 240 } } } }] },
    ...['n1', 'n2'].map((ref) => ({
      reference: ref,
      levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 400, hanging: 240 } } } }],
    })),
  ],
};

function build(children, title, file) {
  const doc = new Document({
    creator: 'Services Généraux Audika', title, description: 'Procédure interne',
    numbering,
    styles: { default: { document: { run: { font: SERIF, size: BODY, color: INK } } } },
    sections: [{ properties: pageProps, footers: { default: foot() }, children }],
  });
  return Packer.toBuffer(doc).then((buf) => {
    fs.writeFileSync(file, buf);
    console.log(file, '—', Math.round(buf.length / 1024), 'Ko');
  });
}

build(P1, 'Commander sur le webshop Lyreco', 'PRO-ACH-001_Commander_sur_le_webshop_Lyreco.docx')
  .then(() => build(P2, 'Déverrouillage et manutention des cloisons mobiles', 'PRO-SG-002_Cloisons_mobiles.docx'))
  .then(() => build(P3, 'Gestion des accès au siège social', 'PRO-SG-003_Gestion_des_acces_au_siege.docx'));
