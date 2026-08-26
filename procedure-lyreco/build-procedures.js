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


/* ================= PROCÉDURE 4 — COURRIER ================= */
const P4 = [];
P4.push(EYEBROW('PROCÉDURE INTERNE'));
P4.push(TITLE('Gestion du courrier, des plis et des colis'));
P4.push(LEDE("Réception, tri, distribution et expédition du courrier et des colis au siège social, poste d'accueil des services généraux."));
P4.push(META([['Version', '1.0'], ['Site', 'siège social'], ['Diffusion', 'accueil et services généraux']]));

P4.push(H2('1', 'Rythme de la journée'));
P4.push(table(['Horaire', 'Ce qui est attendu'], [
  ['9h00 – 9h30', "Récupérer le courrier à l'accueil principal"],
  ['9h30 et 11h30', 'Passages du matin à l’accueil principal'],
  ['10h30 – 11h00', 'Courrier trié, tamponné et distribué dans les bannettes'],
  ['15h00 et 16h00', "Passages de l'après-midi, dépôt du courrier au départ"],
  ['Avant 16h00', "Pochette Affranchigo déposée à l'accueil principal"],
  ['Fin de journée', 'Plis et colis non récupérés rangés dans le local des services généraux'],
], cols([0.24, 0.76])));

P4.push(H2('2', "Courrier à l'arrivée"));
P4.push(BUL("Récupérer le courrier à l'accueil principal entre 9h00 et 9h30."));
P4.push(BUL("Trier et **tamponner** le courrier, en ajoutant les preuves de dépôt (avis de réception) à la date du jour."));
P4.push(BUL("Répartir en deux catégories : **nominatif** et **non nominatif** portant un nom de service."));
P4.push(BUL("Un courrier qui n'est ni l'un ni l'autre est ouvert pour identifier le destinataire, qui est ensuite prévenu."));
P4.push(BUL("Déposer le courrier dans les bannettes prévues, **avant 10h30 – 11h00**, et prévenir les personnes concernées par Teams."));
P4.push(BUL("Les courriers publicitaires ne sont pas distribués : ils sont jetés."));
P4.push(GAP(60));
P4.push(note('Ne jamais ouvrir', "Ces courriers sont tamponnés puis transmis tels quels : service **conformité**, service **RH**, mention **« confidentiel »**, **recommandé retour expéditeur**, plis de la **Direction Partenaire et Affaires Publiques**.", 'stop'));

P4.push(H2('3', "Plis et colis à l'arrivée"));
P4.push(BUL("L'accueil principal signale l'arrivée d'un pli ou d'un colis. Descendre le chercher, puis prévenir le collaborateur par Teams — un message type est disponible."));
P4.push(BUL("**Enregistrer systématiquement dans Welcome by** : date, heure, nombre d'expéditions et destinataire, personne prévenue, prise en charge (date et heure)."));
P4.push(BUL("Le pli peut être conservé une journée au service généraux. En fin de journée, relancer par Teams les collaborateurs qui ne sont pas venus, puis déposer les plis restants dans le local prévu."));
P4.push(H3('Remise au destinataire'));
P4.push(BUL("Rechercher le pli par le nom du destinataire dans Welcome by, puis cliquer sur `Remettre`."));
P4.push(BUL("Toute remise se fait **contre code sécurisé et signature** : le destinataire communique le code reçu par mail, saisir ce code puis `Vérifier le code`."));
P4.push(BUL("Si l'option est activée, inviter le collaborateur à signer via le lien reçu dans son mail. La confirmation affichée autorise la remise."));
P4.push(BUL("Si une autre personne que le destinataire se présente, prévenir le destinataire par mail avant de remettre le pli."));
P4.push(BUL("Ne pas oublier de **changer le statut dans Welcome by** une fois le pli récupéré."));
P4.push(H3('Colis particuliers'));
P4.push(BUL("**Colis abîmé** : vérifier l'état avant d'accepter. Si le colis est endommagé, le prendre en photo, le refuser et informer le responsable des services généraux par mail."));
P4.push(BUL("**Colis lourd ou volumineux** : utiliser le chariot prévu et l'ascenseur de service, sans passer par le hall principal. Contacter le destinataire, qui vient le réceptionner."));
P4.push(BUL("**Colis non nominatif** : {{règle à trancher avec les services généraux}}"));

