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
| Branche de travail | `claude/yugioh-card-price-ocr-ix9l67` (suite de `…-daf5fd`) | ne pas pousser ailleurs sans accord |
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

`backend/requirements.txt` n'existait pas dans le dépôt jusqu'ici : la règle
`*.txt` du `.gitignore` **racine** l'avalait en silence. Il est maintenant
réintégré par une exception dans `yugioh-scanner/.gitignore`. Si un autre
fichier `.txt` semble « ne pas vouloir se commiter », c'est la même cause.

Pour les scripts de mesure : Chromium + `playwright` (voir `scripts/README.md`).
Si `playwright` est installé globalement et non dans le projet, un lien suffit
(`ln -s "$(npm root -g)/playwright" node_modules/playwright`) : les scripts
l'importent en ESM, qui ignore `NODE_PATH`.

---

## 2. Où en est le travail

Le scanner fonctionne de bout en bout. Une carte présentée au viseur est
identifiée, sa fiche s'affiche en français, ses raretés sont proposées quand le
code est ambigu, et elle s'ajoute à une collection exportable en CSV.

- **92 tests JS** (`npm test`) et **44 tests Python** (`python3 -m pytest backend`)
- Chaîne complète validée en navigateur avec caméra simulée
- Déployé et servi sur GitHub Pages

---

## 3. Ce qui bloquait — et ce que la mesure a révélé

La version précédente de ce document annonçait que **le scanner identifiait
autant de mauvaises cartes que de bonnes** (25 % contre 25 % en dégradation
moyenne). Le balayage de seuil demandé a été exécuté. Il a d'abord confirmé ce
chiffre, puis l'a démenti : **le banc de mesure coupait lui-même le code.**

### Le défaut du banc

`scripts/ocr-confusions.mjs` rendait le code à taille fixe (76 px) dans une
vidéo 1920×1080, alors que le viseur n'y découpe qu'une bande de 409 px de
large. Un code de dix caractères en fait 440 : le premier et le dernier étaient
tronqués **avant** l'OCR. Vérifié en ouvrant les images soumises au moteur :
« RA03-EN107 » y apparaît amputé du R et du 7, et Tesseract rend fidèlement
« RA03-EN10 ». Le banc mesurait ses propres amputations comme des erreurs de
lecture.

Le code est maintenant rendu pour occuper 78 % de la largeur du viseur, comme
le cadre un utilisateur. Sur les mêmes 60 codes réels, avant et après :

| Banc | Dégradation | Lecture exacte | Bonne carte | Mauvaise carte |
|---|---|---|---|---|
| tronqué (ancien) | moyenne | 12 % | 18 % | **17 %** |
| tronqué (ancien) | forte | 7 % | 12 % | **20 %** |
| **corrigé** | moyenne | 55 % | 75 % | 2 % |
| **corrigé** | forte | 80 % | 90 % | 0 % |

Ces chiffres sont ceux du seuil 82 d'origine, sans marge. Ils disent deux
choses : le pipeline lit bien mieux qu'annoncé, et il reste des fausses cartes.

### Le balayage, sur le banc corrigé (120 lectures)

| Seuil | Marge | Bonnes | Fausses | Abandons |
|---|---|---|---|---|
| 82 | 0 | 108 (90 %) | **11 (9 %)** | 1 |
| 88 | 0 | 106 (88 %) | **10 (8 %)** | 4 |
| 90 | 0 | 89 (74 %) | 0 | 31 |
| 82 | 1 | 101 (84 %) | 1 (1 %) | 18 |
| **88** | **1** | **99 (83 %)** | **1 (1 %)** | **20** |

Lecture du tableau :

- **Le seuil seul ne suffit pas.** Entre 82 et 88 rien ne change ; à 90 les
  fausses disparaissent mais l'approché ne rattrape plus rien (89 bonnes =
  exact + régional seuls). Le point de bascule sans marge est entre 88 et 90.
- **La marge d'ambiguïté fait l'essentiel.** Dix des onze fausses cartes sont
  des *égalités* : la lecture « LVAL-ENO061 » (un O inséré par Tesseract après
  la région) devient « LVAL-0061 », à un caractère à la fois de « LVAL-006 » et
  de « LVAL-061 » — deux cartes réelles. L'ancien code prenait la première
  rencontrée dans l'ordre de l'index. Refuser dès qu'un second candidat
  distinct fait jeu égal ramène les fausses de 11 à 1, au prix de 7 bonnes.
