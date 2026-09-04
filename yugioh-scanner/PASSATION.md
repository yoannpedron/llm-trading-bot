# Passation

Ce document existe pour qu'une autre personne — ou un autre agent — reprenne ce
projet sans refaire les mesures déjà faites ni retomber dans les pièges déjà
identifiés. Il dit où en est le travail, **ce qui bloque aujourd'hui**, et ce
qu'il ne faut surtout pas croire sur parole.

---

## 1. Accès nécessaires

| Quoi | Où | État |
|---|---|---|
| Dépôt | `github.com/yoannpedron/llm-trading-bot` | — |
| Branche de travail | `claude/yugioh-card-price-ocr-daf5fd` | ne pas pousser ailleurs sans accord |
| Site en ligne | https://yoannpedron.github.io/llm-trading-bot/ | déployé, fonctionnel |
| GitHub Pages | Settings → Pages → Source : **GitHub Actions** | ✅ déjà fait |
| Environnement Pages | Settings → Environments → `github-pages` → Deployment branches | ✅ déjà ouvert à la branche |

**Aucun secret, aucune clé d'API n'est nécessaire.** YGOPRODeck est public et
sans authentification. Rien n'est stocké côté serveur.

### Ce qui n'existe pas encore

- **Hébergement du backend Python.** FastAPI ne tourne ni sur GitHub Pages ni
  sur Netlify Functions. Cible : Render, Railway, Fly.io, ou un conteneur. Une
  fois déployé, il suffit de bâtir le front avec `VITE_API_BASE=<url>`. Sans
  cette variable, le front résout les codes lui-même — c'est l'état actuel, et
  il est pleinement fonctionnel.
- **API Cardmarket.** Il n'y a pas de clé. Le code tente une lecture de la fiche
  publique, que Cardmarket bloque en pratique depuis une IP d'hébergeur, et
  retombe sur les prix YGOPRODeck. Pour de vraies cotes il faut un compte pro
  Cardmarket et OAuth — c'est le seul chemin fiable et légal.

### Environnement de développement

```bash
node --version    # 22
npm install
npm run index     # ~21 Mo depuis YGOPRODeck -> public/card-index.json (ignoré par git)
npm run dev

cd backend && pip install -r requirements.txt
python -m app.cli sync && uvicorn app.main:app --reload
```

Pour les scripts de mesure : Chromium + `playwright` (voir `scripts/README.md`).

---

## 2. Où en est le travail

Le scanner fonctionne de bout en bout. Une carte présentée au viseur est
identifiée, sa fiche s'affiche en français, ses raretés sont proposées quand le
code est ambigu, et elle s'ajoute à une collection exportable en CSV.

- **82 tests JS** (`npm test`) et **40 tests Python** (`python3 -m pytest backend`)
- Chaîne complète validée en navigateur avec caméra simulée
- Déployé et servi sur GitHub Pages

---

## 3. Ce qui bloque — à lire en premier

**Le scanner identifie autant de mauvaises cartes que de bonnes.**

Mesuré sur 40 codes réels rendus à l'échelle du viseur puis dégradés comme une
vraie prise de vue (`node scripts/ocr-confusions.mjs`) :

| Dégradation | Lecture exacte | Bonne carte | **Mauvaise carte** |
|---|---|---|---|
| moyenne | 15 % | 25 % | **25 %** |
| forte | 13 % | 15 % | **23 %** |

C'est le pire mode de défaillance possible : une mauvaise carte passe inaperçue,
là où un échec se corrige d'une nouvelle visée.

**Cause identifiée.** Le seuil de correspondance approchée vaut 82 sur 100
(`FUZZY_CUTOFF` dans `src/lib/match.js` et `backend/app/config.py`). Sur 37 000
clés de neuf caractères, cela autorise près de deux caractères d'écart : une
lecture abîmée trouve presque toujours *quelque chose*.

### Le travail immédiat

Un balayage de seuil est déjà écrit dans `scripts/ocr-confusions.mjs` : il
réutilise les lectures OCR sans les refaire et affiche, pour chaque seuil, le
nombre de bonnes cartes, de mauvaises et d'abandons. **Il n'a pas encore été
exécuté** — c'est la première chose à faire.

```bash
export SP=/tmp/ygo && mkdir -p $SP
node scripts/harness/build.mjs
SP=$SP APP=$PWD COUNT=60 node scripts/ocr-confusions.mjs
```

Choisir le seuil au point de bascule, puis, par ordre de valeur décroissante :

1. **Marge d'ambiguïté** — refuser quand deux codes différents obtiennent des
   notes proches. Une lecture qui hésite entre deux cartes ne désigne rien.
2. **Jamais d'approché sans confirmation** — `src/lib/vote.js` exige déjà deux
   lectures concordantes pour une correspondance approchée. Vérifier que ce
   chemin est bien pris partout, et envisager d'exiger trois lectures.
3. **Assumer le refus.** Mieux vaut « je ne sais pas » que la mauvaise carte.
   C'est une décision de produit à tenir explicitement, pas un réglage à
   optimiser vers le taux de reconnaissance.
4. **Vote caractère par caractère** entre les quatre binarisations, plutôt que de
   retenir la première qui rend quelque chose.
5. **`user_patterns` de Tesseract** pour contraindre la sortie à la grammaire
   d'un code (`\A\A\A-\A\A\d\d\d`). Écrire le fichier dans le système de
   fichiers du worker avec `worker.writeText()`.
6. **Redressement** — estimer l'inclinaison par variance du profil de projection
   et corriger avant l'OCR.

---