P4.push(H2('4', "Plis d'huissier"));
P4.push(P("Un pli d'huissier est un acte juridique remis par un huissier de justice : assignation, sommation de payer, signification d'une décision. L'accueil principal appelle, le pli est récupéré puis déposé dans la bannette **Direction Générale**."));
P4.push(note('Traçabilité obligatoire', "Tout pli d'huissier est enregistré dans Welcome by, sans exception.", 'warn'));

P4.push(H2('5', 'Courrier, plis et colis au départ'));
P4.push(BUL("Le courrier simple et les **LRAR** sont placés dans la pochette **Affranchigo** et déposés à l'accueil principal **avant 16h00**. À défaut de pochette Affranchigo, utiliser une pochette rose portant la mention « Affranchigo »."));
P4.push(BUL("**Tous les LRAR**, à l'arrivée comme au départ, sont notés dans Welcome by."));
P4.push(BUL("La navette interne récupère les colis au départ plusieurs fois par semaine. Déposer les plis à côté du bureau, **sans les mélanger avec les plis à l'arrivée**."));
P4.push(H3('Enregistrer un départ dans Welcome by'));
P4.push(BUL("Cliquer sur `Expédition d'un colis` et remplir les champs requis."));
P4.push(BUL("Cocher `préparé` si le pli ne demande aucune préparation ultérieure ; sinon le faire depuis la liste une fois la préparation terminée."));
P4.push(BUL("Cliquer sur `expédier` au moment de la remise au transporteur."));

P4.push(H2('6', 'Cas particuliers et interlocuteurs'));
P4.push(BUL("**Flotte automobile et contraventions** : mettre ce courrier de côté dès l'arrivée et le traiter l'après-midi, **le jour même**, selon la procédure dédiée (scan, envoi à OOVOOM, originaux classés et conservés trois mois)."));
P4.push(BUL("**Courrier adressé au responsable des services généraux** : déposé sur son bureau, avec information directe si nécessaire."));
P4.push(BUL("**Direction Générale et membres de la Direction** : passer par l'assistante, **Mme Marjorie Grand**."));
P4.push(BUL("**En cas de difficulté sur un courrier** : solliciter le responsable des services généraux."));


/* ================= PROCÉDURE 5 — WELCOME BY ================= */
const P5 = [];
P5.push(EYEBROW('PROCÉDURE INTERNE'));
P5.push(TITLE('Welcome by : visiteurs, plis et colis'));
P5.push(LEDE("Enregistrer et suivre dans Welcome by les visiteurs, les prestataires, les plis et colis reçus et les expéditions au départ."));
P5.push(META([['Version', '1.0'], ['Site', 'siège social'], ['Diffusion', 'accueil et services généraux']]));

P5.push(H2('1', 'Ce que Welcome by doit contenir'));
P5.push(P("Welcome by est le registre du poste d'accueil. Trois familles d'évènements y sont saisies **sans exception** :"));
P5.push(BUL("les **visiteurs et prestataires**, à leur arrivée et à leur départ ;"));
P5.push(BUL("les **plis et colis reçus**, jusqu'à leur remise au destinataire ;"));
P5.push(BUL("les **expéditions au départ**, jusqu'à la remise au transporteur."));
P5.push(P("Les **LRAR** et les **plis d'huissier** y sont enregistrés dans tous les cas, à l'arrivée comme au départ."));

P5.push(H2('2', 'Enregistrer un visiteur'));
P5.push(BUL("Ouvrir l'onglet `Visiteur`."));
P5.push(BUL("Saisir le nom de la **personne visitée** : une liste déroulante propose les noms déjà enregistrés."));
P5.push(BUL("Si le visiteur n'est pas dans la liste, cliquer sur `Ajouter une personne à l'annuaire`, saisir ses informations et valider."));
P5.push(BUL("Pour plusieurs visiteurs, cliquer sur `Nouveau visiteur` autant de fois que nécessaire, puis sur `Confirmation`."));
P5.push(BUL("Si l'adresse de la personne visitée est enregistrée, elle est prévenue automatiquement. Une autre personne peut être mise en copie ; décocher la case pour n'envoyer aucun mail."));

