const fs = require('fs');
const D = require('docx');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, BorderStyle, ShadingType, LevelFormat, Header, Footer, PageNumber, convertInchesToTwip
} = D;

const ACCENT = '0D5C63', OCHRE = '8A5A12', BRICK = '94322B', MUTED = '5B6C72', LINE = 'D3DBDB';
const WASH_A = 'E6F0F0', WASH_O = 'F7EEDE', WASH_B = 'F8E7E4', WASH_H = 'EEF2F1';
const CW = 9638; // content width in DXA (A4, marges 2 cm)

// ---- mini-markup: **gras**, `chemin`, {{à compléter}} ----
function runs(text, base = {}) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\{\{[^}]*\}\})/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), ...base }));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(new TextRun({ text: tok.slice(2, -2), bold: true, ...base }));
    else if (tok.startsWith('`')) out.push(new TextRun({ text: tok.slice(1, -1), font: 'Consolas', size: 18, color: ACCENT, ...base }));
    else out.push(new TextRun({ text: tok.slice(2, -2) || 'à compléter', highlight: 'yellow', italics: true, ...base }));
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), ...base }));
  return out;
}

const P = (t, o = {}) => new Paragraph({ children: runs(t), spacing: { after: 120, line: 276 }, ...o });
const BUL = (t) => new Paragraph({ children: runs(t), numbering: { reference: 'puces', level: 0 }, spacing: { after: 60, line: 276 } });
const NUM = (t, ref) => new Paragraph({ children: runs(t), numbering: { reference: ref, level: 0 }, spacing: { after: 60, line: 276 } });
const H1 = (t) => new Paragraph({ children: [new TextRun({ text: t, bold: true, color: ACCENT, size: 30 })], heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 160 } });
const H2 = (t) => new Paragraph({ children: [new TextRun({ text: t, bold: true, size: 24 })], heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 100 } });
const H3 = (t) => new Paragraph({ children: [new TextRun({ text: t, bold: true, size: 21, color: MUTED })], heading: HeadingLevel.HEADING_3, spacing: { before: 160, after: 80 } });
const SPACER = (h = 120) => new Paragraph({ text: '', spacing: { after: h } });

function cell(children, w, opts = {}) {
  return new TableCell({
    width: { size: w, type: WidthType.DXA },
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    shading: opts.shading ? { type: ShadingType.CLEAR, fill: opts.shading, color: 'auto' } : undefined,
    children: children,
  });
}

function table(headers, rows, widths) {
  const trs = [];
  if (headers) {
    trs.push(new TableRow({
      tableHeader: true,
      children: headers.map((h, i) => cell(
        [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 17, color: MUTED, allCaps: true })], spacing: { after: 0 } })],
        widths[i], { shading: WASH_H })),
    }));
  }
  rows.forEach((r) => {
    trs.push(new TableRow({
      children: r.map((c, i) => cell(
        [new Paragraph({ children: runs(String(c), { size: 19 }), spacing: { after: 0, line: 250 } })],
        widths[i])),
    }));
  });
  return new Table({
    columnWidths: widths,
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: LINE },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: LINE },
      left: { style: BorderStyle.SINGLE, size: 4, color: LINE },
      right: { style: BorderStyle.SINGLE, size: 4, color: LINE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: LINE },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: LINE },
    },
    rows: trs,
  });
}

function note(label, text, tone) {
  const color = tone === 'warn' ? OCHRE : tone === 'stop' ? BRICK : ACCENT;
  const fill = tone === 'warn' ? WASH_O : tone === 'stop' ? WASH_B : WASH_A;
  return new Table({
    columnWidths: [CW],
    width: { size: CW, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
      right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE },
      insideVertical: { style: BorderStyle.NONE },
      left: { style: BorderStyle.SINGLE, size: 18, color: color },
    },
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: CW, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: fill, color: 'auto' },
        margins: { top: 120, bottom: 120, left: 160, right: 160 },
        children: [
          new Paragraph({ children: [new TextRun({ text: label.toUpperCase(), bold: true, size: 16, color: color })], spacing: { after: 60 } }),
          new Paragraph({ children: runs(text, { size: 19 }), spacing: { after: 0, line: 250 } }),
        ],
      })],
    })],
  });
}

const step = (n, title) => new Paragraph({
  children: [
    new TextRun({ text: `ÉTAPE ${n}`, bold: true, size: 16, color: ACCENT }),
    new TextRun({ text: '    ' }),
    new TextRun({ text: title, bold: true, size: 23 }),
  ],
  spacing: { before: 260, after: 100 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 4 } },
  keepNext: true,
});

// ============================ CONTENU ============================
const body = [];