## 4. Ce qu'il ne faut pas croire sur parole

Chacun de ces points a coûté du temps. Ils sont tous vérifiés par une mesure ou
un test ; les remettre en cause demande de refaire la mesure, pas de raisonner.

### Tesseract

- **PSM 6, jamais PSM 7.** « Ligne unique » suppose que l'image ne contient que
  la ligne à lire. La taille du viseur *en pixels vidéo* dépend de la hauteur de
  l'écran : sur un conteneur court, il embarque la bordure de la carte, et PSM 7
  rend une chaîne vide, confiance nulle, **sans lever d'erreur**. Mesuré : PSM 6
  lit dans les deux cadrages, PSM 7 dans un seul, PSM 3 et 11 dans aucun.
  Verrouillé par `test/ocr.test.js`.
- **Ne jamais passer `logger: undefined`.** Cela écrase le journal par défaut,
  que la bibliothèque appelle sans vérifier : les workers meurent à la première
  image. Le rappel doit aussi être protégé — tous les paquets ne portent pas de
  `status`, et une exception levée là casse la réception des messages.

### Netteté

- **L'énergie de gradient mesure le bruit autant que la netteté.** Une image
  floue et bruitée obtient une note *supérieure* à une image nette et propre.
  Mesuré : énergie brute net 0,057 / flou+bruit 0,064. On utilise donc un
  **Tenengrad seuillé** (`sharpness()` dans `preprocess.js`), qui donne
  2,53 / 0,38 sur les mêmes images.
- **La netteté se mesure sur un recadrage 1:1**, jamais sur l'agrandissement :
  l'interpolation adoucit les contours qu'on mesure, et la note dépendrait alors
  de la résolution du capteur.

### Caméra

- **Ne pas forcer le zoom.** Sur la plupart des téléphones il est numérique : le
  capteur suréchantillonne puis ré-encode. Or le viseur recadre déjà dans
  l'image native — zoomer revient à agrandir avant de découper.
- **La mise au point est la première cause d'échec**, très loin devant le seuil
  de binarisation. `focusMode: continuous` et la mise au point au toucher
  (`pointsOfInterest`) valent plus que n'importe quel réglage d'OCR.
- **`object-fit: cover` ne se devine pas.** `src/lib/viewport.js` traduit le
  rectangle affiché en pixels vidéo. Se fier à l'intuition envoie à l'OCR une
  portion décalée — panne invisible, qui se manifeste seulement par « ça ne lit
  rien ». Les fonctions sont pures et testées.

### YGOPRODeck

- **Les images sont des répliques** : ni code d'extension ni passcode imprimés.
  Le gabarit est exact (rapport 59/86), mais on ne peut pas s'en servir pour
  éprouver la lecture d'un code. Les scripts en dessinent un par-dessus.
- **Aucune recherche par code d'extension.** Seulement par nom (`name`, `fname`)
  ou par nom complet de série (`cardset`). D'où l'index local.
- **`fname` est une recherche par sous-chaîne, pas floue.** Un caractère de
  travers et l'API renvoie une 400. C'est ce qui a justifié l'index embarqué.
- **`?language=fr` fonctionne** et traduit nom et texte ; `language=en` n'est pas
  une valeur acceptée, l'anglais est le défaut. `type` et `race` restent en
  anglais — traduits par `src/lib/frenchLabels.js` et `backend/app/translate.py`,
  **qui doivent rester identiques**.
- **Les codes publiés sont uniquement anglais.** Une carte française porte
  `RA03-FR001`. Le backend engendre les variantes régionales ; le client retire
  la région avant de comparer. Deux chemins, même résultat.

### Hébergement

- **GitHub Pages ne sert que des fichiers.** Pas de Python, pas de fonctions.
- **Netlify Functions n'exécute pas de Python** non plus.
- L'environnement `github-pages` restreint par défaut les déploiements à la
  branche par défaut. Un job `deploy` qui échoue en deux secondes sans exécuter
  la moindre étape, c'est cela.

---

## 5. Organisation du code

```
src/lib/
  useSniper.js     caméra, boucle de lecture, torche, zoom, mise au point
  viewport.js      viseur -> pixels vidéo   (pur, testé)
  preprocess.js    binarisations et netteté (pur, testé)
  ocr.js           profils Tesseract, un worker par profil
  parse.js         extraction et transposition des codes (pur, testé)
  match.js         résolution exact / régional / approché (pur, testé)
  vote.js          confirmation sur plusieurs images (pur, testé)
  cardIndex.js     chargement de l'index embarqué
  scanApi.js       backend Python si configuré, sinon local
  collection.js    historique et export CSV (pur, testé)

backend/app/
  normalize.py     transposition — miroir de parse.js, mêmes cas de test
  regions.py       régionalisation des codes
  matching.py      rapidfuzz sur SQLite
  etl.py           synchronisation YGOPRODeck
```

`parse.js` et `normalize.py` doivent rester d'accord : les deux jeux de tests
couvrent volontairement les mêmes cas.

---

## 6. Comment travailler ici

- **Mesurer avant de régler.** Chaque constante non évidente du pipeline vient
  d'un chiffre, et le commentaire à côté dit lequel. Ne pas en changer une sans
  refaire la mesure — `scripts/README.md` explique comment.
- **Le test navigateur trouve ce que la relecture ne voit pas.** Deux pannes
  parfaitement silencieuses ont été prises ainsi. Le lancer après toute
  modification de la boucle de lecture.
- **Préférer l'échec au faux positif.** C'est le fil directeur de tout ce qui
  reste à faire.