- **Le seuil garde son rôle face à d'autres erreurs.** La marge ne voit pas
  une substitution isolée qui tombe sur un voisin *unique* (« SENF-066 » pour
  « GENF-066 », « JOOD-087 » pour « DOOD-087 »). Le banc tronqué, malgré son
  défaut, en avait produit six fausses pour quatre bonnes. À 88, un écart sur
  une clé de sept ou huit caractères (99 % de l'index) est refusé ; seules les
  clés plus longues tolèrent encore une erreur. Coût mesuré par rapport à 82 :
  deux lectures sur 120, le même code lu deux fois.

### Décisions prises

1. **`FUZZY_CUTOFF` = 88** dans `src/lib/match.js` et `backend/app/config.py`.
2. **`FUZZY_MARGIN` = 1** aux deux endroits : un rapprochement approché est
   refusé (`status: 'no_match'`, `reason: 'ambiguous'`) dès qu'une clé
   distincte obtient une note à moins d'un point de la meilleure. Les notes
   étant quantifiées par la longueur des clés (pas de 12,5 ou 14,3), toute
   marge entre 0 exclu et 10 signifie « aucune égalité ».
3. **Le serveur applique la même formule que le client.** Il comparait les
   codes *complets* avec `fuzz.ratio` (une substitution y compte deux
   opérations, et « FR » face à « EN » coûtait deux caractères) : le même seuil
   n'y voulait pas dire la même chose. Il compare désormais la clé **sans
   région** avec `Levenshtein.normalized_similarity` — exactement
   `codeSimilarity` de `match.js` — et rend, sur un approché, le code publié
   plutôt que la région lue, comme le client. Un test de chaque côté fixe la
   note attendue (« MRD-10 » contre « MRD-101 » : 85,7).
4. **Le chemin de vote a été vérifié** (`useSniper.js` l. 271) : exact et
   régional sont acceptés d'emblée, l'approché exige deux lectures concordantes
   dans une fenêtre de quatre secondes. Le vote n'est pas passé à trois : sur
   le banc, les deux niveaux de dégradation d'un même code produisent souvent
   la *même* lecture erronée (« DTO03-EN018 » deux fois, « SDDE-ENO026 » deux
   fois) — une troisième image identique ne trancherait rien. C'est la marge
   qui règle ces cas, pas le nombre de lectures.
5. **La fausse carte restante** : « BP03-EN008 » lu « BP03-ENO00S », S
   transposé en 5, O inséré, meilleur voisin unique « BP03-005 ». Un approché,
   donc soumis au vote ; l'autre image du même code donne une lecture
   différente, ambiguë. En usage réel, le vote la bloque.

### Ce que deux captures de téléphone ont appris de plus

Deux captures d'écran de l'application sur un vrai téléphone (STOR-FR040,
MAMA-FR113) ont montré des échecs que le banc synthétique ne produit pas. Les
recadrages du viseur en ont été extraits (`scripts/fixtures/viseur-*.png`) et
rejoués par `scripts/harness/real-crops.mjs`. Trois causes, toutes absentes du
banc :

1. **La trame d'impression.** À la distance du mode sniper, le capteur résout
   les points de demi-teinte de la carte. Otsu les binarise en poussière que
   Tesseract lit comme des lettres — « REREEEEEEAEREEELARE » sur un code
   parfaitement lisible à l'œil. **Parade : un lissage** d'un centième de la
   hauteur du recadrage avant seuillage (`smooth()` dans `preprocess.js`),
   **pour Sauvola seulement** : appliqué aussi à Otsu, il faisait perdre le
   verrouillage sur la caméra simulée (« RA03 » lu « RAO03 »).
2. **La bordure de la carte dans le viseur.** Sur ce téléphone, la moitié
   basse du viseur est le cadre orange de la carte : un bloc noir après
   seuillage, que PSM 6 s'obstine à lire. **Parade : rogner à la ligne de
   texte** par profil de projection (`textBand()`), sur les variantes Sauvola,
   la bande étant cherchée sur la polarité encre-sombre — calculée sur une
   variante inversée, elle ne gardait qu'une ligne de transition.
3. **Le garde-fou de netteté mesurait le contraste.** MAMA-FR113 est un code
   gris sur fond sombre : ses contours ne dépassaient pas `EDGE_THRESHOLD`, et
   l'application disait « image trop floue » devant une vignette binarisée
   lisible. **Parade : mesurer après étirement de contraste.** Le seuil
   `MIN_SHARPNESS` n'a pas bougé.

Effet mesuré sur les fixtures réelles (Sauvola, seule binarisation qui lit) :
STOR passe de bruit pur à « STOK-FRO40 » — un R lu K, refusé à 88 car « STOK »
a plusieurs voisins à une édition près ; MAMA passe de rien à « CMAMA-FRLLZ »,
que la transposition change en « MAMA-FR112 » : **une autre carte, valide,
acceptée par l'approché.** Sur le banc synthétique, les trois parades font
passer le réglage retenu de 99 / 1 / 20 à **105 bonnes / 1 fausse / 14
abandons** (le bruit du banc n'est pas ensemencé : ± 2 d'une exécution à
l'autre), et la ligne « 100 » (exact + régional seuls) de 89 à 93. Otsu ne lit
aucune des deux fixtures ; c'est Sauvola qui porte le mode sniper. Le test
navigateur (`ui-e2e.mjs`) verrouille toujours — il a pris deux régressions
au passage, invisibles au banc, ce qui confirme qu'il faut le lancer.

Deux réserves. Les fixtures sont des captures d'écran recadrées, à la
résolution de l'affichage, pas les recadrages natifs que reçoit l'OCR : la
trame peut y différer. **Un appui sur la vignette en haut à gauche du viseur
enregistre désormais le recadrage réel** — c'est ainsi qu'il faut nourrir
`scripts/fixtures/` avant toute nouvelle décision. Et la carte fausse de MAMA
ne se règle ni par le seuil ni par la marge : « 3 » lu « Z » devient « 2 »
par une table de transposition aveugle, là où le moteur, contraint à un
chiffre à cette position, choisirait « 3 » d'après la forme. C'est l'argument
le plus fort pour `user_patterns` ci-dessous.

Une règle de rapprochement **structurée** a aussi été mesurée hors ligne :
numéro identique exigé, préfixe à une édition près, unique. Sur les 120
lectures du banc : 94 bonnes, 0 fausse, 26 abandons, contre 99 / 1 / 20 pour
seuil + marge. Elle n'a pas été adoptée — cinq bonnes cartes perdues pour une
fausse que le vote arrête déjà — mais elle est le premier réglage à
reconsidérer si de vrais recadrages montrent des fausses cartes par erreur de
numéro.

### `user_patterns` : fait, et mesuré

La grammaire d'un code (`setCodePatterns()` dans `ocr.js`, quatre formes
issues d'un recensement des 44 499 codes de l'index) est écrite dans le
système de fichiers du worker puis passée à `reinitialize` — c'est un réglage
d'initialisation, pas un paramètre. Sur les 120 images du banc, sans les
regénérer :

| | Lecture exacte | Bonnes | Fausses | Abandons |
|---|---|---|---|---|
| sans motifs | 87 | 105 | 1 | 14 |
| motifs, premier jeu | 111 | 117 | 0 | 3 |
| **motifs, jeu final** | 104 | **119** | **0** | **1** |

Le premier jeu admettait « lettre de série + trois chiffres », forme qui
n'existe pas dans l'index et par laquelle le « O » inséré (« ENO002 »)
passait ; il n'admettait pas non plus de chiffre au milieu du préfixe, et
« LC5D » devenait « LCSD ». Le jeu final lit moins souvent au caractère près
(le O revient sous la forme « ENO61 », que la transposition répare) mais
retrouve plus de cartes, sans fausse. Les motifs sont un dictionnaire souple,
pas une contrainte dure : sur la fixture MAMA, un « C » parasite collé au
préfixe (« CMAMA-… », six caractères) sort de toutes les formes et le moteur
lit alors librement — la carte fausse « MAMA-FR112 » subsiste sur cette
capture d'écran. À vérifier sur un recadrage natif.

### Interface : ce qui a changé et pourquoi

- **Reveal.** L'arrivée (`card-arrive`, définie mais jamais utilisée) et le
  balayage se déclenchent au chargement de l'image, plus au montage : ils
  jouaient sur un rectangle noir. Une vignette basse définition floutée tient
  lieu de visuel pendant les 150 Ko du grand format ; un visuel injoignable
  affiche le nom plutôt que du noir.
- **Panneau.** Nom sur deux lignes au lieu d'une troncature ; raretés en
  grille plutôt qu'en rail coupé au bord de l'écran sans indice de
  défilement ; le choix de rareté passe avant le texte d'effet ; « Pas ma
  carte » est proposé aussi pendant ce choix (auparavant il fallait choisir
  une rareté pour pouvoir annuler) ; après validation, le bouton devient
  « Carte suivante » ; une lecture approchée est annoncée comme telle.
- **Viseur.** Une ligne de consigne lisible (« Trop flou : touchez le code »,
  « Code repéré, vérification… ») au-dessus de la lecture brute, conservée en
  petit ; le bouton de torche disparaît quand la torche n'existe pas.

### Le travail suivant

Le mode de défaillance dominant était **en amont du seuil** et il est traité
par `user_patterns`. Ce qui reste, par ordre de valeur : Tesseract insère un « O » entre la région et le numéro sur 25 des
120 lectures (« ENO061 » pour « EN061 »), sur une image parfaitement nette.
Aucun code de l'index n'a de numéro à quatre chiffres, et les 38 clés en
« -O… » sont des coquilles YGOPRODeck (« LAVD-ENO34 »). Par ordre de valeur :

1. **Nourrir `scripts/fixtures/` de recadrages natifs** (appui sur la
   vignette du viseur), en particulier des cartes sombres et des polices à
   empattements : c'est là que R devient K et 3 devient Z, et le banc
   synthétique ne le produit pas. Cinq à dix recadrages réels valent plus que
   n'importe quelle dégradation de synthèse.
2. **Bords du recadrage.** Le « C » parasite de MAMA vient du bord gauche du
   viseur ; un caractère collé au préfixe suffit à sortir des motifs. Écarter
   les composantes qui touchent le bord avant l'OCR, et mesurer.
3. **Proposer le choix sur une ambiguïté.** `resolveSetCode` rend déjà les
   deux clés en concurrence (`between`) ; deux lectures ambiguës concordantes
   pourraient présenter les deux visuels à l'utilisateur au lieu d'un refus
   silencieux. C'est le seul moyen de transformer les abandons restants en
   décisions.
4. **Vote caractère par caractère** entre les binarisations.
5. **Redressement** — inclinaison par variance du profil de projection.

Ce qui a été fait ici est réversible et rejouable : `margin: 0` rend
l'ancien comportement, et le balayage complet tient dans

```bash
export SP=/tmp/ygo && mkdir -p $SP
node scripts/harness/build.mjs
SP=$SP APP=$PWD COUNT=60 node scripts/ocr-confusions.mjs
```

## 4. Ce qu'il ne faut pas croire sur parole

Chacun de ces points a coûté du temps. Ils sont tous vérifiés par une mesure ou
un test ; les remettre en cause demande de refaire la mesure, pas de raisonner.

### Le banc

- **Un banc qui ne cadre pas comme l'utilisateur mesure autre chose que le
  pipeline.** La première version d'`ocr-confusions.mjs` rendait le code plus
  large que le viseur et concluait à 25 % de mauvaises cartes ; le chiffre
  réel était 2 %. Avant de croire un taux d'échec, **ouvrir les images que le
  moteur a reçues** (`$SP/confusions/*.png`). C'est ce qui a tranché ici.
- **Tesseract insère des caractères sur une image nette.** « ENO061 » pour
  « EN061 », 25 fois sur 120, sans flou ni bruit particulier. Ce n'est ni le
  recadrage ni la binarisation : c'est le moteur, et cela se corrige par la
  grammaire de sortie, pas par le seuil de correspondance.

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

### Prétraitement

- **Otsu ne lit pas une vraie carte de près.** Sur les deux fixtures réelles,
  seul Sauvola rend quelque chose : la bordure et la trame ruinent un seuil
  global. Ne pas retirer les variantes Sauvola de la rotation.
- **Lisser avant de seuiller n'est pas une perte de netteté.** Le rayon vaut
  un centième de la hauteur du recadrage : la trame disparaît, les traits
  restent dix fois plus larges. Mesuré : sans lissage, bruit pur ; avec,
  « STOK-FRO40 ».

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
- **Aucun numéro à quatre chiffres, et 38 coquilles.** Un code lu avec quatre
  chiffres est toujours une erreur de lecture. Les clés « LAVD-O34 » et
  consœurs viennent de fautes de frappe YGOPRODeck (« LAVD-ENO34 »), pas d'une
  lettre de série : ne pas les prendre pour une règle.

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
  preprocess.js    lissage, binarisations, bande de texte, netteté (pur, testé)
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
- **Le test navigateur trouve ce que la relecture ne voit pas.** Quatre
  pannes silencieuses ont été prises ainsi, dont deux régressions du
  prétraitement que le banc synthétique et les fixtures réelles donnaient
  pour des améliorations. Le lancer après toute modification de la boucle de
  lecture ou du prétraitement. Hors ligne — Chromium de Playwright ne passe
  pas par le proxy — il faut servir Tesseract en local ; `scripts/README.md`
  donne la procédure.
- **Préférer l'échec au faux positif.** C'est le fil directeur de tout ce qui
  reste à faire. La marge d'ambiguïté en est l'application : 7 bonnes cartes
  sacrifiées pour 10 fausses évitées, et c'est un bon échange.