// --- Titre + cartouche ---
body.push(new Paragraph({
  children: [new TextRun({ text: 'PROCÉDURE INTERNE  ·  ACHATS & SERVICES GÉNÉRAUX  ·  PRO-ACH-001', bold: true, size: 17, color: ACCENT })],
  spacing: { after: 120 },
}));
body.push(new Paragraph({
  children: [new TextRun({ text: 'Commander des fournitures sur le webshop Lyreco', bold: true, size: 40 })],
  spacing: { after: 140 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ACCENT, space: 8 } },
}));
body.push(new Paragraph({
  children: [new TextRun({ text: "Mode opératoire applicable à l'ensemble des centres, directions régionales et services du siège disposant d'un accès au webshop Lyreco : de la connexion à la réception de la livraison, jusqu'au traitement des litiges.", size: 21, color: MUTED, italics: true })],
  spacing: { before: 160, after: 240, line: 276 },
}));
body.push(table(null, [
  ['**Référence**', 'PRO-ACH-001', '**Version**', '1.0'],
  ["**Date d'application**", '{{}}', '**Diffusion**', 'Centres, DR, siège'],
  ['**Rédacteur**', '{{}}', '**Approbateur**', '{{}}'],
  ['**Révision**', 'Annuelle', '**Fournisseur**', 'Lyreco France'],
], [2100, 2719, 2100, 2719]));
body.push(SPACER(200));
body.push(note('Avant diffusion', "Les mentions surlignées correspondent aux paramètres propres à l'entreprise (seuils, fréquences, noms des valideurs, contacts internes). Elles doivent être renseignées par le service achats avant la mise en application. Toutes les autres informations décrivent le fonctionnement réel du webshop Lyreco et des conditions commerciales publiées par le fournisseur.", 'warn'));

// --- 1 ---
body.push(H1('1. Objet'));
body.push(P("Cette procédure définit les modalités d'achat des fournitures et consommables de fonctionnement auprès de Lyreco, fournisseur référencé de l'entreprise. Elle vise à :"));
[
  'garantir que chaque commande est imputée au bon centre et livrée à la bonne adresse ;',
  'sécuriser le circuit de validation et le respect des budgets ;',
  'limiter les coûts logistiques en respectant le seuil de franco de port ;',
  'assurer la traçabilité des commandes, des livraisons et des litiges ;',
  'harmoniser les pratiques entre tous les centres du réseau.',
].forEach((t) => body.push(BUL(t)));

// --- 2 ---
body.push(H1("2. Domaine d'application"));
body.push(H3('Périmètre couvert'));
body.push(P("Tous les achats réalisés sur le webshop Lyreco par les collaborateurs disposant d'un accès nominatif, quel que soit le compte de rattachement : papier et enveloppes, cartouches et toners, fournitures de bureau, classement, informatique et téléphonie de bureau, mobilier de bureau, alimentation et réception, hygiène et entretien, équipements de protection individuelle, emballage et expédition, services généraux."));
body.push(H3('Exclusions'));
[
  'Matériel médical, audiologique et consommables techniques des centres — circuit dédié.',
  "Matériel informatique géré par la DSI (postes, écrans professionnels, périphériques normés) — le compte `AUDIKA DSI` est explicitement paramétré « pas de commandes ».",
  "Mobilier et aménagement supérieurs à {{seuil à compléter}}, qui relèvent d'un projet d'aménagement validé par les services généraux.",
  "Prestations de montage, produits personnalisés et livraisons spécifiques, qui font l'objet de conditions particulières chez Lyreco et d'un accord préalable du siège.",
].forEach((t) => body.push(BUL(t)));

// --- 3 ---
body.push(H1('3. Rôles et responsabilités'));
body.push(table(['Rôle', 'Qui', 'Responsabilités'], [
  ['**Demandeur / acheteur**', 'Collaborateur du centre désigné {{}}', "Recense les besoins, vérifie le compte actif, constitue et soumet le panier, réceptionne et contrôle la livraison, signale les anomalies."],
  ['**Valideur**', 'Responsable de centre / DR {{}}', 'Contrôle la pertinence et le montant de la commande soumise à validation ; valide, modifie ou refuse dans le délai imparti.'],
  ['**Approbateur final**', '{{}}', "Second niveau de validation déclenché en cas de dépassement de budget ou de produit contrôlé."],
  ['**Administrateur webshop**', 'Services généraux / achats — siège', 'Crée et désactive les utilisateurs, attribue les droits et les valideurs, paramètre les budgets, fait évoluer le mini-catalogue avec Lyreco, diffuse les messages internes.'],
  ['**Contrôle de gestion**', '{{}}', 'Suit la dépense par centre, analyse les écarts au budget et les indicateurs de la section 12.'],
  ['**Comptabilité fournisseurs**', '{{}}', 'Rapproche factures, bons de livraison et avoirs ; traite les litiges de facturation.'],
  ['**Lyreco**', 'Chargé de compte et Service Clients', "Tient à jour le mini-catalogue et les tarifs négociés, traite les demandes de retour, d'échange et de SAV, assure la livraison."],
], [2000, 2400, 5238]));

