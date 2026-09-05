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

### Journal des lectures

Un troisième onglet, distinct de l'inventaire et pour une raison de fond :
l'inventaire répond à « qu'est-ce que je possède » — il dédoublonne, compte les
exemplaires, ne retient que ce qui a été validé. Le journal répond à
« qu'est-ce que j'ai passé sous le viseur, et qu'est-ce que ça a donné ». Il
est chronologique, ne dédoublonne rien, et conserve **les échecs de saisie
manuelle avec ce qui avait été tapé** — souvent la seule trace exploitable
quand on cherche pourquoi une carte ne passe pas.

Les échecs de la caméra n'y figurent pas : elle en produit plusieurs par
seconde et le journal deviendrait illisible. Il est borné à 300 entrées, sans
quoi il finirait par saturer le stockage et emporterait l'inventaire avec lui.

### Torche

Deux défauts corrigés, tous deux invisibles en test :

- **Le bouton disparaissait sur des appareils dont la lampe fonctionne.**
  `available` venait du seul `getCapabilities().torch`, que plusieurs
  navigateurs mobiles ne renseignent pas tant qu'aucune contrainte n'a été
  appliquée. La commande est désormais proposée dès qu'une piste vidéo existe,
  et retirée seulement après un essai réel infructueux.
- **Le bouton s'allumait sans que la lampe s'allume.** `applyConstraints`
  résout sans erreur même quand la contrainte est ignorée — une contrainte
  placée dans `advanced` est explicitement « au mieux » selon la spécification.
  On essaie donc la forme obligatoire `{ torch }` puis la forme `advanced`, et
  surtout **on relit `getSettings().torch`** pour savoir ce qui s'est vraiment
  produit. Si le réglage ne suit pas, on le dit au lieu de mentir sur l'état.

Rappel utile : Safari ne donne la lampe à aucun site, sur iOS comme sur macOS.
Sur Android, Chrome et Edge la donnent, Firefox non. Un utilisateur d'iPhone ne
verra donc jamais ce bouton, et ce n'est pas un défaut de l'application.

### Ce qui n'existe pas encore

- **Netlify.** La configuration est complète (`netlify.toml`, fonction
  `netlify/functions/price.js`) et un workflow `.github/workflows/netlify.yml`
  déploie à chaque poussée — mais il lui faut deux secrets de dépôt, qui ne
  peuvent être créés que par le propriétaire :

  | Secret | Où le trouver |
  |---|---|
  | `NETLIFY_AUTH_TOKEN` | https://app.netlify.com/user/applications#personal-access-tokens |
  | `NETLIFY_SITE_ID` | Site configuration → General → Site information → Site ID |

  Sans eux, le job s'arrête proprement avec un message plutôt que d'échouer.
  Ce que Netlify apporte et que GitHub Pages ne peut pas : la fonction
  `/api/price` interroge Cardmarket, donc une cote **par rareté et par état**,
  au lieu de la moyenne YGOPRODeck toutes raretés confondues.

  Attention : la fonction souffrait du **même défaut que le client** — elle
  cherchait par nom, et le client envoie le nom français. Corrigé, elle prend
  désormais le passcode.

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

- **107 tests JS** (`npm test`) et **44 tests Python** (`python3 -m pytest backend`)
- Chaîne complète validée en navigateur avec caméra simulée
- Déployé et servi sur GitHub Pages
- **Moteur de lecture remplacé** : PP-OCRv6 à la place de Tesseract (voir la
  section « Le changement de moteur » ci-dessous, à lire en premier — elle
  rend caduque une bonne part de la section 3, conservée comme historique)

---

## Le changement de moteur : Tesseract → PP-OCRv6

Reproche de l'utilisateur, après tout le réglage de Tesseract : « ça prend
encore trop de temps », « même super net et sous la lampe ça marche pas
bien », puis une application Android native (`pt.tscg.yugiohmanager`) qui
« fonctionne beaucoup mieux ». La raison est structurelle : une application
native lit avec ML Kit, un réseau de neurones entraîné sur du texte
photographié ; Tesseract est conçu pour des scans à plat, et tout le
prétraitement du projet servait à lui fabriquer un scan à partir d'une photo.

