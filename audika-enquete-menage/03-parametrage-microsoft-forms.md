# Paramétrage Microsoft Forms — Enquête Propreté – Centres Audika – Vague 2

Pas-à-pas pour construire le formulaire, poser les branchements et le diffuser.
*(Fichier généré par `generate.py`.)*

---

## 1. Créer le formulaire

1. Aller sur **forms.office.com** → **Nouveau formulaire**.
2. Titre : `Enquête Propreté – Centres Audika – Vague 2`
3. Description : coller le texte d'introduction de `01-enquete-menage-audika.md`.
4. Saisie des questions — par ordre de préférence :

   **a. Import du fichier Word (recommandé)** — *Nouveau formulaire* → **Importer un fichier /
   Import your file** → **Upload from this device** → **`05-formulaire-a-importer.docx`**
   (12 Ko, loin de la limite de 10 Mo). `06-formulaire-a-importer.pdf` contient exactement la
   même chose, à essayer si le Word donne un résultat imparfait.

   **b. Importation rapide (collage de texte)** — si votre locataire propose ce bouton :
   coller `02-import-microsoft-forms.txt`, puis supprimer les lignes entre crochets `[...]`
   et les séparateurs `=== ... ===`, qui sont des consignes. Beaucoup de locataires n'offrent
   que l'import de fichier : dans ce cas, utiliser la voie **a**.

   **c. Manuel** — recréer les 52 questions à partir de `01-enquete-menage-audika.md`.

### Ce que contient — et ne contient pas — le fichier d'import

Le convertisseur de Forms ne sait faire que deux choses : des **questions à choix** et des
**questions à texte libre**. Tout le reste (grille Likert, notation, tableau, titre de section)
est soit ignoré, soit transformé en question fantôme. Et tout paragraphe libre du document
devient une question : lors d'un premier essai, l'introduction et les descriptions de section
sont ressorties en questions à texte libre.

`05-formulaire-a-importer.docx` ne contient donc **que le titre et les 52 questions numérotées**,
en texte brut, sans puce Word, sans tableau et sans titre de section — la numérotation `1.` et
les marqueurs `a.` `b.` des propositions sont de vrais caractères saisis, seule forme que le
convertisseur reconnaît. À saisir à la main après l'import (le contenu est dans
`01-enquete-menage-audika.md`) :

- l'**introduction**, dans la description du formulaire ;
- les **9 sections** et leurs descriptions (étape 2) ;
- le **bloc de rappel du process**, en description de la section 8 ;
- le **message de fin**, dans le message de confirmation (§6).

### À vérifier après l'import

- **Les 52 questions sont-elles toutes là**, dans l'ordre, avec leurs propositions séparées du
  libellé ? Si des propositions se retrouvent collées à la fin du libellé, c'est que le
  convertisseur a fusionné les lignes : recréer ces questions à la main. Microsoft signale que
  la conversion est **moins fiable en français qu'en anglais**, une relecture complète est donc
  indispensable.
- **Q7 (grille Likert)** et **Q49 (note sur 10)** arriveront en texte libre : ces deux types ne
  sont pas convertibles. Les supprimer et les recréer à la main en **Likert**
  (8 lignes / 5 colonnes) et en **Notation** (10 niveaux) — voir §4.
- **Les types de questions** : appliquer les corrections du §4 (liste déroulante, réponses
  longues, choix multiples), puis cocher les 30 questions obligatoires listées plus bas.

---

## 2. Découper en sections

Forms → **+ Ajouter nouveau** → **Section**. Créer 9 sections :

| # | Titre de section | Questions |
|---|---|---|
| 1 | Votre centre | Q1 → Q5 |
| 2 | Le ménage | Q6 → Q11 |
| 3 | La vitrerie | Q12 → Q17 |
| 4 | L'enlèvement des déchets | Q18 → Q24 |
| 5 | Le désencombrement | Q25 → Q31 |
| 6 | Les espaces verts | Q32 → Q38 |
| 7 | Changement de prestataire | Q39 → Q42 |
| 8 | Rappel du process Services Généraux | Q43 → Q48 |
| 9 | Synthèse et remarques | Q49 → Q52 |