// --- 4 ---
body.push(H1('4. Règles de gestion'));
body.push(P("Ces dix règles s'imposent à tout utilisateur du webshop. Elles conditionnent la validation des commandes."));
body.push(table(['N°', 'Règle', 'Contrôle'], [
  ['R1', 'Les besoins sont regroupés : **une commande par centre et par {{période à compléter}}**, hors urgence justifiée.', 'Nombre de commandes par centre et par mois.'],
  ['R2', "Chaque commande atteint **75 € HT minimum**, seuil de la livraison gratuite chez Lyreco. En dessous, des frais de port sont facturés.", 'Montant du panier avant validation.'],
  ['R3', "Les achats se font **en priorité dans le mini-catalogue et les listes de favoris**, qui contiennent les produits référencés aux tarifs négociés.", 'Lignes commandées hors mini-catalogue.'],
  ['R4', "Le **compte actif est vérifié avant chaque commande** : il détermine l'adresse de livraison et l'imputation comptable.", "Bandeau de compte en haut de l'écran."],
  ['R5', 'La **référence interne** (code centre, service ou demandeur) est renseignée à la validation du panier.', 'Champ référence de la commande.'],
  ['R6', "Le webshop est réservé à un **usage strictement professionnel**. Aucune commande à titre personnel n'est autorisée.", 'Historique de commande nominatif.'],
  ['R7', 'Les **familles exclues** (section 2) ne sont pas commandées sur Lyreco.', 'Revue des lignes par le valideur.'],
  ['R8', 'Le **budget du centre** est respecté ; tout dépassement déclenche une validation supplémentaire et doit être justifié.', 'Alerte budget du webshop.'],
  ['R9', 'Toute anomalie de livraison est signalée **sous 48 heures**, réserves portées sur le bon de livraison.', 'Registre des litiges du centre.'],
  ['R10', "Les **identifiants sont personnels** et ne se partagent pas. Tout départ de collaborateur donne lieu à désactivation de son accès.", 'Revue trimestrielle des utilisateurs actifs.'],
], [700, 5738, 3200]));
body.push(SPACER(160));
body.push(note('Bon à savoir', "Une commande passée avant 18 h est livrée sous 24 h dans 99 % des cas. Il est donc inutile de fractionner les commandes pour « aller plus vite » : le regroupement (R1) n'allonge pas le délai de livraison, il réduit les frais de port et l'empreinte logistique.", 'info'));

// --- 5 ---
body.push(H1("5. Comprendre l'organisation des comptes"));
body.push(P("C'est le point qui génère le plus d'erreurs. Le webshop reproduit la structure juridique et logistique de l'entreprise sous forme d'arborescence. Deux natures de comptes coexistent :"));
body.push(table(['Nature', "Repérage à l'écran", 'Peut commander ?', 'Usage'], [
  ['**Nœud / donneur d\'ordre**', 'Libellé en **texte noir** dans la hiérarchie', 'Non', "Niveau d'organisation (administrateur, siège, réseau, direction régionale). Sert au regroupement, au pilotage et au paramétrage."],
  ['**Adresse de livraison**', 'Libellé en **texte bleu**, bouton « Sélectionner »', 'Oui', "Compte d'un centre ou d'un site. C'est l'adresse où la marchandise est livrée et l'entité à laquelle la dépense est imputée."],
], [2100, 2600, 1400, 3538]));
body.push(SPACER(160));
body.push(note('Message bloquant', "« Vous êtes connecté sur un compte qui ne peut pas commander. De ce fait vous ne pourrez pas passer de commande ou vérifier de prix. » — vous êtes positionné sur un nœud administratif (comptes marqués `PAS DE COMMANDES`). Il ne s'agit pas d'une panne : utilisez `Changer de compte` pour basculer sur le compte de livraison du centre concerné avant toute action.", 'stop'));
body.push(SPACER(160));
body.push(P("Le compte actif est toujours affiché en haut de l'écran, sous la forme `Compte : 4765875 · AUDIKA · C0092 · 1 rue du Général Fauconnet · 21000 DIJON`. Chaque centre possède son numéro de compte à sept chiffres et son code interne `Cxxxx`. L'annexe B détaille les niveaux de l'arborescence."));

// --- 6 ---
body.push(H1('6. Mode opératoire'));
body.push(P("Les huit étapes ci-dessous décrivent le déroulement complet d'une commande, de la connexion à la réception. Elles s'enchaînent dans cet ordre."));

body.push(step(1, 'Se connecter au webshop'));
body.push(P("Accédez à `www.lyreco.com/webshop` puis à l'espace `Utilisateur`. Saisissez votre identifiant et votre mot de passe. L'identifiant est construit à partir du numéro de compte de rattachement suivi de vos initiales (par exemple `4765875XY`)."));
[
  "Mot de passe oublié : utilisez le lien de réinitialisation de la page de connexion. En cas d'échec, sollicitez l'administrateur webshop.",
  'Vérifiez que la langue est bien `Français – FR` et la devise en euros HT.',
  "Déconnectez-vous en fin de session, en particulier sur un poste partagé à l'accueil d'un centre.",
].forEach((t) => body.push(BUL(t)));

