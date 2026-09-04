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
#:
#: Même valeur, même formule et même sens que ``FUZZY_CUTOFF`` dans
#: ``src/lib/match.js`` : à 88, une clé sans région de sept ou huit caractères
#: doit être lue sans faute. Mesuré par ``scripts/ocr-confusions.mjs`` — voir
#: ``PASSATION.md`` § 3 avant de changer l'un sans l'autre.
FUZZY_CUTOFF = float(os.environ.get("YGO_FUZZY_CUTOFF", "88"))

#: Écart minimal (0-100) entre le meilleur candidat approché et le second.
#: Deux codes différents à la même note ne désignent rien. Miroir de
#: ``FUZZY_MARGIN`` côté client.
FUZZY_MARGIN = float(os.environ.get("YGO_FUZZY_MARGIN", "1"))

#: Durée de vie du cache mémoire des fiches détaillées.
DETAIL_TTL_SECONDS = int(os.environ.get("YGO_DETAIL_TTL", "3600"))

#: Origines autorisées à appeler l'API depuis un navigateur.
CORS_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("YGO_CORS_ORIGINS", "*").split(",")
    if origin.strip()
]
