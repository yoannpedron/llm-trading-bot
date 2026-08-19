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
  spacing: { after: o.after == null ? 75 : o.after, line: o.line || 245 },
  indent: o.indent,
  alignment: o.align,
});
const SMALL = (t) => P(t, { size: 16, color: MUTED, after: 100 });

const EYEBROW = (t) => new Paragraph({
  children: [new TextRun({ text: t, font: SANS, size: 15, bold: true, color: ACCENT, characterSpacing: 30 })],
  spacing: { after: 70 },
});
const TITLE = (t) => new Paragraph({
  children: [new TextRun({ text: t, font: SANS, size: 40, bold: true, color: INK })],
  spacing: { after: 70 }, keepNext: true,
});
const LEDE = (t) => new Paragraph({
  children: [new TextRun({ text: t, font: SERIF, size: 21, color: MUTED, italics: true })],
  spacing: { after: 110, line: 250 },
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
  spacing: { before: 180, after: 75 },
  border: { top: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 8 } },
});
const H3 = (t) => new Paragraph({
  children: [new TextRun({ text: t, font: SANS, size: 18, bold: true, color: INK })],
  keepNext: true, spacing: { before: 100, after: 45 },
});

const BUL = (t) => new Paragraph({
  children: runs(t), numbering: { reference: 'puces', level: 0 },
  spacing: { after: 45, line: 250 },
});
const NUM = (t, ref) => new Paragraph({
  children: runs(t), numbering: { reference: ref, level: 0 },
  spacing: { after: 45, line: 250 },
});
const RULE = (k, t) => new Paragraph({
  children: [new TextRun({ text: k + '   ', font: SANS, size: 17, bold: true, color: ACCENT }), ...runs(t, { size: 18 })],
  spacing: { after: 55, line: 240 },
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

/* ================= PROCÉDURE 1 — LYRECO ================= */
const P1 = [];
P1.push(EYEBROW('PROCÉDURE INTERNE · PRO-ACH-001'));
P1.push(TITLE('Commander sur le webshop Lyreco'));
P1.push(LEDE("Mode opératoire à l'usage des centres : passer une commande, la suivre, réceptionner la livraison et traiter les anomalies."));
P1.push(META([['Version', '1.0'], ['Application', '{{à compléter}}'], ['Diffusion', 'centres, DR, siège'],
              ['Révision', 'annuelle'], ['Contact', '{{service achats}}']]));

P1.push(H2('1', 'Ce que couvre cette procédure'));
P1.push(P("Tout achat de fournitures de fonctionnement passé sur le webshop Lyreco : papier, cartouches et toners, fournitures de bureau, hygiène et entretien, alimentation et réception, EPI, emballage, petit équipement de bureau."));
P1.push(P("**Ne passent pas par Lyreco** : le matériel médical et audiologique, l'informatique gérée par la DSI, le mobilier et les aménagements au-delà de {{seuil à compléter}}. Ces demandes sont adressées au service achats."));

P1.push(H2('2', 'Les six règles à respecter'));
P1.push(RULE('R1', "Regrouper les besoins du centre : **une commande par** {{période à compléter}}, hors urgence justifiée."));
P1.push(RULE('R2', "**75 € HT minimum** par commande : c'est le seuil de la livraison gratuite. En dessous, des frais de port sont facturés."));
P1.push(RULE('R3', "Commander **dans le mini-catalogue et les listes de favoris**, qui contiennent les produits négociés. Besoin hors catalogue : passer par le service achats."));
P1.push(RULE('R4', "**Vérifier le compte actif** avant de remplir le panier : il détermine l'adresse de livraison et l'imputation de la dépense."));
P1.push(RULE('R5', "Renseigner la **référence interne**, le nom du contact et un **téléphone joignable** au moment de valider."));
P1.push(RULE('R6', "Signaler toute **anomalie de livraison sous 48 heures**, réserves portées sur le bon de livraison."));
P1.push(SMALL("Le webshop est réservé à un usage professionnel. Les identifiants sont personnels et ne se partagent pas : chaque commande est nominative."));

P1.push(H2('3', 'Se connecter et choisir le bon compte'));
P1.push(P("Connectez-vous sur `www.lyreco.com/webshop`, espace `Utilisateur`. L'identifiant est votre numéro de compte suivi de vos initiales, par exemple `4765875XY`. Mot de passe oublié : lien de réinitialisation sur la page de connexion."));
P1.push(P("Le bandeau en haut de l'écran affiche le compte actif : `Compte : 4765875 · AUDIKA · C0092 · 21000 DIJON`. Vérifiez qu'il correspond bien au centre à livrer. Pour en changer :"));
P1.push(NUM("Cliquer sur `Changer de compte`.", 'n1'));
P1.push(NUM("Déplier la hiérarchie, ou saisir le numéro dans `Chercher un numéro de compte` puis `Chercher`.", 'n1'));
P1.push(NUM("Sur la ligne du centre — **affichée en bleu** — cliquer sur `Sélectionner`, puis contrôler le bandeau.", 'n1'));
P1.push(P("Dans la hiérarchie, les libellés en **noir** sont des niveaux d'organisation (administrateur, siège, réseau, direction régionale) : ils ne reçoivent pas de livraison. Seuls les libellés en **bleu** sont des adresses de livraison et peuvent commander."));
P1.push(note('Message bloquant', "« Vous êtes connecté sur un compte qui ne peut pas commander » : vous êtes sur un niveau d'organisation, pas sur un centre. Ce n'est pas une panne — basculez via `Changer de compte`.", 'stop'));
P1.push(GAP(70));
P1.push(note('Point de vigilance', "Changer de compte en cours de commande vide ou recalcule le panier : tarifs, catalogue et budgets sont propres à chaque compte. Choisissez le compte //avant// de remplir le panier.", 'warn'));

P1.push(H2('4', 'Constituer le panier'));
P1.push(H3('a. Listes de favoris — voie à privilégier'));
P1.push(P("`Mes favoris › Produits préférés` : les listes partagées du réseau contiennent les produits validés par le siège. Ouvrez la liste, saisissez les quantités, ajoutez au panier."));
P1.push(H3('b. Commande rapide — pour un réassort connu'));
P1.push(P("`Commande rapide` (icône chronomètre à droite de la barre de recherche) : `Via les références produits` pour saisir directement les références et les quantités, ou `Via un fichier` pour importer un fichier Excel/CSV."));
P1.push(H3('c. Catalogue et recherche'));
P1.push(P("Recherche par mot-clé ou par référence. Pour les consommables d'impression, l'`Outil de recherche de cartouche` donne la référence exacte à partir du modèle d'imprimante. Une commande passée peut être rejouée depuis `Mon historique de commande`."));
P1.push(P("Un panier peut être préparé puis repris plus tard : `Mettre la commande en attente`, avec un titre explicite (//C0092 – réappro mars//). Utilisez-le pendant la collecte des besoins du centre plutôt que de multiplier les petites commandes."));
P1.push(note('Point de vigilance', "Contrôlez l'**unité de vente** : boîte de 100, lot de 12, carton de 5 ramettes. La quantité saisie porte sur le conditionnement affiché, pas sur l'unité. C'est la première cause de sur-commande.", 'warn'));

P1.push(H2('5', 'Valider la commande'));
P1.push(NUM("Dans le panier : `Afficher`, puis `Voir mes offres et valider ma commande`.", 'n2'));
P1.push(NUM("`Suivant` pour accéder aux informations de livraison : adresse, nom du contact du centre, téléphone joignable par le chauffeur.", 'n2'));
P1.push(NUM("Renseigner la référence interne, puis confirmer. Un e-mail de confirmation vous parvient avec le numéro de commande et la date de livraison estimée.", 'n2'));
P1.push(P("Commande validée avant 18 h : livraison le lendemain dans 99 % des cas."));
P1.push(P("Si le message « **reçu, en attente de validation** » s'affiche, la commande n'est pas encore partie chez Lyreco : elle attend votre valideur, qui reçoit un e-mail et peut la valider, la modifier ou la refuser. Ce contrôle se déclenche en cas de dépassement de budget, de produit signalé comme //contrôlé//, ou selon votre profil. Délai de traitement attendu : {{à compléter}} — au-delà, relancez votre valideur."));

P1.push(H2('6', 'Suivre la commande'));
P1.push(P("`Commandes en cours` affiche les commandes transmises et celles en attente de validation ; `Mon historique de commande` permet de rechercher par numéro, date ou produit. Le lien de suivi figure dans l'e-mail de confirmation."));
P1.push(P("Une modification ou une annulation doit être demandée **immédiatement** au Service Clients Lyreco. Une fois la préparation lancée, elle relève d'un retour."));

P1.push(H2('7', 'Réceptionner la livraison'));
P1.push(NUM("**Avant de signer** : compter les colis et comparer avec le bon de livraison (BL).", 'n3'));
P1.push(NUM("**Colis abîmé** : le refuser, ou porter une réserve écrite //précise// sur le BL — « carton n° 2 éventré, contenu à vérifier ». La mention « sous réserve de déballage » n'a aucune valeur.", 'n3'));
P1.push(NUM("**Après déballage** : contrôler références et quantités ligne à ligne, photographier tout produit manquant, cassé ou non conforme.", 'n3'));
P1.push(NUM("**Livraison sans contact** : pas de signature, la preuve est une photo du lieu de dépose et le nom du réceptionnaire.", 'n3'));
P1.push(NUM("**Conserver le BL** : il est exigé pour toute réclamation et tout retour.", 'n3'));

P1.push(H2('8', 'Anomalies et retours'));
P1.push(table(['Situation', 'Ce que vous faites', 'Délai'], [
  ['Produit manquant, colis non livré', 'Réserve sur le BL, puis appel au Service Clients avec le n° de commande et le n° de BL', '48 h'],
  ['Produit cassé ou détérioré', "Photos, conservation de l'emballage, déclaration", '48 h'],
  ['Erreur de référence livrée', "Demande d'échange : reprise par un chauffeur Lyreco", '48 h'],
  ['Produit inutile ou erreur de saisie', "Demande de reprise : produit non utilisé, non marqué, emballage d'origine intact, copie du BL jointe", '30 jours'],
  ['Écart sur la facture', "Rapprochement facture / BL / commande, puis demande d'avoir", 'À réception'],
], cols([0.295, 0.545, 0.160])));
P1.push(GAP(80));
P1.push(P("La reprise est gratuite dans les **30 jours** suivant la livraison. Passé ce délai, aucun retour ni avoir n'est possible. Certains produits ne sont pas retournables : articles personnalisés, denrées alimentaires, produits d'hygiène ouverts."));

P1.push(H2('9', 'Retrouver vos documents'));
P1.push(P("`Mon Espace › Mes documents` donne accès aux bons de livraison, aux **BL émargés** (preuve de réception), aux factures et avoirs, et à la liste de prix. Recherchez par numéro de livraison, de commande ou par période, sélectionnez les documents puis cliquez sur `Demande` : ils arrivent en PDF par e-mail. Les BL émargés sont aussi accessibles depuis `Mon historique de commande`, en ouvrant la commande puis `Voir les BL émargés`."));

P1.push(H2('10', 'Que faire si…'));
P1.push(table(['Symptôme', 'Cause', 'Solution'], [
  ["Les prix ne s'affichent pas", "Compte positionné sur un niveau d'organisation", '`Changer de compte` vers le centre (ligne bleue)'],
  ['Alerte budget à la validation', 'Montant supérieur au budget du compte', 'Réduire le panier ou justifier auprès du valideur'],
  ['Un produit connu est introuvable', 'Article hors mini-catalogue', 'Demande au service achats, sans contourner par une référence approchante'],
  ['La commande reste en attente de validation', 'Valideur non intervenu', "Le relancer : rien n'est parti chez Lyreco"],
  ['Livraison arrivée dans un autre centre', 'Mauvais compte actif à la validation', 'Prévenir les deux centres et le service achats (règle R4)'],
  ['Panier vidé après un changement de compte', 'Le panier est propre à chaque compte', "Choisir le compte d'abord, utiliser la mise en attente"],
], cols([0.305, 0.305, 0.390])));

P1.push(H2('11', 'Qui contacter'));
P1.push(table(null, [
  ['Livraison, retour, échange, SAV', 'Service Clients Lyreco — 0825 09 08 07 (0,15 €/min + prix appel), ou `Contactez-nous` depuis le webshop'],
  ['Accès, mot de passe, droits', 'Administrateur webshop — {{nom et e-mail à compléter}}'],
  ['Besoin hors catalogue, question sur la procédure', 'Service achats — {{nom et e-mail à compléter}}'],
  ['Écart de facturation', 'Comptabilité fournisseurs — {{à compléter}}'],
], cols([0.375, 0.625])));
P1.push(GAP(110));
P1.push(new Paragraph({
  children: [new TextRun({ text: 'CHECK-LIST AVANT DE VALIDER', font: SANS, bold: true, size: 14, color: ACCENT, characterSpacing: 25 })],
  spacing: { before: 60, after: 70 },
  border: { top: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 6 } },
}));
const CHECKS = [
  "Le compte affiché est celui du centre à livrer.", "Montant supérieur ou égal à 75 € HT.",
  "Les besoins du centre sont regroupés.", "Budget respecté, ou dépassement justifié.",
  "Références, unités de vente et quantités vérifiées.", "Référence interne, contact et téléphone renseignés.",
  "Produits issus du mini-catalogue ou des favoris.", "Commande passée avant 18 h si livraison attendue le lendemain.",
];
const NB = { style: BorderStyle.NONE };
P1.push(new Table({
  columnWidths: cols([0.5, 0.5]), width: { size: CW, type: WidthType.DXA },
  borders: { top: NB, bottom: NB, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB },
  rows: [0, 1, 2, 3].map((i) => new TableRow({
    children: [CHECKS[i * 2], CHECKS[i * 2 + 1]].map((t) => new TableCell({
      width: { size: cols([0.5, 0.5])[0], type: WidthType.DXA },
      margins: { top: 20, bottom: 20, left: 0, right: 140 },
      children: [CHECK(t)],
    })),
  })),
}));

/* ================= PROCÉDURE 2 — CLOISONS MOBILES ================= */
const P2 = [];
P2.push(EYEBROW('PROCÉDURE INTERNE · PRO-SG-002'));
P2.push(TITLE('Déverrouillage et manutention des cloisons mobiles'));
P2.push(LEDE("Mode opératoire pour replier, déplacer et remiser les murs de cloisons mobiles d'une salle de réunion, dans l'ordre imposé par le plan d'implantation."));
P2.push(META([['Version', '1.0'], ['Application', '{{à compléter}}'], ['Site', '{{à compléter}}'],
              ['Révision', 'annuelle'], ['Contact', '{{services généraux}}']]));

P2.push(H2('1', 'Plan, outillage et prérequis'));
P2.push(P("Avant toute manipulation, se référer au plan d'implantation ci-dessous pour identifier les zones d'intervention."));
P2.push(new Paragraph({
  children: [new ImageRun({
    data: fs.readFileSync('plan.jpg'), type: 'jpg',
    transformation: { width: 500, height: 707 },
  })],
  alignment: AlignmentType.CENTER,
  spacing: { before: 60, after: 40 },
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

/* ================= DOCUMENT ================= */
const numbering = {
  config: [
    { reference: 'puces', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 400, hanging: 240 } } } }] },
    ...['n1', 'n2', 'n3'].map((ref) => ({
      reference: ref,
      levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 400, hanging: 240 } } } }],
    })),
  ],
};