body.push(step(2, 'Vérifier — et si besoin changer — le compte actif'));
body.push(P("**Étape obligatoire avant toute mise au panier.** Contrôlez le bandeau de compte en haut de l'écran : numéro, enseigne, code centre et adresse doivent correspondre au lieu de livraison souhaité."));
[
  'Cliquez sur `Changer de compte`.',
  "Parcourez la hiérarchie (les flèches déplient ou replient chaque niveau) ou saisissez directement le numéro dans `Chercher un numéro de compte` puis `Chercher`.",
  'Sur la ligne du centre voulu — affichée en bleu — cliquez sur `Sélectionner`.',
  'Vérifiez que le bandeau affiche bien le nouveau compte avant de continuer.',
].forEach((t) => body.push(NUM(t, 'etape2')));
body.push(SPACER(80));
body.push(note('Point de vigilance', "Changer de compte en cours de commande peut vider ou recalculer le panier : les tarifs, le mini-catalogue et les budgets sont propres à chaque compte. Sélectionnez toujours le compte avant de constituer le panier.", 'warn'));

body.push(step(3, 'Constituer le panier'));
body.push(P("Trois voies d'accès aux produits, par ordre de priorité :"));
body.push(H3('a. Listes de favoris — voie recommandée'));
body.push(P("Menu `Mes favoris › Produits préférés`. Les listes partagées du réseau contiennent les produits validés par le siège, par exemple Équipement réseau électroménager, Pack électroménager, Pack purificateur et Pack destructeur. Ouvrez la liste, saisissez les quantités, ajoutez au panier."));
body.push(H3('b. Commande rapide'));
body.push(P("Menu `Commande rapide` (icône chronomètre à droite de la barre de recherche) :"));
body.push(BUL("`Via les références produits` : saisissez les références Lyreco et les quantités, puis `Ajouter au panier`. Idéal pour un réapprovisionnement récurrent à partir d'une liste papier ou d'une commande précédente."));
body.push(BUL("`Via un fichier` : importez un fichier Excel/CSV contenant les références et les quantités, puis `Envoyer`. Le panier est alimenté automatiquement."));
body.push(H3('c. Catalogue et moteur de recherche'));
body.push(P("Recherche par mot-clé, par référence ou navigation dans les familles de produits. Pour les consommables d'impression, l'`Outil de recherche de cartouche` permet de retrouver la référence exacte à partir du modèle d'imprimante."));
body.push(P("Une commande déjà passée peut être rejouée depuis `Mon historique de commande` : ouvrez la commande, puis ajoutez tous les produits au panier."));
body.push(note('Point de vigilance', "Contrôlez systématiquement **l'unité de vente** : boîte de 100, lot de 12, carton de 5 ramettes. La quantité saisie porte sur le conditionnement affiché, pas sur l'unité. C'est la première cause de sur-commande.", 'warn'));

body.push(step(4, 'Mettre le panier en attente si nécessaire'));
body.push(P("Une commande peut être préparée puis reprise plus tard : dans le panier, cliquez sur `Mettre la commande en attente`, donnez-lui un titre explicite (par exemple C0092 – réappro mars) puis `Envoyer`. Vous la retrouverez via `Commande rapide` ou le bandeau `Commande(s) en attente`."));
body.push(P("Utilisez cette fonction pour laisser un panier ouvert pendant la période de collecte des besoins du centre, plutôt que de multiplier les petites commandes."));

body.push(step(5, 'Contrôler le panier'));
body.push(P("Ouvrez le panier et procédez aux vérifications de la check-list (annexe A) : compte actif, quantités et conditionnements, montant total supérieur ou égal à 75 € HT, absence de produits relevant des familles exclues, cohérence avec le budget du centre. Les quantités se modifient et les lignes se suppriment directement dans le panier."));
body.push(P("Un produit signalé comme **contrôlé** (mention affichée sous le prix) déclenchera une validation supplémentaire : anticipez le délai."));

body.push(step(6, 'Valider la commande'));
[
  "Dans le panier, cliquez sur `Afficher` puis sur `Voir mes offres et valider ma commande`.",
  "Cliquez sur `Suivant` pour accéder aux informations de livraison.",
  "Vérifiez l'adresse de livraison, renseignez le **nom du contact du centre** et un **numéro de téléphone joignable** (indispensable pour le chauffeur), puis confirmez.",
  "Renseignez la **référence interne** de commande (règle R5).",
  "Confirmez la commande. Un e-mail de confirmation vous est adressé, avec le numéro de commande Lyreco et la date de livraison estimée.",
].forEach((t) => body.push(NUM(t, 'etape6')));
body.push(P("Si un contrôle interne s'applique, le message « reçu, en attente de validation » s'affiche : la commande n'est pas encore transmise à Lyreco (voir section 7)."));

body.push(step(7, 'Suivre la commande'));
[
  "`Commandes en cours` : commandes transmises ou en attente de validation, avec leur statut.",
  "`Mon historique de commande` : recherche par numéro, par date ou par produit ; sert aussi de base au réapprovisionnement.",
  "Le lien de suivi figure dans l'e-mail de confirmation.",
].forEach((t) => body.push(BUL(t)));
body.push(P("Une commande validée avant 18 h est livrée sous 24 h dans la très grande majorité des cas. Toute modification ou annulation doit être demandée **immédiatement** au Service Clients Lyreco : passé le lancement de la préparation, elle n'est plus possible et relèvera d'un retour."));