Le seul équivalent utilisable dans un navigateur sans drapeau expérimental
(`TextDetector` de la Shape Detection API en exige un) est **PP-OCR**, via
`ppu-paddle-ocr` (MIT, ONNX Runtime Web). Mesuré avant de décider, sur les
trois recadrages réels de `scripts/fixtures/`, six images bruitées chacun,
image brute sans aucun prétraitement :

| Moteur | Poids | Cartes lues | Images bonnes | Fausses | Par passe |
|---|---|---|---|---|---|
| Tesseract, réglé | 5 Mo | 2/3 (STOR jamais) | — | 0 | 490 ms |
| PP-OCRv6 tiny | 6 Mo | 2/3 (MAMA jamais) | 10/18 | 0 | 190 ms |
| PP-OCRv5 en mobile | 13 Mo | 2/3 | 12/18 | 0 | 320 ms |
| tiny det + small rec | 23 Mo | 3/3 | 13/18 | 0 | 320 ms |
| **PP-OCRv6 small** | **31 Mo** | **3/3** | **15/18** | **0** | **380 ms** |

Décision : **small**. Trente et un mégaoctets, une fois, contre une carte sur
trois qui ne se lit jamais. Le petit modèle bute sur la carte floue
(MAMA-FR113) ; le moyen la lit à la première image, et lit STOR-FR040 — dont
le R devenait K sur toutes les images avec Tesseract — six fois sur six.

Ce qui a été essayé et écarté, pour ne pas le refaire :

- **Une marge grise autour du recadrage** (16, 24, 40 px) : aide le tiny,
  fait perdre une carte au small (le détecteur accroche la bordure). Aucune
  marge.
- **Agrandissement ×1,5 et ×2** : n'apporte rien, coûte 50 à 100 % de temps.
- **`paddingHorizontal`/`paddingVertical` du détecteur** : effet nul sur le
  small.
- **Les modèles v5 anglais / latin** (dictionnaire réduit, donc pas de
  caractère chinois hallucinné) : moins bons que le v6 small malgré tout.

Ce qui a changé dans le code :

- `src/lib/ocr.js` : façade ; `src/lib/ocr.worker.js` : le moteur, dans un
  worker ; `src/lib/modeles.js` : manifeste des fichiers, téléchargement avec
  progression, Cache API.
- `src/lib/preprocess.js` : réduit au recadrage brut et à la netteté. Otsu,
  Sauvola, polarités, `stripEdgeInk`, `textBand`, `echelleDeLecture`,
  `user_patterns`, la passe chiffres : **supprimés**, avec leurs tests.
- `src/lib/useSniper.js` : une passe par tour, le texte entier va à la
  résolution (`normalizeOcrText` sépare les mots ; un libellé voisin ne gêne
  pas).
- `public/modeles/` : les trois fichiers du modèle et le WebAssembly d'ONNX
  Runtime, **versionnés** — l'application ne dépend d'aucun CDN.
  Le `.gitignore` racine avale `*.txt` : une exception couvre le dictionnaire.
