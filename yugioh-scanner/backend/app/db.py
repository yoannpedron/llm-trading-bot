"""Base SQLite des codes d'extension.

Elle ne contient que ce dont l'appariement a besoin : les codes, la carte à
laquelle ils renvoient, la série et la rareté. Ni texte de carte, ni image, ni
statistiques — ces informations sont demandées à l'API au moment de l'affichage,
dans la langue voulue, et n'ont donc rien à faire dans un cache local qui
vieillirait.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .config import DATABASE_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS cards (
    id                INTEGER PRIMARY KEY,
    name              TEXT    NOT NULL,
    cardmarket_price  REAL
);

CREATE TABLE IF NOT EXISTS printings (
    set_code    TEXT    NOT NULL,
    base        TEXT    NOT NULL,   -- code sans région : relie LOB-FR001 à LOB-EN001
    region      TEXT    NOT NULL,
    card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    set_name    TEXT    NOT NULL,
    rarity      TEXT    NOT NULL,
    rarity_code TEXT,
    set_price   REAL,
    -- 1 pour les variantes régionales déduites d'un tirage anglais : la carte
    -- et la rareté sont sûres, le code est reconstruit.
    synthetic   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (set_code, set_name, rarity)
);

CREATE INDEX IF NOT EXISTS idx_printings_code ON printings(set_code);
CREATE INDEX IF NOT EXISTS idx_printings_base ON printings(base);
CREATE INDEX IF NOT EXISTS idx_printings_card ON printings(card_id);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    """Ouvre la base et s'assure que le schéma existe."""
    target = Path(path) if path is not None else DATABASE_PATH
    if str(target) != ":memory:":
        target.parent.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(target, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    # WAL : les lectures ne bloquent pas pendant qu'une synchronisation écrit.
    if str(target) != ":memory:":
        connection.execute("PRAGMA journal_mode=WAL")
    connection.executescript(SCHEMA)
    return connection


@contextmanager
def transaction(connection: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise


def set_meta(connection: sqlite3.Connection, key: str, value: str) -> None:
    connection.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def get_meta(connection: sqlite3.Connection, key: str) -> str | None:
    row = connection.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def counts(connection: sqlite3.Connection) -> dict[str, int]:
    """Compteurs de contrôle, exposés par ``/api/health``."""
    return {
        "cards": connection.execute("SELECT COUNT(*) AS n FROM cards").fetchone()["n"],
        "printings": connection.execute("SELECT COUNT(*) AS n FROM printings").fetchone()["n"],
        "synthetic": connection.execute(
            "SELECT COUNT(*) AS n FROM printings WHERE synthetic = 1"
        ).fetchone()["n"],
        "distinct_codes": connection.execute(
            "SELECT COUNT(DISTINCT set_code) AS n FROM printings"
        ).fetchone()["n"],
    }