body.push(step(8, 'Réceptionner et contrôler'));
body.push(P("Voir la section 8 : le contrôle à la livraison conditionne l'acceptation des réclamations."));

// --- 7 ---
body.push(H1('7. Circuit de validation'));
body.push(P("Le webshop applique automatiquement le circuit paramétré par l'administrateur. Trois éléments peuvent déclencher une validation :"));
[
  "**Dépassement de budget** : lorsqu'un budget est défini sur le compte et que la commande le dépasse, une double validation devient obligatoire.",
  "**Produit contrôlé** : certains articles du mini-catalogue sont marqués comme contrôlés et imposent une validation, quel que soit le montant.",
  "**Profil utilisateur** : un acheteur peut être rattaché à un valideur et, le cas échéant, à un approbateur final.",
].forEach((t) => body.push(BUL(t)));
body.push(SPACER(80));
body.push(table(['Étape', 'Acteur', 'Action'], [
  ['1', 'Acheteur', 'Confirmation de la commande dans le webshop.'],
  ['—', 'Système', 'Contrôle automatique : budget dépassé, produit contrôlé ou profil soumis à validation ?'],
  ['2', 'Valideur', "Réception d'un e-mail contenant un lien vers la commande : il valide, modifie ou refuse après connexion."],
  ['3', 'Approbateur final', 'En cas de double validation, second contrôle et validation définitive.'],
  ['4', 'Système', "Commande transmise à Lyreco ; l'acheteur est notifié par e-mail."],
], [900, 2200, 6538]));
body.push(H3('Règles internes'));
[
  "Délai de traitement attendu du valideur : {{}} (recommandé : 48 heures ouvrées). Au-delà, l'acheteur relance ; la commande non validée n'est jamais transmise à Lyreco.",
  "En cas d'absence du valideur, la suppléance est assurée par {{}}.",
  "Un refus doit être motivé auprès du demandeur ; le panier peut être corrigé puis resoumis.",
  "Toute demande de modification d'un budget ou d'un circuit de validation passe par l'administrateur webshop, jamais par le Service Clients Lyreco.",
].forEach((t) => body.push(BUL(t)));
body.push(SPACER(80));
body.push(note('Délai de prise en compte', "Les modifications de droits, de valideurs et de budgets réalisées dans `Gestion avancée` ne sont effectives que **le lendemain**. Anticipez les arrivées, départs et remplacements en conséquence.", 'info'));

// --- 8 ---
body.push(H1('8. Réception et contrôle de la livraison'));
[
  "**Avant de signer** : comptez les colis et comparez avec le bon de livraison (BL) présenté par le chauffeur.",
  "**Colis endommagé** : refusez-le, ou acceptez-le en portant une réserve écrite précise sur le BL — « carton n° 2 éventré, contenu à vérifier » et non « sous réserve de déballage », mention sans valeur.",
  "**Après déballage** : vérifiez les références et les quantités reçues ligne à ligne. Photographiez tout produit manquant, cassé ou non conforme.",
  "**Livraison sans contact** : il n'y a pas de signature manuscrite ; la preuve de livraison prend la forme d'une photo du lieu de dépose et du nom de la personne ayant réceptionné.",
  "**Conservez le BL** : il est exigé pour toute réclamation et pour tout retour. Classement au centre pendant {{durée à compléter}}.",
].forEach((t) => body.push(NUM(t, 'reception')));
body.push(SPACER(80));
body.push(note('Délai impératif', "Toute anomalie (manquant, casse, erreur de référence) doit être signalée dans les **48 heures** suivant la livraison. Passé ce délai, la réclamation devient difficile à faire aboutir.", 'stop'));

// --- 9 ---
body.push(H1('9. Anomalies, retours et service après-vente'));
body.push(table(['Situation', 'Action', 'Délai', 'Interlocuteur'], [
  ['Produit manquant ou colis non livré', 'Réserve sur le BL, puis déclaration avec le numéro de commande et le numéro de BL', '48 h', 'Service Clients Lyreco'],
  ['Produit cassé ou détérioré', "Photos, conservation de l'emballage, déclaration", '48 h', 'Service Clients Lyreco'],
  ['Erreur de référence livrée', 'Demande d\'échange ; le produit est repris par un chauffeur Lyreco', '48 h', 'Service Clients Lyreco'],
  ['Produit non conforme au besoin, erreur de commande interne', "Demande de reprise : produit non utilisé, non marqué, dans son emballage d'origine intact, copie du BL jointe", '30 jours après livraison', 'Service Clients Lyreco'],
  ['Panne d\'un équipement sous garantie', 'Demande SAV avec la référence, le numéro de série et la date de livraison', 'Durée de garantie', 'SAV Lyreco'],
  ['Erreur de compte de livraison', 'Signalement interne, puis reprise ou transfert selon le cas', 'Immédiat', 'Administrateur webshop'],
  ['Écart de facturation', "Rapprochement facture / BL / commande, puis demande d'avoir", 'À réception de la facture', 'Comptabilité fournisseurs'],
], [2500, 3538, 1600, 2000]));
body.push(H3('Conditions de retour'));
[
  'Reprise gratuite dans un délai maximum de **30 jours après la livraison**.',
  "Produit dans son emballage d'origine, intact, sans marquage, non utilisé et non endommagé.",
  "Certains produits ne sont pas retournables (articles personnalisés, denrées alimentaires, produits d'hygiène ouverts) ; vérifiez la fiche produit avant de commander.",
  "Lyreco établit un avoir ou une commande d'échange ; la marchandise est reprise par un chauffeur lors d'un passage suivant.",
  'Au-delà de 30 jours, aucun retour ni avoir ne peut être obtenu : la vigilance à la réception (section 8) est donc déterminante.',
].forEach((t) => body.push(BUL(t)));

