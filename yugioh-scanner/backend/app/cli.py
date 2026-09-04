"""Commandes d'administration.

    python -m app.cli sync     # recharge la base depuis YGOPRODeck
    python -m app.cli stats    # état de la base
"""

from __future__ import annotations

import sys

from .db import connect, counts, get_meta
from .etl import sync


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "stats"
    connection = connect()

    if command == "sync":
        result = sync(connection)
        print(
            f"{result['cards']} cartes, {result['printings']} tirages "
            f"dont {result['synthetic']} variantes régionales"
        )
        return 0

    if command == "stats":
        print(f"synchronisé le : {get_meta(connection, 'synced_at') or 'jamais'}")
        for key, value in counts(connection).items():
            print(f"{key:>16} : {value}")
        return 0

    print(f"commande inconnue : {command}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
