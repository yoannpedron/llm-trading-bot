from app.matching import group_rarities, printings_for


def test_code_exact(matcher):
    resolution = matcher.resolve("LOB-EN001")
    assert resolution.status == "matched"
    assert resolution.matched_code == "LOB-EN001"
    assert resolution.method == "exact"
    assert resolution.confidence == 100
    assert resolution.synthetic is False


def test_code_francais_retombe_sur_la_donnee_anglaise(matcher):
    # C'est le cas d'usage réel : la carte en main porte « LOB-FR001 »,
    # YGOPRODeck ne connaît que « LOB-EN001 ».
    resolution = matcher.resolve("LOB-FR001")
    assert resolution.status == "matched"
    assert resolution.matched_code == "LOB-FR001"
    # Le tirage vient d'une variante générée : l'API doit le dire.
    assert resolution.synthetic is True


def test_lecture_abimee_corrigee_avant_recherche(matcher):
    resolution = matcher.resolve("L0B-FR0O1")
    assert resolution.matched_code == "LOB-FR001"
    # La transposition suffit : aucune approximation n'a été nécessaire.
    assert resolution.method == "exact"


def test_une_erreur_sur_le_numero_est_refusee(matcher):
    # « LOB-EN002 » est à un caractère de « LOB-EN001 » — et, dans la vraie
    # base, c'est une autre carte. Sur une clé de sept caractères, un seul
    # écart vaut 85,7 : sous le plancher, donc « je ne sais pas ». Mesuré :
    # accepter ce genre d'écart rendait autant de mauvaises cartes que de
    # bonnes (PASSATION.md, § 3).
    resolution = matcher.resolve("LOB-EN0O2")
    assert resolution.status == "no_match"


def test_correspondance_approchee_unique_au_dela_du_plancher(matcher, monkeypatch):
    # Le plancher est abaissé pour exercer le chemin approché sur les clés
    # courtes de la base de test ; en production, seules les clés longues y
    # passent encore.
    monkeypatch.setattr("app.matching.FUZZY_CUTOFF", 80)
    resolution = matcher.resolve("MRD-FR10")
    assert resolution.status == "matched"
    assert resolution.method == "fuzzy"
    # Le code rendu est celui publié, pas la région lue : la lecture contient
    # l'erreur qu'on vient de rattraper. Même choix que le client.
    assert resolution.matched_code == "MRD-EN101"
    assert resolution.synthetic is False
    assert 80 <= resolution.confidence < 100


def test_une_hesitation_entre_deux_cartes_ne_designe_rien(matcher, monkeypatch):
    monkeypatch.setattr("app.matching.FUZZY_CUTOFF", 80)
    # « LOB-01 » est aussi proche de LOB-EN001 que de LOB-EN041.
    resolution = matcher.resolve("LOB-EN01")
    assert resolution.status == "no_match"
    assert resolution.reason == "ambiguous"
    assert resolution.as_dict()["reason"] == "ambiguous"


def test_sans_marge_la_premiere_venue_l_emporte(matcher, monkeypatch):
    # C'est le comportement d'avant, conservé derrière un réglage pour que les
    # bancs de mesure puissent le rejouer.
    monkeypatch.setattr("app.matching.FUZZY_CUTOFF", 80)
    monkeypatch.setattr("app.matching.FUZZY_MARGIN", 0)
    assert matcher.resolve("LOB-EN01").status == "matched"


def test_meme_formule_que_le_client(matcher, monkeypatch):
    # La note doit être la distance de Levenshtein rapportée à la longueur de la
    # clé sans région : « MRD-10 » contre « MRD-101 », un écart sur sept.
    monkeypatch.setattr("app.matching.FUZZY_CUTOFF", 80)
    resolution = matcher.resolve("MRD-EN10")
    assert round(resolution.confidence, 1) == 85.7


def test_prefere_un_code_exact_a_un_approchant(matcher):
    # Deux candidats sortent de la lecture ; celui qui existe doit gagner même
    # s'il n'est pas le premier proposé.
    resolution = matcher.resolve("ZZZ-EN999 LOB-EN001")
    assert resolution.matched_code == "LOB-EN001"
    assert resolution.method == "exact"


def test_refuse_de_deviner_quand_rien_ne_colle(matcher):
    # Mieux vaut un échec, qui se corrige d'une nouvelle photo, qu'une carte
    # fausse, qui passe inaperçue.
    assert matcher.resolve("XQKW-ZZ999").status == "no_match"


def test_distingue_absence_de_code_et_absence_de_correspondance(matcher):
    assert matcher.resolve("du texte sans code").status == "no_code"
    assert matcher.resolve("").status == "no_code"


def test_conflit_de_rarete(db):
    # Même code, deux raretés : Short Print dans la série d'origine, Commune
    # dans la réédition anniversaire.
    raretes = group_rarities(printings_for(db, "LOB-EN041"))
    assert len(raretes) == 2
    assert {entry["rarity"] for entry in raretes} == {"Short Print", "Common"}
    assert all(entry["price_eur"] == 0.15 for entry in raretes)


def test_le_conflit_survit_a_la_regionalisation(db):
    # La variante française doit porter les mêmes raretés que l'anglaise.
    raretes = group_rarities(printings_for(db, "LOB-FR041"))
    assert {entry["rarity"] for entry in raretes} == {"Short Print", "Common"}
    assert all(entry["synthetic"] for entry in raretes)


def test_rarete_unique(db):
    raretes = group_rarities(printings_for(db, "LOB-EN001"))
    assert len(raretes) == 1
    assert raretes[0]["rarity"] == "Ultra Rare"
