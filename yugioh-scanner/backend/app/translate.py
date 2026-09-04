"""Libellés français des types et catégories de cartes.

`?language=fr` traduit le nom et le texte de la carte, mais laisse `type` et
`race` en anglais. Comme le panneau affiche « [Dragon / Effet] », on complète
ici. Une valeur inconnue est renvoyée telle quelle : mieux vaut un mot anglais
qu'un trou.
"""

from __future__ import annotations

TYPES = {
    "Effect Monster": "Monstre à Effet",
    "Normal Monster": "Monstre Normal",
    "Normal Tuner Monster": "Monstre Syntoniseur Normal",
    "Tuner Monster": "Monstre Syntoniseur",
    "Flip Effect Monster": "Monstre à Effet Flip",
    "Gemini Monster": "Monstre Gemini",
    "Spirit Monster": "Monstre Esprit",
    "Union Effect Monster": "Monstre Union",
    "Toon Monster": "Monstre Toon",
    "Ritual Monster": "Monstre Rituel",
    "Ritual Effect Monster": "Monstre Rituel à Effet",
    "Fusion Monster": "Monstre Fusion",
    "Synchro Monster": "Monstre Synchro",
    "Synchro Tuner Monster": "Monstre Synchro Syntoniseur",
    "XYZ Monster": "Monstre Xyz",
    "Pendulum Effect Monster": "Monstre Pendule à Effet",
    "Pendulum Normal Monster": "Monstre Pendule Normal",
    "Link Monster": "Monstre Lien",
    "Spell Card": "Carte Magie",
    "Trap Card": "Carte Piège",
    "Skill Card": "Carte Compétence",
    "Token": "Jeton",
}

RACES = {
    "Aqua": "Aqua", "Beast": "Bête", "Beast-Warrior": "Bête-Guerrier",
    "Creator-God": "Dieu Créateur", "Cyberse": "Cyberse", "Dinosaur": "Dinosaure",
    "Divine-Beast": "Bête Divine", "Dragon": "Dragon", "Fairy": "Elfe",
    "Fiend": "Démon", "Fish": "Poisson", "Insect": "Insecte",
    "Machine": "Machine", "Plant": "Plante", "Psychic": "Psychique",
    "Pyro": "Pyro", "Reptile": "Reptile", "Rock": "Rocher",
    "Sea Serpent": "Serpent de Mer", "Spellcaster": "Magicien",
    "Thunder": "Tonnerre", "Warrior": "Guerrier", "Winged Beast": "Bête Ailée",
    "Wyrm": "Wyrm", "Zombie": "Zombie",
    # Magies et pièges : `race` porte le sous-type.
    "Normal": "Normale", "Field": "Terrain", "Equip": "Équipement",
    "Continuous": "Continue", "Quick-Play": "Jeu-Rapide", "Ritual": "Rituel",
    "Counter": "Contre",
}

ATTRIBUTES = {
    "DARK": "TÉNÈBRES", "LIGHT": "LUMIÈRE", "EARTH": "TERRE",
    "WATER": "EAU", "FIRE": "FEU", "WIND": "VENT", "DIVINE": "DIVIN",
}


def type_fr(value: str | None) -> str:
    return TYPES.get(value or "", value or "")


def race_fr(value: str | None) -> str:
    return RACES.get(value or "", value or "")


def attribute_fr(value: str | None) -> str:
    return ATTRIBUTES.get(value or "", value or "")


def subtitle(card: dict) -> str:
    """Sous-titre du panneau : « [Dragon / Monstre Normal] »."""
    parts = [race_fr(card.get("race")), type_fr(card.get("type"))]
    return "[" + " / ".join(part for part in parts if part) + "]"
