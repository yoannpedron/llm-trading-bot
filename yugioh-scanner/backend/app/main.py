"""API du scanner « sniper ».

Le viseur n'envoie qu'une chose : le texte brut lu dans le rectangle de visée.
Tout le reste — nettoyage, transposition, correspondance approchée, détection des
conflits de rareté — se passe ici.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .config import CORS_ORIGINS
from .db import connect, counts, get_meta
from .etl import sync
from .matching import CodeMatcher, group_rarities, printings_for
from .ygoprodeck import fetch_card

app = FastAPI(
    title="Scanner Yu-Gi-Oh — API",
    version="1.0.0",
    description="Résolution d'un code d'extension lu à la caméra, et fiche carte en français.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

connection = connect()
matcher = CodeMatcher(connection)


@app.get("/api/health")
def health() -> dict:
    """État de la base. Utile pour savoir si une synchronisation est nécessaire."""
    return {
        "status": "ok" if matcher.size else "empty",
        "synced_at": get_meta(connection, "synced_at"),
        **counts(connection),
    }


@app.post("/api/sync")
def run_sync() -> dict:
    """Recharge la base depuis YGOPRODeck et régénère les variantes régionales."""
    try:
        result = sync(connection)
    except Exception as error:  # noqa: BLE001 - on veut le message côté client
        raise HTTPException(status_code=502, detail=f"synchronisation impossible : {error}") from error

    matcher.refresh()
    return {"status": "ok", **result}


@app.post("/api/scan")
def scan(raw: Annotated[str, Body(embed=True)]) -> dict:
    """Résout une lecture OCR.

    Réponses possibles :

    - ``no_code`` — rien qui ressemble à un code dans le texte reçu ;
    - ``no_match`` — un code lisible, mais aucun tirage assez proche ;
    - ``resolved`` — une seule rareté, rien à demander ;
    - ``needs_user_selection`` — plusieurs raretés partagent ce code, seul l'œil
      humain peut trancher : la caméra ne voit pas l'holographie.
    """
    resolution = matcher.resolve(raw)
    payload = resolution.as_dict()

    if resolution.status != "matched":
        return payload

    printings = printings_for(connection, resolution.matched_code or "")
    if not printings:
        return {**payload, "status": "no_match"}

    rarities = group_rarities(printings)
    payload["card"] = {"id": printings[0]["card_id"], "name": printings[0]["card_name"]}
    payload["rarities"] = rarities
    payload["status"] = "needs_user_selection" if len(rarities) > 1 else "resolved"
    if len(rarities) == 1:
        payload["rarity"] = rarities[0]

    return payload


@app.get("/api/card/{card_id}")
def card(card_id: int, language: Annotated[str, Query(pattern="^[a-z]{2}$")] = "fr") -> dict:
    """Fiche complète, textes traduits, image officielle."""
    detail = fetch_card(card_id, language)
    if detail is None:
        raise HTTPException(status_code=404, detail="carte introuvable")
    return detail
