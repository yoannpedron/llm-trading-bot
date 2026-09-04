"""Fiche détaillée d'une carte, dans la langue demandée.

La base locale ne stocke que les codes : le texte, les statistiques et l'image
sont demandés ici, au moment de l'affichage. C'est ce qui permet d'obtenir le
nom et l'effet en français sans dupliquer toute la base dans chaque langue.

L'image reste l'illustration anglaise universelle — c'est la seule que
YGOPRODeck publie, et c'est celle que l'interface affiche telle quelle.
"""

from __future__ import annotations

import time

import httpx

from .config import DETAIL_TTL_SECONDS, YGOPRODECK_API
from .translate import attribute_fr, race_fr, subtitle, type_fr

_cache: dict[tuple[int, str], tuple[float, dict]] = {}


def _shape(card: dict) -> dict:
    prices = (card.get("card_prices") or [{}])[0]

    def price(key: str) -> float | None:
        try:
            value = float(prices.get(key))
        except (TypeError, ValueError):
            return None
        return value if value > 0 else None

    images = card.get("card_images") or [{}]
    return {
        "id": card.get("id"),
        "name": card.get("name"),
        "type": type_fr(card.get("type")),
        "race": race_fr(card.get("race")),
        "attribute": attribute_fr(card.get("attribute")),
        "subtitle": subtitle(card),
        "atk": card.get("atk"),
        "def": card.get("def"),
        "level": card.get("level"),
        "linkval": card.get("linkval"),
        "desc": card.get("desc"),
        "image": images[0].get("image_url"),
        "image_small": images[0].get("image_url_small"),
        "prices": {
            "cardmarket_eur": price("cardmarket_price"),
            "tcgplayer_usd": price("tcgplayer_price"),
        },
    }


def fetch_card(card_id: int, language: str = "fr", timeout: float = 10.0) -> dict | None:
    """Fiche d'une carte, mise en cache pour la durée configurée."""
    key = (card_id, language)
    cached = _cache.get(key)
    if cached and time.time() - cached[0] < DETAIL_TTL_SECONDS:
        return cached[1]

    params: dict[str, str | int] = {"id": card_id}
    # `language=en` n'est pas une valeur acceptée : l'anglais est le défaut.
    if language and language != "en":
        params["language"] = language

    response = httpx.get(YGOPRODECK_API, params=params, timeout=timeout, follow_redirects=True)
    if response.status_code == 400:
        # La base traduite ne contient pas toutes les cartes : on retombe sur
        # l'anglais plutôt que de ne rien afficher.
        if language and language != "en":
            return fetch_card(card_id, "en", timeout)
        return None
    response.raise_for_status()

    data = (response.json() or {}).get("data") or []
    if not data:
        return None

    shaped = _shape(data[0])
    _cache[key] = (time.time(), shaped)
    return shaped
