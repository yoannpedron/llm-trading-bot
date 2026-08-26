# Enquête Propreté – Centres Audika – Vague 2

Kit complet pour créer le formulaire Microsoft Forms de la 2ᵉ enquête propreté / entretien
adressée à l'ensemble des centres Audika, en suivi de la première enquête (plans d'actions
et ajustements contractuels).

| Fichier | À quoi ça sert |
|---|---|
| `01-enquete-menage-audika.md` | Le contenu intégral du formulaire : intro, 9 sections, 52 questions, propositions de réponses, message de fin. C'est le document à faire valider en interne. |
| `02-import-microsoft-forms.txt` | La même chose au format collable dans l'**Importation rapide** de Microsoft Forms, pour ne pas ressaisir les questions à la main. |
| `03-parametrage-microsoft-forms.md` | Le mode opératoire Forms : découpage en sections, table des ramifications, types de questions, thème et logo, paramètres de collecte, diffusion, exploitation des résultats. |
| `04-apercu-formulaire.html` | Maquette du rendu, à ouvrir dans un navigateur pour validation avant saisie. |
| `generate.py` | Générateur des 4 fichiers ci-dessus à partir d'une source unique. |

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
python3 generate.py
```

Les quatre fichiers sont régénérés, la numérotation des questions et la table des ramifications
se recalculent toutes seules.

## À compléter avant diffusion

- `[DATE LIMITE]` — date de clôture de l'enquête
- `[LIEN / OUTIL DE TICKETING]` et `[ADRESSE MAIL SERVICES GÉNÉRAUX]`
- Le logo Audika officiel et la couleur de charte, à charger dans le thème Forms