const foot = (ref, owner) => new Footer({
  children: [new Paragraph({
    alignment: AlignmentType.RIGHT,
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 6 } },
    children: [
      new TextRun({ text: ref + '  ·  ' + owner + '          ', font: SANS, size: 13, color: MUTED }),
      new TextRun({ children: ['Page ', PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], font: SANS, size: 13, color: MUTED }),
    ],
  })],
});
const pageProps = {
  page: { size: { width: 11906, height: 16838 }, margin: { top: 964, right: 1021, bottom: 850, left: 1021 } },
};

const doc = new Document({
  creator: 'Services Généraux Audika',
  title: 'Procédures — Services Généraux Audika',
  description: 'Recueil de procédures internes',
  numbering,
  styles: { default: { document: { run: { font: SERIF, size: BODY, color: INK } } } },
  sections: [
    { properties: pageProps, footers: { default: foot('PRO-ACH-001 · Commander sur le webshop Lyreco', 'Document interne') }, children: P1 },
    { properties: pageProps, footers: { default: foot('PRO-SG-002 · Cloisons mobiles', 'Propriété exclusive des Services Généraux Audika') }, children: P2 },
  ],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync('Procedures_Services_Generaux_Audika.docx', buf);
  console.log('OK —', Math.round(buf.length / 1024), 'Ko');
});
