# Procédures — Services Généraux Audika

Un document par procédure, même charte : bandeau de référence, titre, chapô, ligne
Version / Diffusion sous filet turquoise, sections numérotées, pied de page paginé.

| Procédure | Réf. | Fichier | Pages |
|---|---|---|---|
| Commander sur le webshop Lyreco | PRO-ACH-001 | `PRO-ACH-001_Commander_sur_le_webshop_Lyreco.docx` | 1 |
| Déverrouillage et manutention des cloisons mobiles | PRO-SG-002 | `PRO-SG-002_Cloisons_mobiles.docx` | 2 |

Les `.pdf` du même nom sont les rendus de contrôle.

## Maintenance

`PRO-ACH-001` se met à jour directement dans Word : c'est la version raccourcie par le
service achats, il n'y a pas de générateur.

`PRO-SG-002` est produit par `build-cloisons.js` (`npm install docx && node build-cloisons.js`),
qui intègre `plan.jpg`. Une correction faite à la main dans le `.docx` serait écrasée au
prochain lancement du script : modifiez le script, ou abandonnez-le et passez au tout-Word.

`procedure-lyreco.html` est la version web longue de la procédure Lyreco (3 pages à
l'impression), conservée pour référence.

## À compléter

`PRO-SG-002` : le site concerné, surligné en jaune.

## Sources

Procédure Lyreco : webshop Lyreco (libellés de menus, arborescence des comptes), guide
utilisateur et centre d'aide Lyreco, conditions commerciales publiées.
Procédure cloisons : SOP existant des Services Généraux, repris mot pour mot — gestes,
courses des plinthes et ordre des zones inchangés.
