"""Isole les tests de la base réelle.

`app.main` ouvre une connexion au moment de l'import : la variable
d'environnement doit donc être posée avant, sans quoi les tests écriraient dans
la base de production.
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_TMP = Path(tempfile.mkdtemp(prefix="ygo-tests-")) / "cards.sqlite3"
os.environ["YGO_DB_PATH"] = str(_TMP)

import pytest  # noqa: E402

from app.db import connect  # noqa: E402
from app.etl import load  # noqa: E402

#: Jeu de cartes minimal mais représentatif : une carte à rareté unique, une
#: carte présente en deux raretés sous le même code, et une carte d'une autre
#: série pour vérifier que l'appariement ne déborde pas.
CARDS = [
    {
        "id": 89631139,
        "name": "Blue-Eyes White Dragon",
        "card_prices": [{"cardmarket_price": "0.02"}],
        "card_sets": [
            {
                "set_code": "LOB-EN001",
                "set_name": "Legend of Blue Eyes White Dragon",
                "set_rarity": "Ultra Rare",
                "set_rarity_code": "(UR)",
                "set_price": "0",
            }
        ],
    },
    {
        "id": 46052923,
        "name": "Beast Fangs",
        "card_prices": [{"cardmarket_price": "0.15"}],
        "card_sets": [
            {
                "set_code": "LOB-EN041",
                "set_name": "Legend of Blue Eyes White Dragon",
                "set_rarity": "Short Print",
                "set_rarity_code": "(SP)",
                "set_price": "2.46",
            },
            {
                "set_code": "LOB-EN041",
                "set_name": "Legend of Blue Eyes White Dragon (25th Anniversary Edition)",
                "set_rarity": "Common",
                "set_rarity_code": "(C)",
                "set_price": "0",
            },
        ],
    },
    {
        "id": 55144522,
        "name": "Pot of Greed",
        "card_prices": [{"cardmarket_price": "0.30"}],
        "card_sets": [
            {
                "set_code": "MRD-EN101",
                "set_name": "Metal Raiders",
                "set_rarity": "Common",
                "set_rarity_code": "(C)",
                "set_price": "0.10",
            }
        ],
    },
]


@pytest.fixture
def db():
    connection = connect(":memory:")
    load(connection, CARDS)
    yield connection
    connection.close()


@pytest.fixture
def matcher(db):
    from app.matching import CodeMatcher

    return CodeMatcher(db)
