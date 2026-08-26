# Enquête Propreté – Centres Audika – Vague 2

Kit complet pour créer le formulaire Microsoft Forms de la 2ᵉ enquête propreté / entretien
adressée à l'ensemble des centres Audika, en suivi de la première enquête (plans d'actions
et ajustements contractuels).

| Fichier | À quoi ça sert |
|---|---|
| `01-enquete-menage-audika.md` | Le contenu intégral du formulaire : intro, 9 sections, 52 questions, propositions de réponses, message de fin. C'est le document à faire valider en interne. |
| `05-formulaire-a-importer.docx` | **Le fichier à charger dans Forms** (*Importer un fichier → Upload from this device*). Texte brut, titre + 52 questions numérotées, propositions marquées `a.` `b.` : c'est le seul format que le convertisseur de Forms sait lire. |
| `06-formulaire-a-importer.pdf` | Le même contenu en PDF, si l'import du .docx donne un résultat imparfait. |
| `02-import-microsoft-forms.txt` | La même chose au format collable dans l'**Importation rapide**, quand le locataire propose ce bouton (ce n'est pas toujours le cas). |
| `03-parametrage-microsoft-forms.md` | Le mode opératoire Forms : découpage en sections, table des ramifications, types de questions, thème et logo, paramètres de collecte, diffusion, exploitation des résultats. |
| `04-apercu-formulaire.html` | Maquette du rendu, à ouvrir dans un navigateur pour validation avant saisie. |
| `generate.py` | Générateur des fichiers texte + `form.json` à partir d'une source unique. |
| `generate_docx.js` / `generate_pdf.js` | Générateurs du Word et du PDF à partir de `form.json`. |

## Prestations couvertes

Ménage · Vitrerie · Enlèvement des déchets · Désencombrement · Espaces verts

Chaque prestation est évaluée sur **la qualité**, **la fréquence / le délai de passage** et
**l'évolution depuis la première enquête**. Les centres non concernés par une prestation
(déchets, désencombrement, espaces verts) la sautent automatiquement via les ramifications.

Deux blocs transverses : le **changement de prestataire de moins d'un an** (est-ce mieux
aujourd'hui ?) et le **rappel du process** — toute demande d'intervention ou signalement passe
par un ticket auprès des Services Généraux.

## Modifier le contenu

Éditer la structure `SECTIONS` dans `generate.py`, puis :

```bash
python3 generate.py                                   # md, txt, html, form.json
node generate_docx.js                                 # 05-...docx
NODE_PATH=/opt/node22/lib/node_modules node generate_pdf.js   # 06-...pdf
```

(`npm install docx` une fois pour le premier, Playwright/Chromium pour le second.)

Tous les fichiers sont régénérés, la numérotation des questions et la table des ramifications
se recalculent toutes seules.

## À compléter avant diffusion

- `[DATE LIMITE]` — date de clôture de l'enquête
- `[LIEN / OUTIL DE TICKETING]` et `[ADRESSE MAIL SERVICES GÉNÉRAUX]`
- Le logo Audika officiel et la couleur de charte, à charger dans le thème Forms

## Après l'import dans Forms

Le convertisseur de Forms ne sait produire que des questions à choix et des questions à texte
libre, et tout paragraphe libre du document devient une question. Le fichier d'import ne
contient donc que le titre et les 52 questions : l'introduction, les 9 sections, le rappel du
process et le message de fin se saisissent à la main après l'import, tout comme la grille
Likert (Q7) et la note sur 10 (Q49), que le convertisseur ne sait pas produire.

Le détail de la relecture et des corrections est dans `03-parametrage-microsoft-forms.md`, §1.
