import pytest
from fastapi.testclient import TestClient

from app import main
from app.etl import load
from tests.conftest import CARDS


@pytest.fixture
def client():
    """Client branché sur une base fraîchement remplie du jeu d'essai."""
    load(main.connection, CARDS)
    main.matcher.refresh()
    return TestClient(main.app)


def test_health_annonce_le_contenu(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["cards"] == 3
    # Chaque code anglais engendre cinq variantes régionales.
    assert body["synthetic"] > body["printings"] - body["synthetic"]


def test_scan_resolu_sans_question(client):
    body = client.post("/api/scan", json={"raw": "LOB-EN001"}).json()
    assert body["status"] == "resolved"
    assert body["card"]["name"] == "Blue-Eyes White Dragon"
    assert body["rarity"]["rarity"] == "Ultra Rare"
    assert body["matched_code"] == "LOB-EN001"


def test_scan_francais(client):
    body = client.post("/api/scan", json={"raw": "LOB-FR001"}).json()
    assert body["status"] == "resolved"
    assert body["card"]["id"] == 89631139
    assert body["synthetic"] is True


def test_scan_demande_la_rarete_quand_le_code_est_ambigu(client):
    body = client.post("/api/scan", json={"raw": "LOB-EN041"}).json()
    assert body["status"] == "needs_user_selection"
    assert len(body["rarities"]) == 2
    # Chaque option porte de quoi être affichée et choisie.
    for option in body["rarities"]:
        assert option["rarity"]
        assert option["set_name"]
        assert "price_eur" in option


def test_scan_sur_lecture_abimee(client):
    body = client.post("/api/scan", json={"raw": "L0B-FR0O1"}).json()
    assert body["status"] == "resolved"
    assert body["card"]["id"] == 89631139


def test_scan_sans_code(client):
    body = client.post("/api/scan", json={"raw": "ATK/3000 DEF/2500"}).json()
    assert body["status"] == "no_code"
    # Aucune carte n'est proposée : il n'y avait rien à résoudre.
    assert "card" not in body


def test_scan_sans_correspondance(client):
    body = client.post("/api/scan", json={"raw": "XQKW-ZZ999"}).json()
    assert body["status"] == "no_match"


def test_fiche_carte_en_francais(client, monkeypatch):
    # On ne dépend pas du réseau : la couche de détail est remplacée.
    monkeypatch.setattr(
        main, "fetch_card", lambda card_id, language: {"id": card_id, "name": "Dragon Blanc aux Yeux Bleus", "lang": language}
    )
    body = client.get("/api/card/89631139?language=fr").json()
    assert body["name"] == "Dragon Blanc aux Yeux Bleus"
    assert body["lang"] == "fr"


def test_fiche_carte_absente(client, monkeypatch):
    monkeypatch.setattr(main, "fetch_card", lambda card_id, language: None)
    assert client.get("/api/card/1").status_code == 404


def test_langue_invalide_refusee(client):
    assert client.get("/api/card/89631139?language=francais").status_code == 422
