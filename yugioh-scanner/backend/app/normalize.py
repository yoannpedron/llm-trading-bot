"""Nettoyage et transposition des lectures OCR.

Un code d'extension a une forme rigide — préfixe, région, numéro — donc on sait
pour chaque position si un chiffre ou une lettre est attendu. Les tables de
transposition ci-dessous sont appliquées **selon la position**, et non
globalement : appliquer « O → 0 » partout détruirait « LOB », appliquer
« 0 → O » partout détruirait « 001 ».

C'est ce qui rattrape « L0B-EN0O1 » en « LOB-EN001 » sans jamais abîmer un code
déjà correct.
"""

from __future__ import annotations

import re

#: Glyphe lu comme un chiffre là où une lettre est attendue.
DIGIT_TO_LETTER = {"0": "O", "1": "I", "2": "Z", "5": "S", "6": "G", "8": "B"}

#: Glyphe lu comme une lettre là où un chiffre est attendu.
LETTER_TO_DIGIT = {
    "O": "0",
    "Q": "0",
    "D": "0",
    "I": "1",
    "L": "1",
    "Z": "2",
    "S": "5",
    "G": "6",
    "B": "8",
}

#: Lettres que Tesseract intervertit réellement entre elles. Sert à recaler une
#: région : « EM » est à un caractère de « EN » comme de « EU », seule la
#: plausibilité du glyphe tranche.
LETTER_CONFUSIONS = {
    "A": "R", "B": "ERPD", "C": "OGE", "D": "OBP", "E": "FBC", "F": "EP",
    "G": "COQ", "H": "NMK", "I": "TLJ", "J": "IT", "K": "RXH", "L": "IE",
    "M": "NHW", "N": "MHU", "O": "DQCG", "P": "FRBD", "Q": "OG", "R": "PBKA",
    "S": "E", "T": "IJY", "U": "VN", "V": "UYW", "W": "VM", "X": "KY",
    "Y": "VXT", "Z": "S",
}

_DASH_CHARS = re.compile(r"[‐-―−_]")

#: Le motif attendu par le viseur : c'est tout ce que le mode « sniper » cherche.
SNIPER_PATTERN = re.compile(r"\b[A-Z0-9]{3,4}-[A-Z]{2,3}[0-9]{3,4}\b")

#: Variante tolérante, pour quand le tiret saute ou qu'un caractère déborde.
#: Elle exige toujours de finir sur des chiffres : sans cela, n'importe quel mot
#: du décor deviendrait un candidat.
LOOSE_PATTERN = re.compile(r"\b[A-Z0-9]{2,5}-?[A-Z]{0,3}[0-9]{2,4}\b")

#: Forme finale acceptable, une fois les transpositions appliquées.
VALID_CODE = re.compile(r"^[A-Z][A-Z0-9]{1,4}-(?:[A-Z]{2})?[A-Z]?\d{2,4}$")


def clean(raw: str) -> str:
    """Majuscules, tirets unifiés, ponctuation parasite retirée.

    Les espaces sont conservés — ils séparent les mots, et c'est le mot entier
    qui est ensuite éprouvé. Seuls ceux qui entourent un tiret disparaissent :
    « LOB - EN001 » et « LOB-EN001 » désignent la même chose.
    """
    text = (raw or "").upper()
    text = _DASH_CHARS.sub("-", text)
    text = re.sub(r"[^A-Z0-9\-\s]", " ", text)
    text = re.sub(r"\s*-\s*", "-", text)
    return re.sub(r"\s+", " ", text).strip()


def _as_letters(text: str) -> str:
    return "".join(DIGIT_TO_LETTER.get(char, char) for char in text)


def _as_digits(text: str) -> str:
    return "".join(LETTER_TO_DIGIT.get(char, char) for char in text)


def _snap_region(region: str) -> str:
    """Recale une région sur la liste connue, si une seule confusion l'explique."""
    from .regions import ALL_REGIONS

    if not region or region in ALL_REGIONS:
        return region

    def plausible(known: str) -> bool:
        return all(
            a == b or b in LETTER_CONFUSIONS.get(a, "")
            for a, b in zip(region, known, strict=False)
        )

    candidates = [known for known in ALL_REGIONS if plausible(known)]
    return candidates[0] if len(candidates) == 1 else region


