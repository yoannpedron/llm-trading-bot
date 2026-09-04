# Scanner Yu-Gi-Oh! — mode « sniper »

Le téléphone est braqué sur une seule inscription de la carte : le **code
d'extension** (`RA03-FR001`). Comme une douchette de supermarché. Ni le titre ni
le passcode ne sont lus — un seul motif à chercher, dans un cadre très allongé,
avec le zoom et la torche pour le rendre lisible.

Une fois le code reconnu, la caméra se fige et l'écran se divise en deux : le
visuel officiel en haut, avec ses effets holographiques ; les données en
français en bas.

- **Capture et OCR** — PP-OCRv6 (ONNX Runtime) dans le navigateur, aucune image n'en sort
- **Résolution** — backend Python (SQLite + rapidfuzz), ou en local sur un index
  embarqué quand aucun backend n'est configuré
- **Interface** — React 19, Vite, Tailwind v4

## Démarrer

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 107 tests, sans navigateur
```

Le backend est facultatif :

```bash
cd backend
pip install -r requirements.txt
python -m app.cli sync                       # ~21 Mo, une fois
uvicorn app.main:app --reload                # http://127.0.0.1:8000/docs
```

Puis `VITE_API_BASE=http://127.0.0.1:8000 npm run dev`. Sans cette variable, le
front résout les codes lui-même — c'est ce qui lui permet de tourner sur GitHub
Pages, qui ne sert que des fichiers.

## Le viseur

`src/lib/viewport.js` traduit le rectangle dessiné à l'écran en pixels de la
vidéo. Le flux est affiché en `object-fit: cover` : il est donc agrandi puis
rogné, et jamais aux proportions de la fenêtre. Se fier à l'intuition ici revient
à envoyer à l'OCR une portion décalée — une panne invisible, qui se manifeste
seulement par « ça ne lit rien ». Les fonctions sont pures et testées.

Le cadre fait un rapport 6:1 : un code tient sur une ligne d'une dizaine de
caractères, et un cadre serré évite au moteur d'avoir à trier le texte utile du
décor de la carte.

**Zoom** et **torche** sont pilotés par `applyConstraints` sur la piste vidéo. Le
zoom vise ×2,5 au démarrage, avec un curseur pour ajuster : les unités varient
d'un appareil à l'autre — certains rendent un multiplicateur, d'autres une
échelle arbitraire — d'où le calcul par rapport aux bornes annoncées.

## Le moteur de lecture

