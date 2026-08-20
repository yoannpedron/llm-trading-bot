# Procédures — Services Généraux Audika

Un document par procédure, **générés par le même script** pour que la mise en forme soit
strictement identique : Arial pour les titres et libellés, Cambria pour le corps de texte,
turquoise 0D5C63 en accent, bandeau « PROCÉDURE INTERNE », ligne Version / Diffusion sous
filet d'accent, sections numérotées, pied de page « Document interne » suivi de la pagination.

| Procédure | Réf. | Fichier | Pages |
|---|---|---|---|
| Commander sur le webshop Lyreco | PRO-ACH-001 | `PRO-ACH-001_Commander_sur_le_webshop_Lyreco.docx` | 1 |
| Déverrouillage et manutention des cloisons mobiles | PRO-SG-002 | `PRO-SG-002_Cloisons_mobiles.docx` | 2 |
| Gestion des accès au siège social | PRO-SG-003 | `PRO-SG-003_Gestion_des_acces_au_siege.docx` | 2 |

Les `.pdf` du même nom sont les rendus de contrôle.

## Régénérer

```
npm install docx && node build-procedures.js
```

Le script écrit les deux `.docx`. Le contenu de chaque procédure est en clair dans les blocs
`P1`, `P2` et `P3` ; la charte est dans les constantes du haut de fichier. Balisage disponible dans
les textes : `**gras**`, `` `chemin d'écran` ``, `//italique//`, `{{champ à compléter}}`.

## Attention aux retouches dans Word

Enregistrer dans Word réécrit les valeurs par défaut du document : c'est ce qui avait fait
passer le corps de texte de Cambria à Calibri sur une version précédente. La police est
désormais posée explicitement sur chaque bloc, mais si vous retouchez un `.docx` à la main,
la modification sera perdue au prochain lancement du script. Corrigez plutôt dans
`build-procedures.js`.

## À compléter

Surligné en jaune dans les documents :

- `PRO-SG-002` : le site concerné.
- `PRO-SG-003` : le numéro de téléphone du responsable, le mode opératoire de la création
  d'étiquette (section 2, non rédigé dans la source), et quatre emplacements de captures d'écran.

## Sources

Procédure Lyreco : webshop Lyreco (libellés de menus, arborescence des comptes), guide
utilisateur et centre d'aide Lyreco, conditions commerciales publiées.
Procédure cloisons : SOP existant des Services Généraux, repris mot pour mot — gestes,
courses des plinthes et ordre des zones inchangés.
Procédure accès : brouillon « Carte procédure » des Services Généraux, repris à l'identique —
écrans VISOR, convention de nommage et règle de validation des permissions inchangés.