P5.push(H2('3', 'Suivre un prestataire'));
P5.push(P("Le prestataire est accueilli au rez-de-chaussée, accompagné pendant son intervention puis raccompagné à la sortie. Son **arrivée et son heure de départ sont enregistrées dans Welcome by** : c'est la trace de son passage sur le site."));
P5.push(P("À son départ, un compte rendu est envoyé par mail au responsable des services généraux : actions réalisées, résumé en quelques lignes, et mention indiquant si l'intervention est terminée ou si le prestataire doit revenir."));

P5.push(H2('4', "Enregistrer un pli ou un colis à l'arrivée"));
P5.push(P("Dès la récupération du pli à l'accueil principal, créer la fiche avec les informations suivantes :"));
P5.push(table(['Champ', 'Ce que vous saisissez'], [
  ['Date', "Date de réception du pli"],
  ['Heure', "Heure de réception"],
  ["Nombre d'expéditions et destinataire", "Nombre de plis reçus et nom du collaborateur"],
  ['Prévenue', "Personne prévenue, une fois le message Teams envoyé"],
  ['Prise en charge', "Date et heure de la remise, complétées au moment du retrait"],
], cols([0.34, 0.66])));
P5.push(GAP(70));
P5.push(note('Le suivi fait partie de la saisie', "Une fiche créée n'est pas une fiche terminée : le **statut doit être changé dans Welcome by** au moment où le pli est récupéré. Sans cela, les relances de fin de journée portent sur des plis déjà remis.", 'warn'));

P5.push(H2('5', 'Remettre un pli à son destinataire'));
P5.push(BUL("Rechercher le pli par le **nom du destinataire** dans la barre de recherche, puis cliquer sur `Remettre`."));
P5.push(BUL("Le destinataire communique le **code de sécurité** reçu par mail : le saisir, puis cliquer sur `Vérifier le code`."));
P5.push(BUL("Si l'option est activée, inviter le collaborateur à **signer** via le lien reçu dans son mail. La fenêtre de confirmation autorise alors la remise."));
P5.push(BUL("Si une autre personne que le destinataire se présente, le destinataire peut être prévenu par mail depuis l'outil."));

P5.push(H2('6', 'Enregistrer une expédition au départ'));
P5.push(BUL("Cliquer sur `Expédition d'un colis` et remplir les champs requis."));
P5.push(BUL("Cocher `préparé` si aucune préparation n'est nécessaire ; sinon cocher la case depuis la liste une fois la préparation faite."));
P5.push(BUL("Cliquer sur `expédier` au moment de la remise au transporteur ou à la navette interne."));
P5.push(GAP(70));
P5.push(note('Notice de l\'outil', "Une notice d'utilisation de Welcome by est communiquée par la responsable d'agence ou la responsable qualité. Cette procédure ne remplace pas cette notice : elle fixe ce qui doit être saisi sur le site.", 'info'));

/* ================= PROCÉDURE 6 — CONTRAVENTIONS / OOVOOM ================= */
const P6 = [];
P6.push(EYEBROW('PROCÉDURE INTERNE'));
P6.push(TITLE('Contraventions et courrier de la flotte automobile'));
P6.push(LEDE("Traiter les contraventions et les documents de la flotte automobile reçus par courrier, et les transmettre au prestataire OOVOOM."));
P6.push(META([['Version', '1.0'], ['Site', 'siège social'], ['Diffusion', 'accueil et services généraux']]));

P6.push(H2('1', 'Principe et délai'));
P6.push(P("À l'arrivée du courrier, **mettre de côté** les contraventions et tous les documents concernant la flotte automobile, sans les distribuer dans les bannettes. Ils sont traités **l'après-midi**."));
P6.push(note('Délai impératif', "Le traitement doit être **terminé le jour même**. Une contravention laissée en attente fait courir des majorations à la charge de l'entreprise.", 'stop'));

