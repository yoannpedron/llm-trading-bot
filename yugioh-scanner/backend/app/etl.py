"""Synchronisation depuis YGOPRODeck.

Deux temps :

1. on charge la base complète et on n'en retient que les codes d'extension, la
   carte associée, la série et la rareté ;
2. **on génère les variantes régionales**. C'est le point critique : YGOPRODeck
   ne publie que la forme anglaise des codes TCG, alors qu'une carte achetée en
   France porte « RA03-FR001 » et non « RA03-EN001 ». Sans ces variantes, un
   scan français ne trouverait jamais rien.

Les variantes sont marquées ``synthetic = 1``. La carte et la rareté qu'elles
portent sont exactes — c'est le même tirage dans une autre langue — mais le code
lui-même est déduit, et l'API le signale plutôt que de le faire passer pour un
relevé.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime

import httpx

from .config import YGOPRODECK_API
from .db import set_meta, transaction
from .regions import TCG_REGIONS, base_code, region_of, regional_variants


def fetch_all(timeout: float = 120.0) -> list[dict]:
    """Récupère la base complète (~21 Mo)."""
    response = httpx.get(YGOPRODECK_API, timeout=timeout, follow_redirects=True)
    response.raise_for_status()
    data = response.json().get("data")
    if not isinstance(data, list) or not data:
        raise RuntimeError("réponse YGOPRODeck vide ou inattendue")
    return data


def _as_float(value: object) -> float | None:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def rows_for(card: dict) -> tuple[tuple, list[tuple]]:
    """Prépare les lignes ``cards`` et ``printings`` d'une carte.

    Les variantes régionales sont produites ici, à côté du tirage d'origine,
    pour que l'insertion reste une seule passe.
    """
    prices = (card.get("card_prices") or [{}])[0]
    card_row = (card["id"], card["name"], _as_float(prices.get("cardmarket_price")))

    printings: list[tuple] = []
    for printing in card.get("card_sets") or []:
        code = (printing.get("set_code") or "").strip().upper()
        if not code:
            continue

        set_name = printing.get("set_name") or ""
        rarity = printing.get("set_rarity") or ""
        rarity_code = printing.get("set_rarity_code")
        set_price = _as_float(printing.get("set_price"))

        printings.append(
            (code, base_code(code), region_of(code), card["id"], set_name, rarity,
             rarity_code, set_price, 0)
        )

        for variant in regional_variants(code, TCG_REGIONS):
            printings.append(
                (variant, base_code(variant), region_of(variant), card["id"], set_name,
                 rarity, rarity_code, set_price, 1)
            )

    return card_row, printings


def load(connection: sqlite3.Connection, cards: list[dict]) -> dict[str, int]:
    """Remplit la base à partir des cartes reçues, en remplaçant l'existant."""
    card_rows: list[tuple] = []
    printing_rows: list[tuple] = []

    for card in cards:
        card_row, printings = rows_for(card)
        card_rows.append(card_row)
        printing_rows.extend(printings)

    with transaction(connection):
        connection.execute("DELETE FROM printings")
        connection.execute("DELETE FROM cards")
        connection.executemany("INSERT INTO cards(id, name, cardmarket_price) VALUES(?,?,?)", card_rows)
        # Un même code peut revenir avec la même série et la même rareté à
        # travers plusieurs cartes de la réponse : on ignore le doublon.
        connection.executemany(
            "INSERT OR IGNORE INTO printings("
            "set_code, base, region, card_id, set_name, rarity, rarity_code, set_price, synthetic"
            ") VALUES(?,?,?,?,?,?,?,?,?)",
            printing_rows,
        )
        set_meta(connection, "synced_at", datetime.now(UTC).isoformat(timespec="seconds"))
        set_meta(connection, "source", YGOPRODECK_API)

    return {
        "cards": len(card_rows),
        "printings": len(printing_rows),
        "synthetic": sum(1 for row in printing_rows if row[-1] == 1),
    }


def sync(connection: sqlite3.Connection) -> dict[str, int]:
    """Télécharge puis charge. C'est ce qu'appelle la commande de mise à jour."""
    return load(connection, fetch_all())
