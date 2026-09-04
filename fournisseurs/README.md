# Table fournisseurs consolidée

`Table_fournisseurs_consolidee.xlsx` — annuaire fournisseurs Audika ramené à la table simple
demandée : **Fournisseur / Domaine d'activité / Coordonnées téléphoniques / Personne à contacter (téléphone)**.

## Contenu du classeur

| Onglet | Contenu |
|---|---|
| `Fournisseurs` | La table demandée. Une ligne par fournisseur (52), doublons fusionnés. |
| `Détail contacts` | Une ligne par contact (185), toutes les colonnes sources conservées : n° de compte FRN, région, centres, fonction, courriel, commentaire, onglet d'origine. |
| `Sources & à vérifier` | Provenance des données + les 10 points relevés pendant la consolidation. |

## Sources

- `Annuaire_FRN.xlsx`, onglets « annuaire FRN contrats » (175 lignes de contact) et
  « annuaire FRN espaces verts » (10 lignes) — source unique des coordonnées.
- `Audika_Table_correspondance_centres.xlsx` — table de correspondance des 632 centres
  transmise à Eurofeu. Ne contient aucune coordonnée fournisseur : rien à reprendre.
  Eurofeu figure déjà dans l'annuaire (SÉCURITÉ INCENDIE).
- Fichier de Lucile (Teams) : non fourni, à intégrer dès réception.

## Règles de consolidation

- **Répartition des numéros** : les libellés de service (standard, SAV, agence, plateforme,
  pôle, comptabilité…) alimentent *Coordonnées téléphoniques* ; les personnes nommées
  alimentent *Personne à contacter (téléphone)*.
- **Numéros** : beaucoup sont stockés au format nombre dans la source et ont perdu leur 0
  initial (ex. `299602704`). Le zéro est rétabli et le numéro remis au format `02 99 60 27 04`.
- **Doublons** : fusion sur le nom normalisé (accents et ponctuation ignorés), domaines cumulés.
  MTE LOGISTIC (saisi 2 fois) et JH EXTERIEUR (présent dans les deux onglets) sont fusionnés.
- **Aucune donnée perdue** : les 185 lignes de contact des sources sont reprises telles quelles
  dans l'onglet `Détail contacts`, y compris les contacts sans téléphone (absents de la table
  simple, qui est un annuaire téléphonique).

## Régénérer le fichier

```bash
python3 build_table_fournisseurs.py Annuaire_FRN.xlsx Audika_Table_correspondance_centres.xlsx Table_fournisseurs_consolidee.xlsx
```

Seul `openpyxl` est requis. Le script est idempotent : relancé après ajout du fichier de Lucile
dans les sources, il reproduit la même table enrichie.