P6.push(H2('2', 'Numériser les documents'));
P6.push(BUL("Ouvrir le courrier et **classer les documents par date**."));
P6.push(BUL("Scanner **toutes les pages**, sans exception, document par document."));
P6.push(BUL("Toujours commencer par la première page, **tête en bas**."));
P6.push(BUL("Le petit scanner Brother se trouve sur le bureau : appuyer sur `vers le PC` sur son écran, puis sur `démarrer`."));

P6.push(H2('3', 'Renommer les fichiers'));
P6.push(BUL("**Supprimer d'abord les anciens fichiers renommés**, pour ne pas mélanger deux traitements."));
P6.push(BUL("Ouvrir le document scanné depuis le dossier `DOCUMENTS` de l'ordinateur."));
P6.push(BUL("Relever la **plaque d'immatriculation** sur le document, la copier, puis renommer le fichier selon le tableau ci-dessous."));
P6.push(table(['Type de document', 'Nom du fichier'], [
  ['Forfait post-stationnement', 'FPS + plaque immatriculation'],
  ['Avis de non-paiement', 'Avis de non-paiement + plaque immatriculation'],
  ['Carte Total', 'Carte Total + plaque immatriculation'],
  ['Carte grise', 'Carte grise + plaque immatriculation'],
], cols([0.40, 0.60])));

P6.push(H2('4', 'Transmettre à OOVOOM'));
P6.push(P("Envoyer les documents renommés par mail au service flotte automobile d'OOVOOM."));
P6.push(table(null, [
  ['Adresse mail', 'auddika@oovoom.fr'],
  ['Téléphone', '01 80 82 44 43'],
  ['Adresse postale', 'SAS 30 Mile — OOVOOM, 59 boulevard Exelmans, 75016 Paris'],
], cols([0.28, 0.72])));

P6.push(H2('5', 'Cas de la vignette Crit’Air'));
P6.push(BUL("Scanner la vignette comme les autres documents."));
P6.push(BUL("L'envoyer par mail à OOVOOM."));
P6.push(BUL("**Puis la renvoyer par courrier** à l'adresse postale ci-dessus : le mail ne suffit pas."));

P6.push(H2('6', 'Archivage des originaux'));
P6.push(BUL("Conserver les originaux, **classés par date**, dans l'enveloppe prévue — rangée dans les bannettes noires situées derrière le poste."));
P6.push(BUL("Les garder **trois mois**."));
P6.push(BUL("Détruire les enveloppes avec la machine prévue à cet effet."));


/* ================= PROCÉDURE 7 — PARKINGS ================= */
const P7 = [];
P7.push(EYEBROW('PROCÉDURE INTERNE'));
P7.push(TITLE('Accès aux parkings P1 et P2'));
P7.push(LEDE("Donner accès aux deux parkings du site : inscription du collaborateur sur Sharvy pour le P1, fabrication du badge parking pour le P2."));
P7.push(META([['Version', '1.0'], ['Site', 'siège social'], ['Diffusion', 'accueil et services généraux']]));

P7.push(H2('1', 'Deux parkings, deux modes d’accès'));
P7.push(table(['Parking', "Mode d'accès", 'Qui fait la démarche'], [
  ['P1', "Lecture automatique de la plaque d'immatriculation", "Le collaborateur s'inscrit lui-même sur Sharvy"],
  ['P2', 'Badge parking', 'Les services généraux fabriquent le badge'],
], cols([0.13, 0.44, 0.43])));

P7.push(H2('2', 'Parking P1 — inscription sur Sharvy'));
P7.push(P("L'accès se fait par lecture de plaque : le collaborateur doit donc être enregistré avant sa première venue. La démarche lui appartient, les services généraux n'interviennent qu'en cas de difficulté."));
P7.push(BUL("Se rendre sur le site Sharvy et saisir ses identifiants."));
P7.push(BUL("Ouvrir **Parking P1** et **saisir sa plaque d'immatriculation**."));
P7.push(BUL("La place est réservée pour son arrivée ; l'application lui communique son **numéro de place**."));
P7.push(GAP(70));
P7.push(note('Place déjà occupée', "Le collaborateur **prend la place en photo**, se gare sur une autre place, puis transmet la photo aux services généraux pour signalement. Sans photo, le litige ne peut pas être tranché.", 'warn'));

