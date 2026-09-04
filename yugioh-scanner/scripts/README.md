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
| `harness/real-crops.mjs` | rejoue les vrais recadrages de `scripts/fixtures/` avec et sans lissage et rognage — **à lancer avant toute décision sur le prétraitement** |
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

## Fixtures réelles

`scripts/fixtures/viseur-<code>.png` sont des recadrages de viseur pris sur un
téléphone ; le code attendu est dans le nom. Dans l'application, un appui sur
la vignette binarisée en haut à gauche enregistre le recadrage tel que le
moteur le reçoit. Les deux premières fixtures sont des captures d'écran
recadrées — résolution de l'affichage, pas du capteur — à remplacer par des
recadrages natifs dès que possible.

Ce que le banc synthétique ne produit pas et que ces fixtures ont révélé : la
trame d'impression résolue par le capteur, la bordure de la carte dans le
viseur, un code gris sur fond sombre. Les trois ont fait échouer l'application
alors que le banc annonçait 90 % de bonnes cartes.

## Test navigateur hors ligne

`harness/ui-e2e.mjs` charge l'application bâtie et attend un verrouillage sur
la caméra simulée. Dans un environnement où Chromium ne joint pas le CDN, il
faut servir Tesseract depuis `public/tess/` (ignoré par git) :

```bash
mkdir -p public/tess/core public/tess/lang
cp node_modules/tesseract.js/dist/worker.min.js public/tess/
cp node_modules/tesseract.js-core/tesseract-core*.{js,wasm} public/tess/core/
cp $SP/eng.traineddata public/tess/lang/ && gzip -k public/tess/lang/eng.traineddata
curl -o $SP/beb.jpg https://images.ygoprodeck.com/images/cards/89631139.jpg
SP=$SP DEGRADE=aucun node scripts/harness/sniper-shot.mjs
for i in $(seq 1 90); do cat $SP/sniper-aucun.jpg; done > $SP/sniper.mjpeg
VITE_TESSERACT_WORKER_PATH=/tess/worker.min.js VITE_TESSERACT_CORE_PATH=/tess/core \
  VITE_TESSERACT_LANG_PATH=/tess/lang npx vite build
npx vite preview --port 4173 &
SP=$SP node scripts/harness/ui-e2e.mjs
```

Le résultat attendu tient en une ligne : `résultat : code=… nom="Destiny HERO -
Malicious"` et `aucune erreur console`. « AUCUNE lecture aboutie » sans erreur
console est une régression de la boucle de lecture ou du prétraitement — c'est
ainsi que deux ont été prises.
