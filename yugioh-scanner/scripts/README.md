# Outils de mesure

Ces scripts existent parce que les décisions du pipeline OCR **ne se devinent
pas**. Chaque réglage non trivial du code — mode de segmentation, seuil de
netteté, seuil de correspondance approchée — vient d'une mesure faite ici, et
peut être refaite.

Ils ne sont pas exécutés par `npm test` : ils ont besoin d'un navigateur, du
réseau, et prennent des minutes plutôt que des secondes.

## Préparer

```bash
export SP=/tmp/ygo && mkdir -p $SP
node scripts/harness/build.mjs        # empaquette le vrai code applicatif
```

Le banc injecte `src/lib/*` dans une page Chromium via `window.YGO`. Mesurer
avec une réimplémentation donnerait des chiffres qui ne décrivent pas
l'application.

`playwright` s'importe en ESM : s'il n'est installé que globalement, faire un
lien (`ln -s "$(npm root -g)/playwright" node_modules/playwright`).

**Regarder les images avant de croire un chiffre.** `ocr-confusions.mjs` écrit
ce que le moteur a reçu dans `$SP/confusions/`. Sa première version rendait le
code plus large que le viseur et mesurait ses propres amputations : 25 % de
mauvaises cartes annoncées, 2 % réelles. Le code est maintenant ajusté à 78 %
de la largeur du viseur, comme le cadre un utilisateur.

## Ce qu'il y a

| Script | Ce qu'il mesure |
|---|---|
| `build-index.mjs` | génère `public/card-index.json` depuis YGOPRODeck (lancé par `prebuild`) |
| `ocr-confusions.mjs` | **le plus important** : taux de bonne carte, de mauvaise carte, effet du seuil approché et de la marge d'ambiguïté (`lectures.json` conserve les lectures pour rejouer sans OCR) |
| `font-confusions.mjs` | similarité des silhouettes de glyphes — conclusion : non concluant, voir plus bas |
| `harness/sniper-shot.mjs` | fabrique une image de viseur réaliste (flou, reflet, bruit, rotation) |
| `harness/live-crop.mjs` | recadre la vidéo en direct de l'application et la lit |
| `harness/ui-e2e.mjs` | chaîne complète en navigateur, caméra simulée par un fichier MJPEG |

## Caméra simulée

Chromium sait lire un fichier MJPEG comme caméra — un simple concaténé de JPEG :

```bash
for i in $(seq 1 90); do cat $SP/sniper-aucun.jpg; done > $SP/sniper.mjpeg
# puis --use-file-for-fake-video-capture=$SP/sniper.mjpeg
```

C'est ce qui permet d'éprouver la boucle de lecture de bout en bout sans carte
ni téléphone. Deux pannes silencieuses ont été trouvées ainsi, invisibles
autrement.

## Pourquoi `font-confusions.mjs` ne conclut pas

Il compare les silhouettes des glyphes. Selon qu'on préserve ou non le rapport
largeur/hauteur, « 0 » et « O » sortent à 0,95 ou à 0,64 de similarité — deux
réponses opposées, aucune décisive. Et la police réelle des cartes n'est pas
disponible.

Le script est conservé parce que la conclusion est utile : **ce n'est pas la
forme des glyphes qu'il faut mesurer, c'est ce que le pipeline confond**. C'est
ce que fait `ocr-confusions.mjs`.
