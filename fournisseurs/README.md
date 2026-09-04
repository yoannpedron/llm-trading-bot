# Table fournisseurs consolidée

`Table_fournisseurs_consolidee.xlsx` — annuaire fournisseurs Audika consolidé en **un seul onglet
`Fournisseurs`**, table à plat : **une ligne par contact**, 190 lignes, 52 fournisseurs.
Les informations fournisseur sont répétées sur chaque ligne du groupe pour que le tableau reste
filtrable et triable tel quel (filtre automatique posé, volets figés).

## Colonnes

| Colonne | Contenu |
|---|---|
| Pôle | `SGX Réseau` — l'annuaire FRN relève du réseau ; aucun pôle n'est renseigné dans la source. |
| Fournisseur | Raison sociale telle que saisie en colonne ENTREPRISE. |
| Code fournisseur | Référence seule, extraite du champ « N° COMPTE FRN AUDIKA » (`FSAB0010`, `V000112`). |
| Code fournisseur 2 | Raison sociale du même champ (`ABIOXIR`). |
| Domaine d'activité | Domaines cumulés en cas de fusion de doublons. |
| Région / Centre(s) | Valeur de la ligne si elle est renseignée, sinon celle du fournisseur. |
| Coordonnées téléphoniques | Ligne principale du fournisseur (standard / accueil / info en priorité), répétée sur ses lignes. |
| Personne à contacter | Nom du contact, ou libellé du service quand la source ne nomme personne. |
| Fonction | Fonction du contact. |
| Numéro | Numéro(s) directs du contact (fixe / portable, séparés par ` / `). |
| Courriel | Courriel du contact. |
| Commentaire | Commentaire source + notes de consolidation (points à vérifier). |

## Sources

- `Annuaire_FRN.xlsx`, onglets « annuaire FRN contrats » (175 lignes de contact) et
  « annuaire FRN espaces verts » (10 lignes) — source unique des coordonnées.
- `Audika_Table_correspondance_centres.xlsx` — table de correspondance des 632 centres transmise
  à Eurofeu. Ne contient aucune coordonnée fournisseur : rien à reprendre. Eurofeu figure déjà
  dans l'annuaire (SÉCURITÉ INCENDIE).
- Fichier de Lucile (Teams) : non fourni, à intégrer dès réception.

## Règles de consolidation

- **Code fournisseur** : le champ source mélange référence et raison sociale avec des séparateurs
  variables (`FSAB0095, ABH`, `FSCL0047,CLIMTEC`, `FSNI0015 NISSE FRERES`, `F/FSDC0004, DC PAYSAGE`).
  La référence est extraite par expression régulière, un préfixe parasite (`F/`) est retiré de la
  colonne et signalé en commentaire.
- **Numéros** : beaucoup sont stockés au format nombre dans la source et ont perdu leur 0 initial
  (ex. `299602704`). Le zéro est rétabli et le numéro remis au format `02 99 60 27 04`.
- **Doublons** : fusion des fournisseurs sur le nom normalisé (accents et ponctuation ignorés),
  domaines cumulés — MTE LOGISTIC (saisi 2 fois) et JH EXTERIEUR (présent dans les deux onglets).
  Les lignes de contact strictement identiques issues de cette fusion sont dédoublonnées.
- **Répartition des numéros** : les libellés de service (standard, SAV, agence, plateforme, pôle,
  comptabilité…) désignent la ligne principale du fournisseur ; ils restent par ailleurs une ligne
  du tableau, au même titre qu'une personne nommée.
- **Aucune donnée perdue** : les 185 lignes de contact des sources sont reprises, y compris les
  contacts sans téléphone. Les fournisseurs sans aucun contact occupent une ligne avec les seules
  informations société.

## Points relevés pendant la consolidation

Ils sont portés en clair dans la colonne `Commentaire` de la ligne concernée :

- **GRAF SERVICES PLUS** : 3 contacts `@gestivert.fr` sous un fournisseur dont le premier contact
  est `@stihle.fr` — raison sociale probablement manquante dans la source, à confirmer.
- **EUROFEU** : un numéro (`06 61 37 80 27`) sans nom ni libellé ; comptes clients `C660995`
  (SOGECA) et `C660964` (AUDIKA ALPES) saisis en colonne ENTREPRISE.
- **TECH 9 ENERGIE** : domaine absent de la source, « Climaticien » ayant été saisi en colonne
  Centre — rétabli.
- **4 fournisseurs sans n° de compte** : CRYSTAL FROID, INRATABLE, MTE LOGISTIC, VERT BEAU BOIS.
- **8 fournisseurs sans aucun téléphone** : ATELIER DES TOITURES, AUTOMATISMES LABADEN,
  COPAS SYSTEMES, CTS, JEROMES LES JARDINIERS, JULIEN DELEUSE, STAFF CLEAN 3D, VERT BEAU BOIS.

## Régénérer le fichier

```bash
python3 build_table_fournisseurs.py Annuaire_FRN.xlsx Table_fournisseurs_consolidee.xlsx
```

Seul `openpyxl` est requis. Le script est idempotent : relancé après ajout du fichier de Lucile
dans les sources, il reproduit la même table enrichie.