> ⚠️ Le découpage en sections est **indispensable** : sans sections, Microsoft Forms ne permet pas
> les branchements de type « passer à la section suivante ».

**Descriptions de section à renseigner** (`...` de la section → *Ajouter une description*) :

- **Section 2** : « Il s'agit du nettoyage courant de vos locaux : sols, surfaces, sanitaires, poubelles. »
- **Section 3** : « Il s'agit du nettoyage des vitrines, baies vitrées et portes vitrées. »
- **Section 4** : « Sortie et rentrée des conteneurs, évacuation des sacs et des cartons, gestion du tri. »
- **Section 5** : « Débarras et enlèvements d'encombrants : mobilier, matériel, cartons volumineux, DEEE. »
- **Section 6** : « Tonte, taille des haies, désherbage, jardinières, entretien des abords et de la terrasse. »
- **Section 8** : coller le bloc « Le process à retenir » de `01-enquete-menage-audika.md`, avec le lien vers l'outil de ticketing et l'adresse mail des Services Généraux.

---

## 3. Branchements (Ramification)

`...` en haut à droite du formulaire → **Ramification** (*Branching*).

| Question | Réponse | Aller à |
|---|---|---|
| **Q18** Êtes-vous satisfait(e) de la prestation d'en… | Très satisfait(e) | Q19 (suite de la section) |
|  | Plutôt satisfait(e) | Q19 (suite de la section) |
|  | Plutôt insatisfait(e) | Q19 (suite de la section) |
|  | Très insatisfait(e) | Q19 (suite de la section) |
|  | Je ne suis pas concerné(e) par cette prestation | Section 5 — Le désencombrement |
| **Q25** Votre centre a-t-il eu besoin d'une prestati… | Oui | Q26 (suite de la section) |
|  | Non | Section 6 — Les espaces verts |
|  | Je ne sais pas | Section 6 — Les espaces verts |
| **Q32** Votre centre est-il concerné par l'entretien… | Oui, un prestataire intervient | Q33 (suite de la section) |
|  | Oui, mais aucun prestataire n'intervient à ma connaissance | Section 7 — Changement de prestataire |
|  | Je ne suis pas concerné(e) par la maintenance des espaces verts | Section 7 — Changement de prestataire |
| **Q39** Y a-t-il eu un changement de prestataire dan… | Oui | Q40 (suite de la section) |
|  | Non | Section 8 — Rappel du process Services Généraux |
|  | Je ne sais pas | Section 8 — Rappel du process Services Généraux |
| **Q44** Au cours des 6 derniers mois, avez-vous créé… | Oui | Q45 (Êtes-vous satisfait(e) du traitement de vos tick…) |
|  | Non | Q47 (Si vous n'avez pas créé de ticket, pour quelle r…) |
| **Q46** Le délai de traitement de vos tickets vous p… | (toutes réponses) | Q48 (Je confirme avoir pris connaissance du process :…) |
| **Q51** Souhaitez-vous être recontacté(e) par les Se… | Oui | Q52 (Votre email professionnel) |
|  | Non | Fin du formulaire |

---

## 4. Types de questions à corriger après import

Forms ne permet pas de changer le type d'une question existante : les deux dernières lignes du
tableau demandent de supprimer la question importée et de la recréer.

| Question | Type Forms à appliquer |
|---|---|
| Q1, Q2, Q52 | Texte → réponse courte |
| Q3 | Choix → activer **Liste déroulante** |
| Q7 | **Likert** (8 lignes / 5 colonnes) |
| Q11, Q17, Q24, Q31, Q38, Q42, Q50 | Texte → activer **Réponse longue** |
| Q41, Q47, Q48 | Choix → activer **Plusieurs réponses** |
| Q49 | **Notation** → 10 niveaux, symbole « Nombre » |
| Q48 | Choix à 1 option + **Obligatoire** (case à cocher d'accusé de lecture) |
| Q52 | Texte → **Restrictions** → *Adresse e-mail* |

Toutes les autres questions sont des **Choix** à réponse unique.

**Questions obligatoires** (30) : Q1, Q3, Q4, Q6, Q7, Q8, Q9, Q10, Q12, Q13, Q15, Q16, Q18, Q19, Q20, Q21, Q25, Q26, Q27, Q28, Q32, Q33, Q34, Q35, Q39, Q40, Q43, Q44, Q48, Q49.
Tout le reste est facultatif, pour ne pas décourager la réponse.

---

## 5. Thème et logo Audika

`Thème` (en haut à droite) → **Personnaliser le thème** :

1. **Image** → *Télécharger* → charger le fichier du logo Audika officiel (intranet /
   communication interne — PNG à fond transparent, largeur ≥ 600 px). Le logo s'affiche en
   bandeau d'en-tête du formulaire.
2. **Couleur** → couleur personnalisée, code hexadécimal de la charte Audika (à confirmer auprès
   de la communication ; à défaut, un bleu foncé type `#0B3C5D` reste neutre et lisible).
3. Vérifier le rendu sur mobile : la majorité des réponses en centre se font sur téléphone.

> `04-apercu-formulaire.html` est une **maquette de rendu** pour validation interne avant saisie.
> Elle utilise un placeholder texte à la place du logo : charger le fichier officiel dans Forms.

---

## 6. Paramètres de collecte

`...` → **Paramètres** :

- ✅ **Toute personne de mon organisation peut répondre** (authentification Audika / Demant).
- ✅ **Enregistrer le nom** — recommandé : les réponses doivent être rattachées à un centre pour
  piloter les plans d'actions par site. Si vous préférez l'anonymat pour libérer la parole,
  décochez, mais gardez Q1 (nom du centre) obligatoire.
- ✅ **Une réponse par personne** — évite les doublons dans la comparaison vague 1 / vague 2.
- ✅ **Accepter les réponses** avec une **date de fin** alignée sur la date limite de l'intro.
- ✅ **Notification par e-mail de chaque réponse** pour traiter les insatisfactions au fil de l'eau.
- **Message de confirmation personnalisé** : coller le « Message de fin ».

---

## 7. Diffusion

1. **Envoyer** → *Lien* (raccourci) + *Code QR* à afficher en réserve de centre.
2. Mail de lancement aux centres — objet suggéré : *« 5 minutes : votre avis sur la propreté et
   l'entretien de votre centre — 2ᵉ enquête »*, avec le rappel du process ticket en corps de mail.
3. **Relance à J+7** aux non-répondants, clôture à J+14.

---

## 8. Exploitation des résultats

- Onglet **Réponses** → *Ouvrir dans Excel* pour croiser par centre / région / prestataire.
- Comparer les questions d'évolution (**Q10, Q16, Q23, Q30, Q37**) avec les scores de la vague 1 :
  ce sont elles qui mesurent l'effet des plans d'actions, prestation par prestation.
- Comparer **Q40** (jugement après changement de prestataire) sur les seuls centres concernés :
  c'est l'indicateur d'arbitrage pour étendre ou non le changement à d'autres sites.
- Croiser les questions de **fréquence / délai** (Q8, Q13, Q19, Q28, Q34) : elles alimentent directement
  la renégociation des fréquences contractuelles.
- **Q49** (note /10) sert d'indicateur de pilotage à suivre d'une vague à l'autre.
- Sortir la liste des centres avec ≥ 2 réponses « insatisfait » → plan d'action individuel avec
  le prestataire lors de la revue de contrat.
- **Q43** + **Q47** mesurent l'ancrage du process ticket : si « Non, je ne le connaissais pas »
  dépasse 20 %, prévoir une communication dédiée avant la vague 3.
- Le taux de « Je ne suis pas concerné(e) » sur Q18 et Q32 permet au passage de fiabiliser le
  périmètre réel des prestations centre par centre.
