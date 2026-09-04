"""Résolution d'une lecture OCR en tirage réel.

Trois chemins, du plus sûr au plus permissif :

1. **exact** — le code lu existe tel quel en base ;
2. **régional** — le code lu ne s'y trouve pas, mais son équivalent sans région
   oui : la carte française « RA03-FR001 » retombe sur « RA03-EN001 » ;
3. **approché** — ``rapidfuzz`` cherche le code le plus proche parmi tous ceux
   connus, au-delà d'une note plancher.

Le plancher compte autant que le reste : sous cette note, on répond « je ne sais
pas ». Désigner une carte au hasard serait pire qu'un échec, parce que l'échec se
corrige d'une nouvelle photo alors qu'une mauvaise carte passe inaperçue.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field

from rapidfuzz import fuzz, process

from .config import FUZZY_CUTOFF
from .normalize import extract_candidates
from .regions import base_code


@dataclass(slots=True)
class Resolution:
    """Ce qu'on a su tirer d'une lecture."""

    status: str
    read: str | None = None
    candidates: list[str] = field(default_factory=list)
    code: str | None = None
    matched_code: str | None = None
    method: str | None = None
    confidence: float = 0.0
    synthetic: bool = False

    def as_dict(self) -> dict:
        return {
            "status": self.status,
            "read": self.read,
            "candidates": self.candidates,
            "code": self.code,
            "matched_code": self.matched_code,
            "method": self.method,
            "confidence": round(self.confidence, 1),
            "synthetic": self.synthetic,
        }


class CodeMatcher:
    """Index mémoire des codes connus, adossé à la base.

    La liste des codes distincts est chargée une fois : ``rapidfuzz`` travaille
    en C++ sur des chaînes courtes, ce qui rend une recherche exhaustive plus
    rapide qu'un aller-retour SQL pour chaque candidat.
    """

    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection
        self._codes: list[str] = []
        self._bases: set[str] = set()
        self.refresh()

    def refresh(self) -> None:
        rows = self.connection.execute("SELECT DISTINCT set_code, base FROM printings").fetchall()
        self._codes = [row["set_code"] for row in rows]
        self._bases = {row["base"] for row in rows}

    @property
    def size(self) -> int:
        return len(self._codes)

    # -- recherches élémentaires ------------------------------------------

    def _exact(self, code: str) -> str | None:
        row = self.connection.execute(
            "SELECT set_code FROM printings WHERE set_code = ? LIMIT 1", (code,)
        ).fetchone()
        return row["set_code"] if row else None

    def _by_region(self, code: str) -> str | None:
        """Un tirage partageant le code hors région — la variante d'une autre langue."""
        row = self.connection.execute(
            "SELECT set_code FROM printings WHERE base = ? ORDER BY synthetic, set_code LIMIT 1",
            (base_code(code),),
        ).fetchone()
        return row["set_code"] if row else None

    def _fuzzy(self, code: str) -> tuple[str, float] | None:
        if not self._codes:
            return None
        found = process.extractOne(
            code,
            self._codes,
            scorer=fuzz.ratio,
            score_cutoff=FUZZY_CUTOFF,
        )
        return (found[0], found[1]) if found else None

    # -- résolution complète ----------------------------------------------

    def resolve(self, raw: str) -> Resolution:
        candidates = extract_candidates(raw)
        if not candidates:
            return Resolution(status="no_code", read=raw)

        # On tente les chemins sûrs sur tous les candidats avant d'accepter une
        # correspondance approchée : un code exact plus bas dans la liste vaut
        # mieux qu'un à-peu-près sur le premier.
        for method, lookup in (("exact", self._exact), ("region", self._by_region)):
            for candidate in candidates:
                found = lookup(candidate)
                if found:
                    return self._describe(candidate, found, method, 100.0, candidates)

        best: tuple[str, str, float] | None = None
        for candidate in candidates:
            found = self._fuzzy(candidate)
            if found and (best is None or found[1] > best[2]):
                best = (candidate, found[0], found[1])

        if best is None:
            return Resolution(status="no_match", read=raw, candidates=candidates)

        return self._describe(best[0], best[1], "fuzzy", best[2], candidates)

    def _describe(
        self, read: str, matched: str, method: str, confidence: float, candidates: list[str]
    ) -> Resolution:
        row = self.connection.execute(
            "SELECT synthetic FROM printings WHERE set_code = ? ORDER BY synthetic LIMIT 1",
            (matched,),
        ).fetchone()
        return Resolution(
            status="matched",
            read=read,
            candidates=candidates,
            code=read,
            matched_code=matched,
            method=method,
            confidence=confidence,
            synthetic=bool(row["synthetic"]) if row else False,
        )


def printings_for(connection: sqlite3.Connection, set_code: str) -> list[dict]:
    """Tirages portant ce code, du plus rare au plus commun n'étant pas connu ici
    on garde l'ordre de la base : série puis rareté."""
    rows = connection.execute(
        """
        SELECT p.set_code, p.set_name, p.rarity, p.rarity_code, p.set_price, p.synthetic,
               c.id AS card_id, c.name AS card_name, c.cardmarket_price
        FROM printings p
        JOIN cards c ON c.id = p.card_id
        WHERE p.set_code = ?
        ORDER BY p.set_name, p.rarity
        """,
        (set_code,),
    ).fetchall()
    return [dict(row) for row in rows]


def group_rarities(printings: list[dict]) -> list[dict]:
    """Une entrée par rareté distincte : c'est le seul axe que l'utilisateur doit
    trancher, la caméra ne voyant pas l'holographie."""
    seen: dict[str, dict] = {}
    for printing in printings:
        rarity = printing["rarity"]
        if rarity in seen:
            continue
        seen[rarity] = {
            "rarity": rarity,
            "rarity_code": printing["rarity_code"],
            "set_name": printing["set_name"],
            "set_code": printing["set_code"],
            # Prix Cardmarket de la carte, toutes raretés confondues : c'est tout
            # ce que la source publie. Le prix par tirage est en dollars.
            "price_eur": printing["cardmarket_price"],
            "set_price_usd": printing["set_price"],
            "synthetic": bool(printing["synthetic"]),
        }
    return list(seen.values())
