# API du scanner — mode « sniper »

Le viseur n'envoie qu'une chose : le texte brut lu dans le rectangle de visée.
Nettoyage, transposition, correspondance approchée et détection des conflits de
rareté se font ici.

## Démarrer

```bash
pip install -r requirements.txt
python -m app.cli sync          # première synchronisation (~21 Mo, une fois)
uvicorn app.main:app --reload   # http://127.0.0.1:8000/docs
```

## Ce que fait la synchronisation

YGOPRODeck ne publie que la forme **anglaise** des codes TCG. Une carte achetée
en France porte pourtant `RA03-FR001`, et c'est cette inscription-là que la
caméra lit. L'ETL génère donc, pour chaque code anglais, son équivalent dans
chaque région du TCG (`FR`, `DE`, `IT`, `SP`, `PT`) et l'insère en base marqué
`synthetic = 1` : la carte et la rareté sont exactes, seul le code est déduit —
et l'API le signale dans sa réponse.

## Résolution d'une lecture

Trois chemins, du plus sûr au plus permissif :

| Méthode | Ce qui se passe |
|---|---|
| `exact` | le code lu existe tel quel |
| `region` | son équivalent sans région existe (`RA03-FR001` → `RA03-EN001`) |
| `fuzzy` | `rapidfuzz` trouve le plus proche au-delà de la note plancher |

Sous le plancher (`YGO_FUZZY_CUTOFF`, 82 par défaut), la réponse est `no_match`.
Désigner une carte au hasard serait pire qu'un échec : l'échec se corrige d'une
nouvelle photo, une mauvaise carte passe inaperçue.

Avant tout cela, les transpositions sont appliquées **par position** : dans le
préfixe et la région on remappe chiffre vers lettre (`0→O`, `5→S`…), dans le
numéro l'inverse (`O→0`, `I→1`…). Appliquer « O → 0 » partout détruirait `LOB`.

## Points d'entrée

| Route | Rôle |
|---|---|
| `GET /api/health` | état de la base, date de synchronisation |
| `POST /api/sync` | recharge depuis YGOPRODeck |
| `POST /api/scan` | `{"raw": "RA03-FR0O1"}` → tirage résolu, ou liste de raretés |
| `GET /api/card/{id}?language=fr` | fiche complète, textes traduits |

`POST /api/scan` répond `needs_user_selection` quand plusieurs raretés partagent
le même code : la caméra ne voit pas l'holographie, seul l'utilisateur peut
trancher.

## Réglages

| Variable | Défaut | Rôle |
|---|---|---|
| `YGO_DB_PATH` | `data/cards.sqlite3` | emplacement de la base |
| `YGO_FUZZY_CUTOFF` | `82` | note plancher de la correspondance approchée |
| `YGO_DETAIL_TTL` | `3600` | durée de vie du cache des fiches |
| `YGO_CORS_ORIGINS` | `*` | origines autorisées |

## Hébergement

FastAPI ne tourne ni sur Netlify Functions ni sur GitHub Pages, qui n'exécutent
pas de Python. Cible : Render, Railway, Fly.io ou n'importe quel conteneur. Le
front interroge l'API via `VITE_API_BASE` ; sans cette variable, il résout les
codes localement sur son index embarqué.
