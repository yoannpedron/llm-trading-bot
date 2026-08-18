#!/usr/bin/env python3
"""Construit le fichier HTML autonome de l'Extracteur de Contrats d'Eau.

Le principe : l'outil doit fonctionner sur un poste sans réseau, sans droits
d'installation, et sans qu'aucune facture ne quitte la machine. Les moteurs de
lecture (pdf.js pour les PDF, Tesseract pour la reconnaissance optique, et le
dictionnaire français) sont donc compressés, encodés, et écrits à l'intérieur
même du fichier HTML livré.

Usage :
    python3 outils/construire.py                  # télécharge puis construit
    python3 outils/construire.py --cache DOSSIER  # réutilise des moteurs déjà là

Le résultat est écrit dans Extracteur_Contrats_Eau.html à la racine du projet.
"""

import argparse
import base64
import gzip
import json
import os
import sys
import urllib.request

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(RACINE, "src", "app.html")
SORTIE = os.path.join(RACINE, "Extracteur_Contrats_Eau.html")

PDFJS = "3.11.174"
TESS = "5.1.1"
CDN = "https://cdn.jsdelivr.net"

# clé interne -> (URL, déjà compressé à la source)
MOTEURS = {
    "pdf":        (f"{CDN}/npm/pdfjs-dist@{PDFJS}/build/pdf.min.js", False),
    "pdfworker":  (f"{CDN}/npm/pdfjs-dist@{PDFJS}/build/pdf.worker.min.js", False),
    "tess":       (f"{CDN}/npm/tesseract.js@{TESS}/dist/tesseract.min.js", False),
    "tessworker": (f"{CDN}/npm/tesseract.js@{TESS}/dist/worker.min.js", False),
    # Le cœur WebAssembly de Tesseract est livré en JavaScript, le binaire y
    # étant déjà encodé : un seul fichier suffit donc.
    "tesscore":   (f"{CDN}/npm/tesseract.js-core@{TESS}/tesseract-core-simd.wasm.js", False),
    # Modèle « fast » : deux fois plus léger que le modèle standard pour une
    # perte de précision négligeable sur des factures imprimées.
    "fra":        (f"{CDN}/gh/naptha/tessdata@gh-pages/4.0.0_fast/fra.traineddata.gz", True),
}

# Polices de secours de pdf.js. Sans elles, un PDF qui n'embarque pas ses
# polices s'affiche en caractères de remplacement — inexploitable pour un
# contrôle visuel qui repose entièrement sur ce que l'utilisateur lit à l'écran.
POLICES = [
    "FoxitDingbats.pfb", "FoxitFixed.pfb", "FoxitFixedBold.pfb",
    "FoxitFixedBoldItalic.pfb", "FoxitFixedItalic.pfb", "FoxitSerif.pfb",
    "FoxitSerifBold.pfb", "FoxitSerifBoldItalic.pfb", "FoxitSerifItalic.pfb",
    "FoxitSymbol.pfb", "LiberationSans-Bold.ttf", "LiberationSans-BoldItalic.ttf",
    "LiberationSans-Italic.ttf", "LiberationSans-Regular.ttf",
]
URL_POLICE = f"{CDN}/npm/pdfjs-dist@{PDFJS}/standard_fonts/{{}}"


def recuperer(url, cache):
    """Rend le contenu d'une URL, en passant par un cache disque si demandé."""
    if cache:
        os.makedirs(cache, exist_ok=True)
        chemin = os.path.join(cache, url.rsplit("/", 1)[-1])
        if os.path.exists(chemin) and os.path.getsize(chemin) > 1024:
            return open(chemin, "rb").read()
    print(f"  téléchargement {url.rsplit('/', 1)[-1]}", file=sys.stderr)
    with urllib.request.urlopen(url, timeout=120) as r:
        data = r.read()
    if len(data) < 1024:
        raise RuntimeError(f"réponse anormalement courte pour {url}")
    if cache:
        open(os.path.join(cache, url.rsplit("/", 1)[-1]), "wb").write(data)
    return data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(RACINE, ".moteurs"),
                    help="dossier où conserver les moteurs téléchargés")
    ap.add_argument("--sortie", default=SORTIE)
    args = ap.parse_args()

    charge = {}
    total_brut = 0
    print("Moteurs :", file=sys.stderr)
    for cle, (url, deja_gz) in MOTEURS.items():
        brut = recuperer(url, args.cache)
        total_brut += len(brut)
        data = brut if deja_gz else gzip.compress(brut, 9)
        charge[cle] = base64.b64encode(data).decode()
        print(f"  {cle:11s} {len(brut)/1e6:6.2f} Mo -> {len(charge[cle])/1e6:5.2f} Mo encodés", file=sys.stderr)

    print("Polices de secours :", file=sys.stderr)
    polices = {}
    for nom in POLICES:
        brut = recuperer(URL_POLICE.format(nom), args.cache)
        total_brut += len(brut)
        polices[nom] = base64.b64encode(brut).decode()
    paquet = gzip.compress(json.dumps(polices, separators=(",", ":")).encode(), 9)
    charge["polices"] = base64.b64encode(paquet).decode()
    print(f"  {len(POLICES)} polices -> {len(charge['polices'])/1e6:5.2f} Mo encodés", file=sys.stderr)

    gabarit = open(SOURCE, encoding="utf-8").read()
    if "/*__MOTEURS__*/" not in gabarit:
        raise SystemExit("le gabarit ne contient pas le repère /*__MOTEURS__*/")

    injection = "const MOTEURS = {\n" + ",\n".join(
        f'{cle}: "{val}"' for cle, val in charge.items()) + "\n};"
    sortie = gabarit.replace("/*__MOTEURS__*/", injection)

    open(args.sortie, "w", encoding="utf-8").write(sortie)
    print(f"\nÉcrit : {args.sortie}", file=sys.stderr)
    print(f"  moteurs d'origine : {total_brut/1e6:.1f} Mo", file=sys.stderr)
    print(f"  fichier livré     : {os.path.getsize(args.sortie)/1e6:.1f} Mo", file=sys.stderr)


if __name__ == "__main__":
    main()