**PP-OCRv6 « small »** (Baidu, licence Apache 2.0), exécuté par ONNX Runtime
dans un Web Worker via [`ppu-paddle-ocr`](https://www.npmjs.com/package/ppu-paddle-ocr)
(MIT). WebGPU quand le navigateur l'offre, WebAssembly sinon. Les modèles
(31 Mo) sont servis depuis `public/modeles/` — jamais depuis un CDN tiers — et
mis en cache par le navigateur (Cache API) : la deuxième visite ne télécharge
rien.

Pourquoi ce moteur, et plus Tesseract. Tesseract est conçu pour des scans à
plat ; PP-OCR est entraîné sur du texte photographié. Mesuré sur trois
recadrages réels de viseur (`scripts/fixtures/`), six images bruitées chacun,
image brute sans prétraitement :

| Moteur | Poids | Cartes lues | Images bonnes | Fausses | Par passe |
|---|---|---|---|---|---|
| Tesseract, réglé (4 binarisations, grammaire, passe chiffres) | 5 Mo | 2/3 | — | 0 | 490 ms |
| PP-OCRv6 tiny | 6 Mo | 2/3 | 10/18 | 0 | 190 ms |
| PP-OCRv5 en mobile | 13 Mo | 2/3 | 12/18 | 0 | 320 ms |
| **PP-OCRv6 small** | **31 Mo** | **3/3** | **15/18** | **0** | **380 ms** |

Le moteur lit l'image **brute** : l'ancienne chaîne de prétraitement (Otsu,
Sauvola, polarités inverses, rognage de la bande, effacement du liseré) a été
mesurée inutile et retirée. Il ne reste que le recadrage à la résolution native
et une mesure de netteté (Tenengrad seuillé) qui évite une passe sur une image
vide. `scripts/ocr-bench.mjs` rejoue la mesure ci-dessus avec le vrai code.

## Transposition et résolution

Un code a une forme rigide — préfixe, région, numéro — donc on sait pour chaque
position si un chiffre ou une lettre est attendu. Les transpositions sont donc
**positionnelles** : chiffre vers lettre dans le préfixe et la région (`0→O`,
`5→S`…), l'inverse dans le numéro (`O→0`, `I→1`…). Appliquer « O → 0 » partout
détruirait `LOB`.

Deux cas ne se corrigent pas par position, et sont traités en **proposant les
deux lectures pour que la base tranche** :

- **la fin du préfixe** — « BLAR » est tout lettres, « RA03 » finit par des
  chiffres. C'est ce qui fait passer `RAO3-FR001` d'une correspondance approchée
  à une correspondance exacte ;
- **la lettre de série** — dans `ENOO4`, ce « O » est un zéro ; dans `ENA01`,
  ce « A » est une lettre de série. On ne retient la lettre que si le glyphe ne
  se confond pas avec un chiffre.

Ensuite, trois chemins du plus sûr au plus permissif :

| Méthode | Ce qui se passe |
|---|---|
| `exact` | le code lu existe tel quel |
| `region` | son équivalent sans région existe (`RA03-FR001` → `RA03-EN001`) |
| `fuzzy` | le plus proche au-delà d'une note plancher (88), à condition qu'aucun autre code ne fasse jeu égal |

Sous le plancher, la réponse est « aucune correspondance ». Désigner une carte au
hasard serait pire qu'un échec : l'échec se corrige d'une nouvelle visée, une
mauvaise carte passe inaperçue.

**Régionalisation.** YGOPRODeck ne publie que la forme anglaise des codes TCG.
Le backend *engendre* les variantes (`FR`, `DE`, `IT`, `SP`, `PT`) et les insère
marquées `synthetic` — 252 784 tirages au total. Le client, lui, *retire* la
région avant de comparer : même résultat, index six fois plus petit.

Une correspondance approchée doit sortir **deux fois de suite** pour être
acceptée ; une correspondance exacte ou régionale est prise d'emblée. C'est ce
qui empêche un reflet passager de figer l'écran sur une carte au hasard.

## Les deux zones

**En haut**, le visuel officiel et rien d'autre — aucun texte HTML par-dessus,
les inscriptions sont déjà dans l'image. Les effets holographiques
(`src/styles/holo.css`) s'inspirent de
[`simeydotme/pokemon-cards-css`](https://github.com/simeydotme/pokemon-cards-css)
(MIT) mais sont réécrits pour cette carte-ci : format 59×86 mm, coins à 2,6 %,
liseré fin et sombre. Surtout, le foil d'une Super ou d'une Ultra Rare ne couvre
pas la carte entière mais **l'illustration et le bandeau des étoiles de niveau**
— d'où deux couches positionnées sur ces zones, aux proportions relevées sur un
gabarit officiel, plutôt qu'un masque global.

| Rareté | Effet |
|---|---|
| Commune / Rare | éclat léger seulement |
| Super / Ultra | foil sur l'illustration et les étoiles |
| Secret | foil pleine surface, diagonales arc-en-ciel, particules |

**En bas**, un panneau en verre dépoli : nom français et cote Cardmarket en
en-tête, sous-titre `[Dragon / Monstre Normal]` et statistiques, texte d'effet
dans sa propre zone de défilement, puis les commandes. Le texte défile plutôt que
de repousser le bouton hors de l'écran : sur un téléphone, « Valider » doit
rester sous le pouce quelle que soit la longueur de la carte.

Quand plusieurs raretés partagent le même code, ce sont elles qui s'affichent à
la place de « Valider » : la caméra ne voit pas l'holographie, seul l'utilisateur
peut trancher.

## Réglages

| Variable | Défaut | Rôle |
|---|---|---|
| `VITE_API_BASE` | — | URL du backend Python. Vide : résolution locale |
| `VITE_BASE` | `/` | chemin de base (`/<dépôt>/` sur GitHub Pages) |

## Déploiement

**GitHub Pages** — `.github/workflows/pages.yml` construit et publie à chaque
poussée. Une seule action manuelle : Settings → Pages → Source « GitHub Actions »,
et l'environnement `github-pages` doit autoriser la branche.

**Le backend Python ne tourne ni sur Pages ni sur Netlify Functions**, qui
n'exécutent pas de Python. Cible : Render, Railway, Fly.io ou un conteneur.

L'accès à la caméra exige HTTPS ; `localhost` fait exception.

## Tests

```bash
npm test                      # 107 tests JS
python3 -m pytest backend     # 40 tests Python
```

Couvrent l'extraction et la transposition des codes (des deux côtés, avec les
mêmes cas), la géométrie du viseur, la netteté, le chargement et la mise en
cache des modèles, l'appariement local et serveur, la régionalisation, les
conflits de rareté, l'historique et l'export CSV.

En navigateur, avec une caméra simulée : `scripts/harness/ui-e2e.mjs` (chaîne
complète), `scripts/harness/time-to-lock.mjs` (délai de verrouillage),
`scripts/ocr-bench.mjs` (le moteur sur les recadrages réels).
