"""Réglages, tous surchargeables par variable d'environnement."""

from __future__ import annotations

import os
from pathlib import Path

#: Emplacement de la base locale.
DATABASE_PATH = Path(os.environ.get("YGO_DB_PATH", "data/cards.sqlite3"))

#: Source des données cartes.
YGOPRODECK_API = os.environ.get("YGO_API", "https://db.ygoprodeck.com/api/v7/cardinfo.php")

#: Note minimale (0-100) pour qu'une correspondance approchée soit retenue.
#: En dessous, mieux vaut répondre « je ne sais pas » que désigner une carte au
#: hasard : l'utilisateur reprendra sa photo, il ne débusquera pas une erreur.
FUZZY_CUTOFF = float(os.environ.get("YGO_FUZZY_CUTOFF", "82"))

#: Durée de vie du cache mémoire des fiches détaillées.
DETAIL_TTL_SECONDS = int(os.environ.get("YGO_DETAIL_TTL", "3600"))

#: Origines autorisées à appeler l'API depuis un navigateur.
CORS_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("YGO_CORS_ORIGINS", "*").split(",")
    if origin.strip()
]
