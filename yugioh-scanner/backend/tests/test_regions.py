from app.regions import base_code, region_of, regional_variants, split_set_code


def test_decoupe_les_formats_courants():
    assert split_set_code("LOB-EN001") == {
        "prefix": "LOB", "region": "EN", "serial": "", "number": "001"
    }
    assert split_set_code("SS01-ENA01")["serial"] == "A"
    assert split_set_code("MP21-EN012")["prefix"] == "MP21"
    # Ancien format sans région.
    assert split_set_code("LOB-001") == {
        "prefix": "LOB", "region": "", "serial": "", "number": "001"
    }
    assert split_set_code("pas un code") is None


def test_le_code_de_base_relie_les_regions():
    # C'est toute la mécanique qui fait tomber un scan français sur la donnée
    # anglaise publiée par YGOPRODeck.
    assert base_code("LOB-FR001") == base_code("LOB-EN001") == "LOB-001"
    assert base_code("SS01-ENA01") == "SS01-A01"
    # Sans région, il n'y a rien à retirer.
    assert base_code("LOB-001") == "LOB-001"
    # Une forme inconnue est conservée plutôt qu'écartée.
    assert base_code("bizarre") == "BIZARRE"


def test_region_lue():
    assert region_of("RA03-FR001") == "FR"
    assert region_of("LOB-001") == ""


def test_variantes_regionales():
    variantes = regional_variants("LOB-EN001")
    assert "LOB-FR001" in variantes
    assert "LOB-DE001" in variantes
    # Le code d'origine ne se réengendre pas lui-même.
    assert "LOB-EN001" not in variantes
    # La lettre de série est préservée.
    assert "SS01-FRA01" in regional_variants("SS01-ENA01")
    # Un code sans région n'a rien à substituer.
    assert regional_variants("LOB-001") == []