- Bancs Tesseract supprimés (`ocr-confusions`, `ocr-multiframe`,
  `ocr-strategies`, `font-confusions`, `real-crops`, `live-crop`).
  `scripts/ocr-bench.mjs` réécrit : il sert le vrai code par Vite (le worker
  interdit l'empaquetage en bibliothèque) et rejoue le tableau ci-dessus.

Délai de verrouillage sur la caméra simulée (`scripts/harness/time-to-lock.mjs`,
mesuré à partir du moment où le moteur est prêt) : **0,86 s** (étendue
0,85–0,87), contre 0,49 s avec Tesseract réglé ; la chronologie fine donne
0,5 s entre « moteur prêt » et la carte affichée, le reste est le temps de
rendu et de sondage du banc. Une première mesure donnait 1,8 s : l'index des
cartes n'était chargé qu'à la première résolution. Il est désormais préchargé
pendant le téléchargement du moteur, et le worker fait une inférence à vide à
l'initialisation. Le banc attend le libellé « moteur de lecture » — pas
« Chargement du moteur », qui n'existe plus — sinon il mesure le
téléchargement.

Ce qui n'est pas encore mesuré : **la vitesse sur un téléphone**. Sur
ordinateur, une passe coûte 380 à 430 ms. Sur Chrome Android, WebGPU est
disponible et prend le relais de lui-même (les fichiers `.jsep.*` d'ONNX
Runtime sont ceux de WebGPU, les autres ceux de WebAssembly seul — les quatre
sont servis, le navigateur ne charge que sa paire). Sur un appareil sans
WebGPU, il faudra mesurer sur place. Si c'est trop lent : le
`coi-serviceworker.js` livré avec `ppu-paddle-ocr` active les threads
WebAssembly sans en-têtes serveur (GitHub Pages ne les pose pas) ; c'est la
première chose à essayer.

---

## Le changement de méthode : l'illustration identifie la carte, plus le code

**État (5 septembre 2026) : branché dans le viseur, mesuré sur un banc
synthétique, PAS ENCORE mesuré sur un téléphone avec une vraie carte.**

### Pourquoi

Lire une inscription de deux millimètres reste le maillon fragile quel que soit
le moteur : il faut viser, être net, être près. Les applications de référence
n'identifient pas la carte par le code mais par son **illustration**, qui
occupe la moitié de la carte et se reconnaît à trente centimètres, de travers,
sous un reflet. Le code ne sert qu'à distinguer les tirages.

### Comment (`src/lib/`)

| Module | Rôle |
|---|---|
| `art.js` | empreinte d'une illustration : vignette 16×16 centrée-réduite (corrélation), DCT 64 bits (Hamming), couleur 4×4 ; index plat sérialisé ; recherche à deux étages (présélection Hamming, puis score complet) |
| `quad.js` | trouver la carte : Sobel, droites de Hough pondérées, quadrilatères candidats, **pré-classement appris** (régression logistique : liseré noir, proportions, taille), affinage des coins sur le liseré noir, dilatation, homographie, redressement |
| `identifier.js` | la chaîne : détection à 448 px, toutes les hypothèses affinées puis appariées, seconde détection rapprochée pour les petites régions, orientation par la luminance de la zone de texte, décalages autour des finalistes |
| `identifier.worker.js`, `identifierClient.js` | la chaîne dans un worker, l'image transférée sans copie |
| `artIndex.js` | chargement de `public/art-index.bin` (8,8 Mo, une fois) avec progression |
| `verdictArt.js` | quand accepter (score ≥ 0,85 et marge ≥ 0,05 : à la première image ; 0,70 à 0,85 : deux images d'accord ; en dessous : rien), et la mise à la forme d'un résultat de scan (tirages français d'abord) |
| `useSniper.js`, `SniperView.jsx` | plus de fenêtre de visée : l'image entière part au worker, le contour trouvé est dessiné à sa place à l'écran |

### Ce que le banc dit (`scripts/art-bench.mjs`, 200 scènes 1080×1920, index complet)

| | |
|---|---|
| bonne carte en tête | **83 %** |
| carte grande dans l'image (≥ 60 % de la hauteur) | 92-93 % |
| carte petite (25 %) | 63 % |
| carte localisée | 99 % |
| appariement seul, coins exacts | 99 % |
| appariement à ±12 px d'erreur de coin | 99 % ; à ±24 px, 93 % |
| temps par image, ordinateur, JavaScript pur | ~490 ms (détection 150, le reste en évaluation d'hypothèses) |

Le point de départ de la journée était 30 %. Ce qui a fait la différence, dans
l'ordre, avec la mesure qui l'a justifié :

1. **Hough au lieu de composantes connexes** (56 → 88 % de localisation).
2. **L'appariement choisit le contour** parmi plusieurs hypothèses, au lieu
   d'un critère géométrique : un rectangle uni a des bords parfaits mais ne
   ressemble à aucune carte.
3. **Pré-classement appris** sur 25 000 candidats étiquetés du banc
   (`_traits` dans `banc-art.js`) : le vrai contour passe du rang médian 4 au
   rang 0. Poids dans `trouverQuads`. Le liseré noir pèse le plus, la
   richesse intérieure ne compte pas.
4. **Orientation par la luminance de la zone de texte** (plus claire que son
   miroir sur 100 % des 3 000 visuels testés, 31 niveaux au 1er centile) :
   décidée par la carte, pas par l'appariement — une carte à l'envers
   ressemblait parfois mieux à une autre carte.
5. **Index à deux cadrages** (bord exact, et bord intérieur du liseré à 2,7 %)
   : tolérance à ±24 px passée de 87 à 93 %.
6. **Seconde détection rapprochée** pour les petites cartes (56 → 63-68 %).

### Faux positifs : ce que le banc étendu a dit, et la politique retenue

Le banc mesure depuis le 5 septembre les FAUX POSITIFS (`SCENES=200
INCONNUES=60 SANS_CARTE=40`) : cartes absentes de l'index, scènes sans carte.
Résultat : la politique « deux images d'accord entre 0,70 et 0,85 » n'accepte
rien de faux sur le banc… parce que le banc tire deux images DIFFÉRENTES de
la même carte. Sur un téléphone immobile, les images sont identiques et une
mauvaise lecture se confirme elle-même : c'est l'explication la plus probable
des fausses cartes vues sur l'appareil. La confirmation par répétition a donc
été retirée. Ce qui tient, c'est la MARGE avec la deuxième carte : cartes
connues 0,27 en médiane, cartes inconnues 0,03.

Politique en place (`verdictArt.js`, chiffres du banc étendu) :

| zone | règle | bonnes acceptées | fausses (connues / inconnues / sans carte) |
|---|---|---|---|
| sûre | score ≥ 0,85 et marge ≥ 0,05, ou score ≥ 0,75 et marge ≥ 0,12 | 77,5 % | 0,5 % / 0 % / 0 % |
| à proposer | score ≥ 0,70 et marge ≥ 0,03 : les trois meilleures cartes, l'utilisateur touche la sienne | la bonne est dans les trois 8 fois sur 19 | 13 scènes négatives sur 60 déclenchent une proposition |
| rien | en dessous | — | — |

Le prix : 77,5 % de verrouillage automatique au lieu de 88 %, contre des
verrouillages faux qui se répètent. La fiche affiche « confiance / marge »
pour toute carte reconnue par l'illustration : c'est ce qu'il faut lire dans
une capture d'écran quand la carte est fausse.

### Le tirage : lu sur la carte, parmi les tirages de la carte

Une fois la carte identifiée, son code de tirage (« LDK2-FR001 ») n'a plus à
être cherché parmi 44 000 codes mais parmi les siens (3 en médiane, 59 au
pire). `src/lib/tirage.js` (pur) apparie une lecture OCR au code le plus
proche de la carte, `src/lib/lireTirage.js` redresse la carte en 813×1185,
découpe la bande du code (`BANDE_CODE`), l'agrandit et la lit avec
`ocr.js` — le moteur de 31 Mo n'est chargé qu'à ce moment-là.

Mesuré (`scripts/harness/code-bench.mjs`, code imprimé sur les visuels
officiels qui sont des « Replica » sans code, donc borne haute) : lisible
dès que la carte occupe 60 % de la hauteur de l'image (81 %), 89 % à 90 % ;
similarité ≥ 70 et avance ≥ 5 sur le deuxième code : 100 % de précision,
77 % de rappel ; 210 ms par bande en WebGPU.

### Vitesse : où passe le temps, et ce qui l'a divisé par trois

Instrumenté par étape (`ms` rendu par `identifierCarte`, imprimé par le
banc). Sur la machine de développement, 1080×1920 réduit à 448 :

| étape | avant | après |
|---|---|---|
| détection (gris, flou, Sobel, Hough, candidats) | 100 ms | 55 ms |
| gris pleine résolution | 7 | 7 |
| hypothèses évaluées (affinage, empreinte, recherche) | 101 ms pour 44 | 10 ms pour 2 |
| détection rapprochée | 83 | 0 (seulement si rien de sûr) |
| finalistes | 30 | 10 |
| **image entière** | **276 ms** | **83 ms** |

Ce qui a compté : pics de Hough ramassés en une passe au lieu de 24
balayages ; `atan2` seulement pour les pixels qui votent ; flou séparable ;
arrêt de l'évaluation dès qu'une hypothèse atteint la zone sûre de
`verdictArt` (le pré-classement appris met le vrai contour en tête dans
84 % des cas) ; soutien des bords calculé seulement pour les candidats qui
peuvent encore entrer dans les quarante retenus (1 582 → 664 candidats
notés). Précision inchangée (86-88 % sur la même graine, dans le bruit de
mesure). Sur téléphone, compter deux à trois fois plus.

### Ce qui a été essayé et ne marche pas (ne pas refaire)

- Revenir à un seul cadrage par carte dans l'index (4,5 Mo au lieu de 8,8)
  une fois l'affinage des coins au point : sur le banc complet, 87 % contre
  85 % en une image, mais 2 fausses cartes (1 connue, 1 inconnue) contre 0,
  et 89,5 % contre 95 % de verrouillages sûrs sur deux images. La taille du
  téléchargement ne vaut pas deux fausses cartes sur 300 scènes.

- Dilater par homothétie pour retrouver le bord depuis le liseré : ne
  décale pas les côtés de la même largeur. `dilater` décale chaque côté le
  long de sa normale (test).
- Corriger l'orientation par la luminance du liseré aux deux extrémités :
  80 % → 71 %.
- Une recherche locale du contour guidée par le score d'appariement (sept
  décalages) : 79 → 71 %, elle trouve des scores élevés sur de FAUSSES cartes.
- Une marge d'illustration plus large (10 % au lieu de 6 %) : aucun effet.
- Voter avec le carré du gradient dans Hough : 88 → 75 %.
- Dédupliquer les hypothèses à une tolérance relative à leur taille, seule :
  40 variantes d'une seule région, 65 %. Il faut deux niveaux (régions, puis
  variantes).
- Plus d'hypothèses (150 au lieu de 40) : 81 %, pour trois fois le temps.

### Ce qui reste, dans l'ordre

1. **Mesurer sur un téléphone avec une vraie carte.** Tout ce qui précède est
   synthétique ; le domaine réel (carte imprimée, vernis, lampe) n'a pas été
   vu. `ui-e2e.mjs` prouve seulement que la chaîne tourne en navigateur.
2. **Lire le code d'extension automatiquement** quand la carte est assez
   grande : la carte est redressée, la position du code est connue ; l'OCR
   (`ocr.js`, PP-OCRv6, toujours là) n'a qu'à lire cette zone. Mesurer d'abord
   à partir de quelle taille de carte le code se lit.
3. **Vitesse** : 490 ms sur ordinateur, à mesurer sur téléphone ; les
   leviers sont le nombre d'hypothèses évaluées et la présélection Hamming.
4. **Petites cartes** (63 %) : la détection à 448 px n'a qu'un pixel de
   liseré. La seconde passe rapprochée aide ; une troisième échelle ou une
   détection guidée par le suivi entre images sont les pistes.

### La langue des cartes : le réglage « Région »

L'index embarqué ne porte que des codes anglais. Mesuré sur les 44 499
tirages de `public/card-index.json` : 41 482 têtes « EN » (dont 2 682 avec
une lettre de série, « LEHD-ENA26 »), 456 « PT », 732 codes anciens à une
lettre (« PSV-E088 »), 1 808 sans région (« AST-070 »), zéro code FR/DE/IT.
Or l'utilisateur doit reconnaître le code inscrit sur SA carte.

`src/lib/region.js` (pur, testé) : la liste des régions (EN, FR, DE, IT, SP,
PT, JP, KR, AE, TC, SC — il n'existe pas de cartes danoises, le Danemark
reçoit l'anglais, le libellé le dit), la préférence dans `localStorage`
(`ygo.region`, défaut FR), `codePourRegion` et `tiragesPourRegion`. La
conversion s'applique à l'AFFICHAGE (`fiche.js`, `ficheDepuisScan` et
`entreeDepuisScan` reçoivent la région), pas à l'identification : la
préférence peut changer devant la liste des tirages, et la liste suit.
Ce qui est lu sur la carte prime : un code tapé « LOB-EN001 » reste anglais
(`regionLue`, posé par `match.js` et `scanApi.js`).

Ce qui n'est PAS converti, et pourquoi : un code sans région est une édition
nord-américaine dont la numérotation diffère de l'européenne — le Magicien
Sombre est « LOB-005 » en Amérique et « LOB-E003 » en Europe ; fabriquer
« LOB-F005 » désignerait une autre carte. Les codes à une lettre ne se
convertissent que vers E/F/G/I/S/P. Les régions OCG (JP, KR, AE, TC, SC)
sont proposées mais leurs extensions ne suivent pas la numérotation TCG : le
code dérivé est indicatif, le libellé le dit.

Interface : bouton « Région : FR » dans la barre du viseur (ouvre « Langue
de vos cartes »), et le même réglage devant la liste des tirages sur l'écran
de résultat. Vérifié dans le navigateur (`scripts/harness/ui-region.mjs`) :
Magicien Sombre, 59 tirages en FR puis en DE dans le même ordre, code
enregistré « LDK2-DEY10 », préférence conservée au rechargement.

Limites : l'inventaire et le journal gardent le code de la langue en vigueur
au moment de l'enregistrement (pas de réécriture rétroactive) ; le backend
Python (`VITE_API_BASE`) n'a pas été touché.

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

### Raretés : une seule table

Trois classifications se contredisaient : `rarityProfile` (six clés, dont
« ultimate » que le CSS ne connaissait pas, et des intensités que personne ne
lisait), `rarityTier` (cinq clés, Collector's en « secret » là où le profil
disait « ultimate »), et une table de couleurs propre à `DataPanel`. Les
Parallel, Starfoil et Mosaic tombaient dans « rare » (nom argenté) alors que
ce sont des foils pleine surface ; l'Ultimate recevait un arc-en-ciel alors
que c'est un relief sans couleur.

`src/lib/rarity.js` est désormais la seule table : treize paliers, chacun
décrit **zone par zone** (nom, illustration, bandeau des étoiles, bordures,
carte entière, carte entière sauf la boîte de texte) avec une **finition par
zone** (argent, or, arc-en-ciel, motif, relief, platine, ghost) et une
texture éventuelle (diagonales Secret, scintillement). Une Ultra a
l'illustration en holo et le nom en or sur la même carte : un seul palier ne
pouvait pas le dire. `HoloCard` rend une couche par zone, `holo.css` ne
connaît plus les raretés. `test/rarity.test.js` fixe le palier de chaque
libellé réel de l'index, coquilles comprises, et les zones de chaque famille.

**Le holo ne couvre « toute la carte » que pour les Parallel** (Starfoil,
Shatterfoil, Mosaic, Duel Terminal). Starlight et Quarter Century couvrent
tout sauf la boîte de texte ; Gold, Platinum, Ultimate et Collector's foilent
les bordures mais pas le texte ; Super, Ultra, Secret ne touchent que
l'illustration, les étoiles et, selon le cas, le nom ; une Rare n'a que le
nom argenté. Sources : Yugipedia, TCGplayer. Vérifié à l'écran sur une
planche de huit paliers rendus sur un vrai visuel (`$SP/holo-check.png`,
fabriquée à la main — les masques d'anneaux de bordure y ont révélé un
décalage : en CSS, une position de masque en pourcentage se rapporte à
l'espace restant, pas au conteneur ; le calcul est commenté dans
`holo.css`).

Deux questions posées, deux réponses : les reflets sont **pertinents pour
les cartes françaises** — la rareté est celle du tirage, identique dans
toutes les langues — et ils sont **pertinents tout court** pour une seule
raison : confirmer d'un coup d'œil la rareté choisie, qui décide du prix.
Ils n'aident pas l'identification et coûtent du GPU sur mobile ; s'il faut
un jour trancher, c'est cet usage-là qu'il faut préserver, pas le spectacle.

### Saisie manuelle du code

La caméra ne peut pas tout : pas de caméra du tout (ordinateur, autorisation
refusée), code effacé ou abîmé, carte sous étui. Un formulaire dans le viseur
résout un code tapé **par le même chemin que le scan** — `submitCode()` dans
`useSniper.js` appelle `scanCode()`, donc backend Python si configuré, index
local sinon, et le même écran de résultat avec le même choix de rareté.

Trois points qui ne se devinent pas :

- **La boucle de lecture s'arrête pendant la frappe.** Sans cela elle
  verrouille sur la carte visée et démonte le formulaire au milieu d'un mot.
  Trouvé par `scripts/harness/manual-entry.mjs`, qui tape caractère par
  caractère précisément pour cela — le champ disparaissait entre deux touches.
  D'où l'état `manualEntry` **dans le hook** et non dans le composant.
- **`rescan()` n'y touche pas.** Valider une carte tapée ramène au formulaire,
  pas au viseur : qui saisit un code en saisit dix. C'est la seule raison pour
  laquelle cet état ne vit pas dans `SniperView`.
- **La complétion évite la faute de frappe.** `suggestSetCodes()` propose les
  codes de l'index qui commencent par ce qui est tapé, en conservant la région
  saisie (« LOB-FR0 » propose « LOB-FR001 », pas la forme anglaise). On ne tape
  jamais le code en entier, et un code inconnu se voit tout de suite. L'index
  pesant 1,4 Mo, son chargement est annoncé — sans ce témoin, une saisie valide
  semble sans proposition pendant la première seconde.

### Vitesse et fiabilité de la lecture : ce que la mesure a dit

Reproche de l'utilisateur, mot pour mot : « ça prend encore trop de temps » et
« même super net et sous la lampe ça marche pas bien ». Les deux étaient
fondés, et pour des raisons différentes.

Deux bancs ont été écrits pour répondre : `scripts/ocr-bench.mjs` (où passe le
temps, poste par poste) et `scripts/harness/time-to-lock.mjs` (le délai réel
entre le cadrage et l'affichage de la carte, dans le navigateur).

#### La lenteur : trois causes, toutes mesurées

| Poste | Avant | Après |
|---|---|---|
| **Délai jusqu'au verrouillage** | 1,66 s (étendue 1,36–2,26) | **0,49 s** (0,48–0,51) |

1. **L'agrandissement était le pire des quatre essayés.** La règle visait une
   bande de 240 px, soit des capitales d'environ 120 px. Tesseract lit le mieux
   des capitales de trente à cinquante pixels ; au-delà il ne gagne rien et
   paie chaque pixel.

   | bande | agrandissement | reconnaissance | cartes retrouvées |
   |---|---|---|---|
   | 102 | ×1,5 | 50 ms | 2/3 |
   | 136 | ×2 | 41 ms | 1/3 |
   | 170 | ×2,5 | 72 ms | 2/3 |
   | **238** | **×3,5 (l'ancien réglage)** | **109 ms** | **1/3** |

   La règle vise désormais 110 px (`echelleDeLecture`), et ne réduit jamais en
   deçà du natif.

2. **La moitié du temps partait dans une binarisation qui ne lit rien.** Otsu
   coûte 230 à 361 ms de reconnaissance et retrouve **zéro** carte réelle sur
   trois ; Sauvola coûte 50 ms et en retrouve deux. Tesseract passe ce temps à
   tenter de segmenter du bruit. L'ancienne boucle prenait deux variantes par
   tour en faisant tourner le point de départ : un tour sur deux commençait
   donc par Otsu. Les variantes sont maintenant essayées **dans l'ordre de leur
   efficacité mesurée**, on s'arrête au premier succès, et Otsu — excellent sur
   une image propre, donc conservé — n'est calculé qu'en dernier recours.

3. **Le lissage était fait en JavaScript.** C'était le poste de prétraitement
   le plus lourd : 57 à 86 ms. Le flou du canvas est natif : 9 ms sur la même
   image, pour 0,3 % de pixels de différence.

#### La fiabilité : ce qui ne marchait pas, et pourquoi

Le vote entre images successives, inscrit depuis longtemps sur la liste des
choses à faire, a été **implémenté, mesuré, et il n'apporte rien**
(`scripts/ocr-multiframe.mjs`, six images simulées par carte). La raison est
nette : les erreurs ne sont pas aléatoires, elles se répètent à l'identique.
Le moteur lit « STOK » à chaque image, jamais « STOR ». Voter sur des erreurs
constantes ne fait que les confirmer. `CharacterVote` reste dans `vote.js`,
avec ce résultat négatif écrit noir sur blanc : ne pas le rebrancher sans
nouvelle mesure.

Ce qui marche, c'est de rendre l'erreur **impossible** plutôt que rattrapable :

- **Une deuxième passe sur le numéro, en chiffres seuls.** Le moteur lit « 113 »
  comme « IIZ » et « 040 » comme « O40 » sur la police à empattements des
  cartes. Avec un alphabet réduit aux chiffres, un « I » ou un « Z » ne peut
  plus sortir. C'est la parade que le projet employait déjà pour le passcode.
  Elle ne se déclenche que si la première passe a échoué **ou n'a rendu qu'une
  correspondance approchée** — dans le cas courant elle ne coûte rien.
- **L'encre qui touche le bord du recadrage est effacée** (`stripEdgeInk`). Le
  liseré de la carte devenait une lettre fantôme : « MAMA-FR113 » lu
  « COMAMA-FRIIZ », dont le préfixe à six caractères sort de la grammaire d'un
  code. Une garde protège les vraies lettres : on n'efface que les composantes
  plus étroites qu'un glyphe.

| Sur les trois recadrages réels | Bonnes | Fausses |
|---|---|---|
| avant | 1/3 | 1 |
| **après** | **2/3** | **0** |

Sur le banc synthétique, 60 codes × 2 dégradations : **100 % et 98 %** de
cartes retrouvées, **zéro fausse**.

#### Ce qui résiste encore, et pourquoi

`STOR-FR040` reste refusé. Le moteur lit le R comme un K, à chaque image. Or
« STOK-040 » est à exactement un caractère de **deux** codes réels,
« STOR-040 » et « STON-040 » : le refus est correct, pas un défaut. Le seul
remède serait un modèle entraîné sur la police des cartes.

Le modèle « best » de Tesseract a été essayé et **écarté** : il exige une
compilation SIMD que le moteur WebAssembly du projet n'embarque pas — il
s'interrompt sur `missing function: DotProductSSE`, hors de toute portée `try`
puisque l'erreur vient du worker — et il pèse 12,8 Mo contre 5,2, rédhibitoire
sur un réseau mobile.

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
2. **Un modèle entraîné sur la police des cartes.** C'est désormais la seule
   piste qui puisse débloquer les confusions R/K, et elle demande des données :
   quelques centaines de recadrages annotés, que la vignette de diagnostic du
   viseur permet de collecter.
3. **Proposer le choix sur une ambiguïté.** `resolveSetCode` rend déjà les
   deux clés en concurrence (`between`) ; deux lectures ambiguës concordantes
   pourraient présenter les deux visuels à l'utilisateur au lieu d'un refus
   silencieux. C'est le seul moyen de transformer les abandons restants en
   décisions.
4. **Redressement** — inclinaison par variance du profil de projection. C'est
   la dernière transformation d'image qui n'ait pas été essayée.

Le vote caractère par caractère, qui figurait ici, en a été retiré : il a été
mesuré et ne rend rien (voir plus haut).

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

### Tesseract (historique — moteur remplacé)

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

### Prétraitement (historique — chaîne supprimée)

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
  preprocess.js    lissage, binarisations, bande de texte, bords, netteté (pur, testé)
  ocr.js           profils Tesseract, un worker par profil
  parse.js         extraction et transposition des codes (pur, testé)
  match.js         résolution exact / régional / approché (pur, testé)
  vote.js          confirmation sur plusieurs images (pur, testé)
  rarity.js        paliers de rareté : zones, finitions, couleurs (pur, testé)
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