def _compose(prefix_raw: str, rest_raw: str) -> tuple[str, int] | None:
    """Assemble une découpe et lui donne une note de plausibilité.

    Renvoie ``None`` si la découpe ne peut pas former un code. La note sert à
    départager les découpes possibles d'un fragment sans tiret.
    """
    from .regions import ALL_REGIONS

    if len(prefix_raw) < 2 or len(rest_raw) < 2:
        return None

    # Les deux premiers caractères d'un préfixe sont toujours des lettres ; les
    # suivants peuvent être des chiffres (« MP21 », « RA01 », « SS01 »).
    prefix = _as_letters(prefix_raw[:2]) + prefix_raw[2:]
    if not re.fullmatch(r"[A-Z][A-Z0-9]{1,4}", prefix):
        return None

    region, tail, region_score = "", rest_raw, 0
    if len(rest_raw) >= 4:
        head = _as_letters(rest_raw[:2])
        snapped = _snap_region(head)
        if snapped in ALL_REGIONS:
            region, tail = snapped, rest_raw[2:]
            # Une région lue telle quelle vaut mieux qu'une région recalée : sur
            # « LOBEN001 », la découpe « LO | BEN001 » ne tient que par un recalage
            # (« BE » vers « DE »), là où « LOB | EN001 » lit « EN » directement.
            region_score = 4 if head == snapped else 2

    # Une lettre en tête du numéro n'est une lettre de série que si le glyphe ne
    # se confond pas avec un chiffre : dans « ENOO4 », ce « O » est un zéro.
    if len(tail) >= 3 and tail[0].isalpha() and tail[0] not in LETTER_TO_DIGIT:
        serial, number = tail[0], _as_digits(tail[1:])
    else:
        serial, number = "", _as_digits(tail)

    if not (number.isdigit() and 2 <= len(number) <= 4):
        return None

    score = region_score
    if len(number) == 3:
        score += 2
    if prefix.isalpha():
        score += 1

    return f"{prefix}-{region}{serial}{number}", score


def transpose(candidate: str) -> str:
    """Applique les transpositions, position par position.

    Quand le tiret est présent, il donne la découpe. Quand il a sauté à la
    lecture, on essaie chaque découpe possible et on retient la mieux notée —
    sans quoi « LOBEN001 » se lirait « LOBE-NO01 ».
    """
    text = candidate.strip()

    if "-" in text:
        left, _, right = text.partition("-")
        composed = _compose(left, right)
        return composed[0] if composed else candidate

    best: tuple[str, int] | None = None
    for split in range(2, 6):
        if split >= len(text):
            break
        composed = _compose(text[:split], text[split:])
        if composed and (best is None or composed[1] > best[1]):
            best = composed

    return best[0] if best else candidate


def prefix_variants(code: str) -> list[str]:
    """Les lectures possibles de la fin du préfixe.

    Les deux premiers caractères d'un préfixe sont toujours des lettres, mais les
    suivants peuvent être l'un ou l'autre : « BLAR » est tout lettres, « RA03 »
    finit par des chiffres. Un « 0 » lu « O » à cet endroit n'est donc pas
    corrigible par position — on ne sait pas ce qui est attendu.

    Plutôt que de deviner, on propose les deux lectures et on laisse la base
    trancher : celle qui existe gagne. C'est ce qui fait passer « RAO3-FR001 »
    d'une correspondance approchée à une correspondance exacte.
    """
    prefix, dash, rest = code.partition("-")
    if not dash or len(prefix) <= 2:
        return [code]

    head, tail = prefix[:2], prefix[2:]
    variants = [code]
    for rewritten in (_as_digits(tail), _as_letters(tail)):
        candidate = f"{head}{rewritten}-{rest}"
        if candidate not in variants:
            variants.append(candidate)
    return variants


def extract_candidates(raw: str) -> list[str]:
    """Codes plausibles d'un texte OCR, le plus crédible en tête.

    Trois lectures, de la plus sûre à la plus permissive :

    1. le motif strict du viseur, où qu'il se trouve dans la ligne ;
    2. chaque **mot entier** assez long — c'est le cas normal en mode sniper,
       le viseur ne cadrant qu'une ligne ;
    3. les paires de mots consécutifs, pour quand le tiret a été lu comme un
       espace et a coupé le code en deux.

    Chercher le motif à l'intérieur des mots produirait des faux positifs
    (« MP21 » extrait de « MP21-ENOI2 »), d'où le passage par des mots complets.
    """
    text = clean(raw)
    seen: dict[str, float] = {}

    def offer(fragment: str, base_score: int) -> None:
        corrected = transpose(fragment)
        if not VALID_CODE.match(corrected):
            return

        # Un fragment déjà conforme avant transposition inspire plus confiance.
        bonus = base_score + (1 if fragment == corrected else 0)
        for rank, variant in enumerate(prefix_variants(corrected)):
            # La lecture d'origine passe devant ses réécritures de préfixe.
            seen[variant] = max(seen.get(variant, 0), bonus - rank * 0.1)

    for match in SNIPER_PATTERN.finditer(text):
        offer(match.group(), 4)

    words = text.split()
    for word in words:
        # Un code complet fait au minimum huit caractères sans tiret. En exiger
        # sept, ou un tiret, écarte les fragments comme « EN001 » qui se
        # composeraient en un code de pure forme.
        if "-" in word or len(word) >= 7:
            offer(word, 2)

    # Le tiret a pu être lu comme un espace. On ne recolle que si la moitié
    # droite commence par une région connue, sans quoi « DEF 2500 » deviendrait
    # un code d'extension.
    from .regions import ALL_REGIONS

    for left, right in zip(words, words[1:], strict=False):
        if left[:1].isalpha() and right[:2] in ALL_REGIONS:
            offer(f"{left}-{right}", 1)

    return [code for code, _ in sorted(seen.items(), key=lambda item: -item[1])]
