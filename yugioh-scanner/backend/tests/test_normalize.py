import pytest

from app.normalize import clean, extract_candidates, transpose


def test_nettoie_le_bruit_sans_coller_les_mots():
    assert clean("  lob - en001  ") == "LOB-EN001"
    # Les espaces séparent des mots : ils ne doivent pas disparaître.
    assert clean("1st Edition LOB-EN001") == "1ST EDITION LOB-EN001"


@pytest.mark.parametrize(
    ("lu", "attendu"),
    [
        ("RA03-FR001", "RA03-FR001"),
        # Chiffres lus à la place de lettres dans le préfixe et la région.
        ("L0B-EN0O1", "LOB-EN001"),
        ("5R13-ENOO4", "SR13-EN004"),
        # Lettres lues à la place de chiffres dans le numéro.
        ("MP21-ENOI2", "MP21-EN012"),
        ("RA03-FR0O1", "RA03-FR001"),
        # Région à un caractère près, avec une confusion que Tesseract commet.
        ("BLAR-EM001", "BLAR-EN001"),
        # Lettre de série préservée.
        ("SS01-ENA01", "SS01-ENA01"),
        ("LDK2-ENJ01", "LDK2-ENJ01"),
    ],
)
def test_transposition_positionnelle(lu, attendu):
    # D'autres lectures du préfixe peuvent suivre — c'est voulu, la base
    # tranchera — mais la plus plausible doit venir en tête.
    assert extract_candidates(lu)[0] == attendu


def test_retrouve_le_code_sans_tiret():
    # Le tiret saute à la lecture : la découpe est choisie sur la plausibilité
    # de la région, sinon « LOBEN001 » se lirait « LOBE-NO01 ».
    assert extract_candidates("LOBEN001")[0] == "LOB-EN001"
    assert extract_candidates("RA03FR001")[0] == "RA03-FR001"


def test_recolle_un_tiret_lu_comme_un_espace():
    assert extract_candidates("LOB EN001")[0] == "LOB-EN001"


def test_extrait_le_code_au_milieu_du_decor():
    assert extract_candidates("1ST EDITION LOB-EN001")[0] == "LOB-EN001"
    assert extract_candidates("~ ©1996 KAZUKI  RA03-FR001 |")[0] == "RA03-FR001"


def test_ne_fabrique_pas_de_code_a_partir_de_rien():
    # Le texte de la carte contient des suites lettres-chiffres qui ne sont
    # pas des codes : les prendre pour tels enverrait vers une carte au hasard.
    assert extract_candidates("ATK/3000 DEF/2500") == []
    assert extract_candidates("") == []
    assert extract_candidates("~ | .") == []
    assert extract_candidates("DRAGON NORMAL") == []


def test_transpose_laisse_intact_ce_qui_est_deja_juste():
    for code in ("LOB-EN001", "RA03-FR001", "SS01-ENA01"):
        assert transpose(code) == code


def test_les_deux_lectures_du_prefixe_sont_proposees():
    """Le troisième caractère d'un préfixe peut être une lettre ou un chiffre.

    « BLAR » est tout lettres, « RA03 » finit par des chiffres : à cette
    position, aucune correction par position n'est possible. On propose donc les
    deux lectures et la base tranche — c'est ce qui fait passer « RAO3-FR001 »
    d'une correspondance approchée à une correspondance exacte.
    """
    candidats = extract_candidates("RAO3-FR001")
    assert "RA03-FR001" in candidats
    # La lecture brute reste en tête : on ne réécrit pas d'autorité.
    assert candidats[0] == "RAO3-FR001"

    # Un préfixe tout lettres n'a rien à réécrire.
    assert extract_candidates("BLAR-EN001") == ["BLAR-EN001"]


def test_les_variantes_ne_creent_pas_de_faux_positifs():
    # Elles ne sont que des clés à éprouver : aucune ne doit sortir d'un texte
    # qui ne contenait pas de code.
    assert extract_candidates("ATK/3000 DEF/2500") == []