P7.push(H2('3', 'Parking P2 — badge parking'));
P7.push(P("Le badge parking est fabriqué **en même temps que le badge d'accès au bâtiment** (voir la procédure de gestion des accès)."));
P7.push(BUL("Prendre un badge parmi les badges parking prévus à cet effet."));
P7.push(BUL("Ajouter les accès correspondants."));
P7.push(BUL("Imprimer l'étiquette portant le **nom, le prénom et le numéro de badge Optik**."));
P7.push(BUL("Remettre **les deux badges** — accès bâtiment et parking — au collaborateur, en main propre."));

P7.push(H2('4', 'Izix'));
P7.push(P("{{à documenter : périmètre couvert par Izix, qui crée les comptes, articulation avec Sharvy et avec les badges P2}}"));
P7.push(GAP(70));
P7.push(note('Section à compléter', "Izix n'apparaît pas dans le cahier de consignes du site : cette section reste vide tant que son usage réel n'a pas été décrit par les services généraux.", 'info'));


/* ================= PROCÉDURE 8 — TRAITEMENT DES MAILS ================= */
const P8 = [];
P8.push(EYEBROW('PROCÉDURE INTERNE'));
P8.push(TITLE('Traitement des mails du poste d’accueil'));
P8.push(LEDE("Consulter, trier, réorienter et répondre aux mails reçus sur les boîtes du poste d'accueil et des services généraux."));
P8.push(META([['Version', '1.0'], ['Site', 'siège social'], ['Diffusion', 'accueil et services généraux']]));

P8.push(H2('1', 'Les deux boîtes et le rythme'));
P8.push(BUL("**Deux boîtes mail** sont à consulter : {{boîtes à préciser}}."));
P8.push(BUL("À la prise de poste, ouvrir Teams, Outlook et Tracker, puis dépouiller les mails et les traiter rapidement."));
P8.push(BUL("**Avant de quitter le poste**, tous les mails reçus dans la journée doivent être traités ou avoir reçu une réponse."));

P8.push(H2('2', 'Trier à la lecture'));
P8.push(P("Chaque mail entre dans l'une de ces quatre familles, qui appellent chacune un geste différent :"));
P8.push(table(['Type de mail', 'Ce que vous en faites'], [
  ['Demande d’intervention', "La saisir dans Tracker et sur le fichier Excel de suivi. Le dispatch revient au responsable des services généraux ; certaines demandes — badges, préparation de salle, déplacement d'un meuble — sont à votre charge."],
  ['Externe cherchant à joindre un collaborateur', "Prendre le message et l'envoyer au collaborateur avec le modèle « Prise de message »."],
  ['Demande exceptionnelle', "Montage de mobilier, aménagement ponctuel : en accord avec le responsable des services généraux avant d'engager quoi que ce soit."],
  ['Information', "Réunion, note de service : en prendre connaissance, pas de réponse nécessaire."],
], cols([0.30, 0.70])));

P8.push(H2('3', 'Vers qui réorienter'));
P8.push(P("Un mail qui ne relève pas des services généraux n'est pas traité au poste : il est transféré au service concerné, et l'expéditeur en est informé."));
P8.push(table(['Objet du mail', 'Destinataire'], [
  ['Flotte automobile, contraventions', 'auddika@oovoom.fr — 01 80 82 44 43 (voir la procédure contraventions)'],
  ['Factures fournisseurs', 'facture@audika.com'],
  ['Loyers', 'loyers@audika.com'],
  ['Comptabilité générale', 'compta@audika.com'],
  ['Services généraux', 'sgx@audika.com'],
  ['Informatique', 'info@audika.com'],
  ['Ressources humaines', "Solde de tout compte : prendre le message et l'envoyer à la personne RH. Recrutement : recrutement.siege@audika.com"],
  ['Qualité', 'flaroche@audika.com — 0 800 210 470'],
  ['Boutique en ligne', 'boutique@audika.fr — 01 55 70 26 27'],
  ['Ménage et propreté des locaux', '{{prestataire et adresse à compléter}}'],
], cols([0.32, 0.68])));