// --- 10 ---
body.push(H1('10. Documents, justificatifs et archivage'));
body.push(P("Tous les justificatifs sont disponibles en autonomie dans `Mon Espace › Mes documents` :"));
body.push(table(['Document', 'Où le trouver', 'Critères de recherche'], [
  ['**Bon de livraison**', '`Mes documents › Bon de Livraison`', 'Numéro de livraison, numéro de commande Lyreco, période'],
  ['**Bon de livraison émargé** (preuve de réception)', "`Mes documents › Bons de Livraison émargés`, ou depuis `Mon historique de commande` en ouvrant la commande puis `Voir les BL émargés`", 'Mêmes critères'],
  ['**Factures et avoirs**', '`Mes documents`', "Numéro de facture ou d'avoir, numéro payeur, adresse de livraison, période"],
  ['**Liste de prix** (tarifs négociés à jour)', '`Mes documents`', 'Envoi sous 48 h maximum'],
], [2400, 3838, 3400]));
body.push(SPACER(120));
body.push(P("Après recherche, sélectionnez les documents souhaités puis cliquez sur `Demande` : ils sont envoyés au format PDF à votre adresse e-mail ou à une autre adresse de votre choix."));
body.push(note('Cas particulier', "Les BL émargés ne sont pas disponibles lorsque la livraison n'est pas assurée par un chauffeur Lyreco. En livraison sans contact, la preuve consiste en une photo du lieu de dépose et le nom du réceptionnaire.", 'info'));
body.push(H3('Archivage interne'));
[
  'Bons de livraison : classés au centre, {{durée à compléter}}.',
  'Factures et avoirs : transmis à la comptabilité fournisseurs {{modalités à compléter}}.',
  "Preuves de litige (photos, échanges) : conservées jusqu'au règlement complet du dossier.",
].forEach((t) => body.push(BUL(t)));

// --- 11 ---
body.push(H1('11. Administration du compte (siège)'));
body.push(P("Réservé aux détenteurs du profil administrateur, via `Mon Espace › Gestion avancée`."));
body.push(H3('Gestion des utilisateurs'));
[
  "**Arrivée d'un collaborateur** : créer l'utilisateur dans `Utilisateurs`, le rattacher au compte de livraison de son centre, lui attribuer le profil acheteur et son valideur. Prise d'effet le lendemain.",
  "**Départ ou mutation** : désactiver l'accès sous {{délai à compléter}} (recommandé : le jour même), et réaffecter les paniers en attente éventuels.",
  '**Revue périodique** : contrôler la liste des utilisateurs actifs par centre {{fréquence à compléter}}.',
].forEach((t) => body.push(BUL(t)));
body.push(H3('Budgets'));
body.push(P("La rubrique `Budgets` permet de créer ou modifier un budget sur un ou plusieurs comptes. Un dépassement déclenche automatiquement une double validation. Un montant minimum de commande peut également y être paramétré pour appuyer la règle R2."));
body.push(H3('Mini-catalogue et listes partagées'));
body.push(P("`Gestion des produits › Mini catalogue` restreint l'offre visible aux produits négociés. Sa construction et sa mise à jour se font avec le chargé de compte Lyreco, à la demande du service achats. Les listes de favoris partagées complètent ce dispositif pour les besoins récurrents du réseau."));
body.push(H3('Messages'));
body.push(P("La rubrique `Messages` permet de diffuser une information à tous les utilisateurs de la hiérarchie (campagne de commande, gel budgétaire, changement de procédure)."));

// --- 12 ---
body.push(H1('12. Pilotage et indicateurs'));
body.push(table(['Indicateur', 'Source', 'Fréquence', 'Cible'], [
  ['Dépense HT par centre', 'Historique de commande / factures', 'Mensuelle', '{{}}'],
  ['Part des commandes inférieures à 75 € HT', 'Historique de commande', 'Mensuelle', '0 %'],
  ['Nombre de commandes par centre et par mois', 'Historique de commande', 'Mensuelle', '{{}}'],
  ['Lignes commandées hors mini-catalogue', 'Historique de commande', 'Trimestrielle', '< 5 %'],
  ['Délai moyen de validation', 'Commandes en cours', 'Mensuelle', '< 48 h ouvrées'],
  ['Nombre de litiges livraison', 'Registre des litiges', 'Trimestrielle', 'En baisse'],
  ['Utilisateurs actifs sans commande sur 6 mois', 'Gestion avancée', 'Semestrielle', 'Accès désactivés'],
], [3400, 2900, 1600, 1738]));

