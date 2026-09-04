"""Régionalisation des codes d'extension.

YGOPRODeck ne publie que la variante anglaise des codes TCG : « LOB-EN001 ».
Une carte achetée en France porte pourtant « LOB-FR001 », et c'est cette
inscription-là que la caméra va lire. Sans génération des variantes, un scan
français ne trouverait jamais rien.

On dérive donc, pour chaque code anglais, son équivalent dans chaque région du
TCG, et on l'insère en base en le marquant comme *synthétique* : la carte, la
rareté et le prix viennent du tirage anglais, seul le code change. L'API le dit
explicitement dans sa réponse plutôt que de faire passer une déduction pour un
relevé.
"""

from __future__ import annotations

import re

#: Régions du TCG occidental, dans l'ordre d'usage.
TCG_REGIONS: tuple[str, ...] = ("EN", "FR", "DE", "IT", "SP", "PT")

#: Régions rencontrées dans la base, TCG et OCG confondus.
ALL_REGIONS: tuple[str, ...] = TCG_REGIONS + ("JP", "KR", "AE", "EU")

#: `PRÉFIXE` - `RÉGION` `[LETTRE DE SÉRIE]` `NUMÉRO`.
#: La lettre de série existe (« SS01-ENA01 », « LDK2-ENJ01 ») ; le numéro fait
#: trois chiffres dans l'immense majorité des cas, deux ou quatre à la marge.
SET_CODE = re.compile(
    r"^(?P<prefix>[A-Z0-9]{2,5})-(?P<region>[A-Z]{2})(?P<serial>[A-Z]?)(?P<number>\d{2,4})$"
)

#: Codes anciens sans région : « LOB-001 ».
SET_CODE_NO_REGION = re.compile(r"^(?P<prefix>[A-Z0-9]{2,5})-(?P<number>\d{2,4})$")


def split_set_code(code: str) -> dict[str, str] | None:
    """Décompose un code imprimé. Renvoie ``None`` si la forme est inconnue."""
    text = (code or "").strip().upper()

    match = SET_CODE.match(text)
    if match:
        return {
            "prefix": match["prefix"],
            "region": match["region"],
            "serial": match["serial"],
            "number": match["number"],
        }

    match = SET_CODE_NO_REGION.match(text)
    if match:
        return {"prefix": match["prefix"], "region": "", "serial": "", "number": match["number"]}

    return None


def base_code(code: str) -> str:
    """Code débarrassé de sa région : la clé qui relie « LOB-FR001 » à « LOB-EN001 ».

    Une forme inconnue est renvoyée telle quelle plutôt qu'écartée : mieux vaut
    une clé un peu bancale qu'un tirage absent de l'index.
    """
    parts = split_set_code(code)
    if parts is None:
        return (code or "").strip().upper()
    return f"{parts['prefix']}-{parts['serial']}{parts['number']}"


def region_of(code: str) -> str:
    parts = split_set_code(code)
    return parts["region"] if parts else ""


def regional_variants(code: str, regions: tuple[str, ...] = TCG_REGIONS) -> list[str]:
    """Les codes équivalents dans les autres régions, code d'origine exclu.

    Un code sans région (ancien OCG) n'en engendre aucune : on n'a rien à y
    substituer.
    """
    parts = split_set_code(code)
    if parts is None or not parts["region"]:
        return []

    return [
        f"{parts['prefix']}-{region}{parts['serial']}{parts['number']}"
        for region in regions
        if region != parts["region"]
    ]