P8.push(H2('4', 'Réponses types'));
P8.push(P("Trois modèles sont disponibles en signature dans la boîte mail. Les utiliser plutôt que de rédiger au cas par cas :"));
P8.push(BUL("**Votre badge est prêt** — informe le collaborateur que son badge peut être récupéré auprès des services généraux."));
P8.push(BUL("**Prise de message** — signale qu'une personne extérieure a cherché à le joindre, avec le sujet et les coordonnées de l'appelant."));
P8.push(BUL("**Rappel : pli en attente à récupérer** — relance un collaborateur dont le pli attend au service généraux."));
P8.push(GAP(70));
P8.push(note('Avant d’envoyer', "Relire : pas de faute, formulation professionnelle, objet explicite. Les messages envoyés depuis ce poste engagent l'image de l'accueil.", 'warn'));

/* ================= PROCÉDURE 9 — MACHINE À CAFÉ ================= */
const P9 = [];
P9.push(EYEBROW('PROCÉDURE INTERNE'));
P9.push(TITLE('Machine à café et consommables'));
P9.push(LEDE("Approvisionner les machines à café, suivre les consommables de la tisanerie et faire intervenir le prestataire en cas de panne."));
P9.push(META([['Version', '1.0'], ['Site', 'siège social'], ['Diffusion', 'accueil et services généraux']]));

P9.push(H2('1', 'Consommables à suivre'));
P9.push(P("Les consommables de la tisanerie font partie des fournitures gérées par le poste : **café, thé, sucre, touillettes**."));
P9.push(BUL("Vérifier le stock {{fréquence à définir}} et réapprovisionner avant rupture."));
P9.push(BUL("La tisanerie doit être **propre et rangée** avant le départ, comme le poste de travail."));
P9.push(BUL("Les fournitures de bureau et les consommables se commandent chez Lyreco : voir la procédure de commande."));
P9.push(BUL("Fournisseur des consommables café : {{à compléter si différent de Lyreco}}"));

P9.push(H2('2', 'Panne ou entretien de la machine'));
P9.push(P("L'entretien des machines à café est assuré par le prestataire **SOVEDIS**."));
P9.push(table(null, [
  ['SOVEDIS — entretien des machines à café', '06 52 97 88 52'],
], cols([0.55, 0.45])));
P9.push(GAP(70));
P9.push(BUL("Signaler la panne à SOVEDIS en précisant l'étage, la machine concernée et le symptôme."));
P9.push(BUL("Prévenir le responsable des services généraux."));
P9.push(BUL("Signaler l'indisponibilité aux collaborateurs si l'immobilisation dure."));
P9.push(BUL("Noter l'intervention : {{support de suivi à préciser — Tracker, fichier Excel ?}}"));
P9.push(GAP(70));
P9.push(note('Section à consolider', "Le cahier de consignes ne mentionne la machine à café que par le contact SOVEDIS et la liste des consommables. Les fréquences de contrôle, le fournisseur du café et le suivi des interventions restent à décrire par les services généraux.", 'info'));

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
  .then(() => build(P3, 'Gestion des accès au siège social', 'PRO-SG-003_Gestion_des_acces_au_siege.docx'))
  .then(() => build(P4, 'Gestion du courrier, des plis et des colis', 'PRO-SG-004_Gestion_du_courrier.docx'))
  .then(() => build(P5, 'Welcome by : visiteurs, plis et colis', 'PRO-SG-005_Welcome_by.docx'))
  .then(() => build(P6, 'Contraventions et courrier de la flotte automobile', 'PRO-SG-006_Contraventions_flotte_auto.docx'))
  .then(() => build(P7, 'Accès aux parkings P1 et P2', 'PRO-SG-007_Acces_parkings.docx'))
  .then(() => build(P8, 'Traitement des mails du poste d’accueil', 'PRO-SG-008_Traitement_des_mails.docx'))
  .then(() => build(P9, 'Machine à café et consommables', 'PRO-SG-009_Machine_a_cafe.docx'));