// --- 13 ---
body.push(H1('13. Contacts'));
body.push(table(['Besoin', 'Contact'], [
  ['Accès, droits, valideurs, budgets, mini-catalogue', 'Administrateur webshop — {{nom et e-mail à compléter}}'],
  ['Question sur la procédure, besoin hors catalogue', 'Service achats / services généraux — {{}}'],
  ['Litige de facturation', 'Comptabilité fournisseurs — {{}}'],
  ['Livraison, retour, échange, SAV', 'Service Clients Lyreco — 0825 09 08 07 (service 0,15 €/min + prix appel), ou `Contactez-nous` depuis le webshop'],
  ['Conditions commerciales, mini-catalogue, nouveaux produits', 'Chargé de compte Lyreco — {{nom et e-mail à compléter}}'],
  ['Aide en ligne', '`Accès au centre d\'aide` et `Guide utilisateur`, en pied de page du webshop'],
  ['Adresse fournisseur', 'Lyreco France — Rue Alphonse Terroir, 59770 Marly'],
], [4000, 5638]));

// --- Annexes ---
body.push(H1('Annexe A — Check-list avant validation'));
body.push(P("À dérouler systématiquement avant de confirmer une commande."));
[
  "Le compte affiché en haut de l'écran est bien celui du centre à livrer (numéro, code `Cxxxx`, adresse).",
  'Les besoins du centre ont été regroupés sur cette commande.',
  'Chaque ligne a été vérifiée : bonne référence, bonne unité de vente, bonne quantité.',
  'Les produits proviennent du mini-catalogue ou des listes de favoris.',
  "Aucun article ne relève des familles exclues (matériel médical, informatique DSI, mobilier hors seuil).",
  'Le montant total atteint au moins 75 € HT.',
  'Le montant reste dans le budget du centre, ou le dépassement est justifié.',
  'La référence interne de commande est renseignée.',
  "L'adresse, le nom du contact et le numéro de téléphone sont corrects.",
  'La commande est passée avant 18 h si la livraison est attendue le lendemain.',
].forEach((t) => body.push(new Paragraph({
  children: [new TextRun({ text: '☐   ', size: 22 }), ...runs(t)],
  spacing: { after: 80, line: 276 },
  indent: { left: 200 },
})));

body.push(H1('Annexe B — Hiérarchie des comptes'));
body.push(P("L'arborescence comporte quatre niveaux. Seuls les comptes de livraison — les centres — peuvent passer commande."));
body.push(table(['Niveau', 'Compte', 'Libellé', 'Localisation', 'Cde'], [
  ['Leader', '—', 'Groupe DEMANT', '—', 'Non'],
  ['Administrateur', '4757169', 'AUDIKA ADMINISTRATEUR', 'Saint-Ouen (93400)', 'Non'],
  ['Sous-leader', '4757170', 'AUDIKA SIEGE', 'Saint-Ouen', 'Oui'],
  ['Sous-leader', '4757171', 'AUDIKA OUVERTURE CENTRE', 'Saint-Ouen', 'Oui'],
  ['Sous-leader', '4757172', 'AUDIKA RESEAU', 'Saint-Ouen', 'Oui'],
  ['Sous-leader', '4770148', 'AUDIKA GROUPE', 'Paris (75819)', 'Oui'],
  ['Sous-leader', '5096071', 'AUDIKA INFORMATIQUE', 'Saint-Ouen', 'Oui'],
  ['Sous-leader', '6021462', 'AUDIKA DSI', 'Saint-Ouen', 'Non'],
  ['Direction régionale', '4757204', 'AUDIKA DR OUEST', 'Bruz (35170)', 'Oui'],
  ['Direction régionale', '4757205', 'AUDIKA DR EST', 'Schiltigheim (67300)', 'Oui'],
  ['Direction régionale', '4757173', 'AUDIKA DR SUD EST', 'Avignon (84000)', 'Oui'],
  ['Direction régionale', '4757206', 'AUDIKA DR SUD OUEST', 'Clermont-Ferrand (63000)', 'Oui'],
  ['Direction régionale', '4757207', 'AUDIKA DR PARIS PR', 'Saint-Ouen', 'Oui'],
  ['Direction régionale', '4757208', 'AUDIKA DR6 CDS MAZZON', 'Bordeaux (33000)', 'Oui'],
  ['Direction régionale', '4757379', 'AUDIKA DR7 CDS FOUREZ', 'Valenciennes (59300)', 'Oui'],
  ['Centres', 'Cxxxx', "Environ 160 comptes de livraison, sous les enseignes AUDIKA, SOLUTIONS AUDITIVES, 2G-AUDITION, AUDIO PROTHÈSE GENY, AUDIKA ALPES et les CFA", 'France entière', 'Oui'],
], [2000, 1300, 3538, 1900, 900]));
body.push(SPACER(100));
body.push(P("La liste complète et à jour des centres est consultable dans le webshop, via `Changer de compte`. Elle n'est volontairement pas reproduite ici pour éviter toute divergence avec la source."));

