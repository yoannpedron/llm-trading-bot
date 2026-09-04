# Scanner Yu-Gi-Oh! — mode « sniper »

Le téléphone est braqué sur une seule inscription de la carte : le **code
d'extension** (`RA03-FR001`). Comme une douchette de supermarché. Ni le titre ni
le passcode ne sont lus — un seul motif à chercher, dans un cadre très allongé,
avec le zoom et la torche pour le rendre lisible.

Une fois le code reconnu, la caméra se fige et l'écran se divise en deux : le
visuel officiel en haut, avec ses effets holographiques ; les données en
français en bas.

- **Capture et OCR** — Tesseract.js dans le navigateur, aucune image n'en sort
- **Résolution** — backend Python (SQLite + rapidfuzz), ou en local sur un index
  embarqué quand aucun backend n'est configuré
- **Interface** — React 19, Vite, Tailwind v4

## Démarrer

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 74 tests, sans navigateur
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
caractères, et un cadre serré évite à Tesseract d'avoir à trier le texte utile du
décor de la carte.

**Zoom** et **torche** sont pilotés par `applyConstraints` sur la piste vidéo. Le
zoom vise ×2,5 au démarrage, avec un curseur pour ajuster : les unités varient
d'un appareil à l'autre — certains rendent un multiplicateur, d'autres une
échelle arbitraire — d'où le calcul par rapport aux bornes annoncées.

### Segmentation : bloc, pas ligne

Tesseract est réglé en **PSM 6 (bloc unique)** et non PSM 7 (ligne unique). La
raison tient à une mesure : la taille du viseur *en pixels vidéo* dépend de la
hauteur de l'écran. Sur un conteneur court, le même cadre à l'écran couvre une
bande 1,5 fois plus haute de l'image et embarque la bordure du cadre de la carte.

| Cadrage | PSM 7 | PSM 6 | PSM 3 | PSM 11 |
|---|---|---|---|---|
| serré (818×136) | ✅ | ✅ | ✅ | ✅ |
| large (1189×198) | **vide** | ✅ | vide | bruit |

PSM 7 rend alors une chaîne vide, avec une confiance de zéro et sans lever la
moindre erreur. Un test verrouille ce réglage.

## Prétraitement

Deux binarisations sont essayées, dans l'ordre :

1. **Otsu** — seuil global par maximisation de la variance inter-classe ;
2. **Sauvola** — seuil local calculé par fenêtre à partir de la moyenne et de
   l'écart-type.

Otsu suffit sur une carte bien éclairée. Sauvola rattrape les reflets du vernis :
un seuil global bascule toute une moitié d'image en blanc dès qu'un reflet la
traverse, là où un seuil local relève simplement son propre seuil. Un test
compare les deux sous éclairage inégal et vérifie que Sauvola l'emporte.

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
| `fuzzy` | le plus proche au-delà d'une note plancher (82) |

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
| `VITE_TESSERACT_*` | — | servir le moteur OCR depuis son propre domaine |

## Déploiement

**GitHub Pages** — `.github/workflows/pages.yml` construit et publie à chaque
poussée. Une seule action manuelle : Settings → Pages → Source « GitHub Actions »,
et l'environnement `github-pages` doit autoriser la branche.

**Le backend Python ne tourne ni sur Pages ni sur Netlify Functions**, qui
n'exécutent pas de Python. Cible : Render, Railway, Fly.io ou un conteneur.

L'accès à la caméra exige HTTPS ; `localhost` fait exception.

## Tests

```bash
npm test                      # 74 tests JS
python3 -m pytest backend     # 40 tests Python
```

Couvrent l'extraction et la transposition des codes (des deux côtés, avec les
mêmes cas), la géométrie du viseur, le prétraitement, l'appariement local et
serveur, la régionalisation, les conflits de rareté, l'historique et l'export CSV.

Deux défauts trouvés par ces tests, qu'aucune relecture n'aurait attrapés :
`logger: undefined` passé à Tesseract écrasait son journal par défaut et tuait
les workers à la première image ; et PSM 7 rendait une chaîne vide, sans erreur
ni indice, dès que le viseur couvrait une bande un peu plus haute.