body.push(H1('Annexe C — Erreurs fréquentes'));
body.push(table(['Symptôme', 'Cause', 'Solution'], [
  ['« Vous êtes connecté sur un compte qui ne peut pas commander »', 'Compte positionné sur un nœud administratif', '`Changer de compte` vers le compte du centre (texte bleu)'],
  ["Les prix ne s'affichent pas", 'Même cause, ou session expirée', 'Se reconnecter, puis sélectionner un compte de livraison'],
  ['Alerte budget au moment de valider', 'Le montant dépasse le budget du compte', 'Réduire le panier ou justifier le dépassement auprès du valideur'],
  ['Un produit connu est introuvable', 'Article hors mini-catalogue', 'Demande au service achats ; ne pas contourner par une autre référence approchante'],
  ['La commande reste « en attente de validation »', "Le valideur n'a pas traité la demande", "Relancer le valideur ; la commande n'est pas partie chez Lyreco"],
  ['Livraison arrivée dans un autre centre', 'Mauvais compte actif au moment de la validation', "Prévenir les deux centres et l'administrateur ; appliquer la règle R4 à l'avenir"],
  ['Quantité reçue dix fois supérieure au besoin', 'Confusion entre unité et conditionnement', 'Demande de reprise sous 30 jours, emballages intacts'],
  ['Les droits modifiés ne sont pas actifs', 'Prise en compte différée', 'Attendre le lendemain ; anticiper les changements'],
  ['Panier perdu après un changement de compte', 'Le panier est propre à chaque compte', "Sélectionner le compte avant de constituer le panier ; utiliser la mise en attente"],
], [3200, 2800, 3638]));

body.push(H1('Annexe D — Glossaire'));
body.push(table(['Terme', 'Définition'], [
  ['**Compte**', "Identifiant à sept chiffres attribué par Lyreco à une entité : nœud d'organisation ou adresse de livraison."],
  ["**Nœud / donneur d'ordre**", "Niveau d'organisation dans l'arborescence, affiché en noir. Ne reçoit pas de livraison."],
  ['**Adresse de livraison**', 'Compte livrable, affiché en bleu. Un compte = une adresse de livraison.'],
  ['**Leader / sous-leader**', 'Entité de tête du contrat et ses entités rattachées.'],
  ['**Mini-catalogue**', 'Sélection restreinte de produits négociés, affectée à un ou plusieurs comptes.'],
  ['**Produit contrôlé**', 'Article du mini-catalogue signalé sous son prix, dont la commande déclenche une validation.'],
  ['**Budget**', "Montant paramétré sur un compte ; son dépassement impose une double validation."],
  ['**Valideur / approbateur final**', 'Utilisateurs habilités à valider, modifier ou refuser une commande soumise à contrôle.'],
  ['**Franco de port**', 'Seuil de commande à partir duquel la livraison est gratuite : 75 € HT.'],
  ['**Commande rapide**', "Saisie directe de références ou import d'un fichier, sans passer par le catalogue."],
  ['**Panier en attente**', 'Panier sauvegardé sous un titre, repris ultérieurement.'],
  ['**BL**', 'Bon de livraison, document remis avec la marchandise.'],
  ['**BL émargé**', 'Bon de livraison signé à la réception, valant preuve de livraison.'],
  ['**Avoir**', "Document comptable émis par Lyreco à la suite d'un retour ou d'une erreur."],
], [3000, 6638]));

body.push(H1('Annexe E — Historique des révisions'));
body.push(table(['Version', 'Date', 'Objet', 'Rédacteur'], [
  ['1.0', '{{}}', 'Création de la procédure', '{{}}'],
  [' ', ' ', ' ', ' '],
  [' ', ' ', ' ', ' '],
], [1400, 2000, 4238, 2000]));

// ============================ DOCUMENT ============================
const numbering = {
  config: [
    { reference: 'puces', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 460, hanging: 260 } } } }] },
    ...['etape2', 'etape6', 'reception'].map((ref) => ({
      reference: ref,
      levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 460, hanging: 260 } } } }],
    })),
  ],
};

const doc = new Document({
  creator: 'Service achats',
  title: 'PRO-ACH-001 — Commander des fournitures sur le webshop Lyreco',
  description: 'Procédure interne',
  numbering,
  styles: {
    default: { document: { run: { font: 'Calibri', size: 21, color: '17232A' } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Calibri', size: 30, bold: true, color: ACCENT } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Calibri', size: 24, bold: true, color: '17232A' } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Calibri', size: 21, bold: true, color: MUTED } },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 },
        margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 },
      },
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          children: [new TextRun({ text: 'PRO-ACH-001 · Commander des fournitures sur le webshop Lyreco · Version 1.0', size: 16, color: MUTED })],
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 6 } },
          spacing: { after: 200 },
        })],
      }),
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [
            new TextRun({ text: 'Document interne — diffusion restreinte          ', size: 16, color: MUTED }),
            new TextRun({ children: ['Page ', PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], size: 16, color: MUTED }),
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
