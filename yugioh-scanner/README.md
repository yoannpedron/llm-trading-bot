# Scanner Yu-Gi-Oh! — identification par OCR et cote Cardmarket

Présentez une carte à la webcam : le titre et le code d’extension sont lus **dans le
navigateur**, la carte apparaît en haute définition, sa cote suit.

Aucune image ne quitte l’appareil : Tesseract.js tourne côté client. Seuls le nom et le
code identifiés partent vers les API.

- **Front-end** — React 19, Vite, Tailwind CSS v4
- **OCR** — Tesseract.js (WebAssembly, dans le navigateur)
- **Back-end** — une fonction Netlify, uniquement pour contourner l’absence de CORS de
  Cardmarket
- **Données cartes** — YGOPRODeck

## Démarrer

```bash
npm install
npm run dev          # interface seule, sur http://localhost:5173
npm run netlify:dev  # interface + fonction de prix, sur http://localhost:8888
npm test             # 52 tests, sans navigateur
```

`npm run dev` seul fonctionne : sans fonction de prix, l’application bascule d’elle-même
sur les cotes YGOPRODeck (voir « Cotes » plus bas).

## Comment la lecture fonctionne

### Le cadrage

Toute la géométrie vit dans `src/lib/zones.js`, en **fractions du cadre carte** et non de
la vidéo. Une carte mesure 59 × 86 mm ; le cadre garde ce rapport, et les deux zones s’y
placent :

| Zone | x | y | largeur | hauteur |
|---|---|---|---|---|
| Titre | 0,055 | 0,032 | 0,745 | 0,075 |
| Code d’extension | 0,545 | 0,618 | 0,405 | 0,043 |

Le titre s’arrête avant le symbole d’attribut, en haut à droite : c’est un pictogramme,
il ne produit que du bruit. Le code est imprimé sous l’illustration, aligné à droite,
juste au-dessus de la ligne de type.

Le conteneur vidéo adopte le rapport du flux, si bien qu’un pourcentage à l’écran vaut le
même pourcentage dans l’image capturée. **Les guides de visée et le recadrage envoyé à
Tesseract lisent donc les mêmes nombres** : ce que vous alignez est littéralement ce qui
part à l’OCR.

### Le prétraitement (`src/lib/preprocess.js`)

Le fond d’une carte est tout sauf uniforme : dégradé beige des monstres normaux, vert des
magies, magenta des pièges, noir des Xyz, plus le vernis qui renvoie la lumière de la
pièce. Un seuil fixe échoue donc sur au moins une famille de cartes. La chaîne :

1. **Recadrage sur la résolution native** du flux, jamais sur la taille d’affichage — sur
   un téléphone, la vidéo est souvent affichée deux fois plus petite qu’elle n’est
   capturée.
2. **Sur-échantillonnage ×3** — Tesseract veut environ 30 px de hauteur de capitale.
3. **Luma perceptuelle** (Rec. 601 : 0,299 R + 0,587 V + 0,114 B) — c’est la pondération
   qui sépare le mieux le texte noir du rouge des magies comme du magenta des pièges.
4. **Étirement de contraste avec écrêtage de 2 %** à chaque extrémité de l’histogramme.
   L’écrêtage est le point clé : un seul pixel de reflet à 255 et un seul pixel d’ombre à
   0 suffisent à annuler un étirement naïf min/max.
5. **Seuil d’Otsu** — calculé par maximisation de la variance inter-classe, donc adapté à
   chaque prise de vue.
6. **Auto-inversion** — si plus de la moitié des pixels sont noirs après binarisation,
   l’encre et le fond sont intervertis : c’est le cas des cartes Xyz, au titre blanc sur
   fond noir. Du texte occupe toujours une minorité de la surface.

Les fonctions du cœur travaillent sur des tableaux d’octets bruts, sans DOM ni canvas :
elles sont testables sous Node.

### Les expressions régulières (`src/lib/parse.js`)

Un code d’extension a un format rigide — `PRÉFIXE-RÉGION` + numéro — donc **on sait pour
chaque position si on attend une lettre ou un chiffre**. La correction est positionnelle :

- dans le préfixe et la région, on remappe **chiffre vers lettre** : `0→O`, `1→I`, `2→Z`,
  `5→S`, `6→G`, `8→B` ;
- dans le numéro, on remappe **lettre vers chiffre** : `O,Q,D→0`, `I,L→1`, `Z→2`, `S→5`,
  `G→6`, `B→8`.

C’est ce qui rattrape `L0B-EN0O1` en `LOB-EN001` sans jamais casser un code déjà correct.

Deux expressions se relaient : `\b([A-Z0-9]{2,5})-([A-Z0-9]{2,6})\b` pour le cas normal,
et une variante ancrée sur la liste des régions connues quand le tiret a sauté à la
lecture (`LOBEN001`).

Deux détails que l’on n’attrape qu’en s’y frottant :

- **La lettre de série.** `SS01-ENA01` et `LDK2-ENJ01` ont une lettre entre la région et
  le numéro. Mais `ENOO4` en a une aussi… sauf que ce `O` est un zéro. On ne retient donc
  la lettre de série que si le glyphe **ne se confond pas** avec un chiffre.
- **La région.** `EM` est à un caractère de `EN` comme de `EU` : la distance d’édition ne
  tranche pas. On exige que le caractère divergent soit une confusion que Tesseract
  commet réellement — `M/N` oui, `M/U` non — et on ne recale que s’il reste une seule
  candidate.

Le titre, lui, n’est pas corrigé : « Number 39: Utopia » contient légitimement des
chiffres. On garde la première ligne porteuse de texte, on efface le bruit de bordure aux
extrémités, et la comparaison avec la base se fait par distance de Levenshtein.

### Le scan continu (`src/lib/motion.js`)

Il n’y a pas de bouton de capture. Faire tourner l’OCR en boucle serait lent et inutile :
la quasi-totalité des images d’un flux webcam sont identiques à la précédente. On compare
donc une **empreinte de 384 octets** (16 × 24 pixels en niveaux de gris) d’une image à
l’autre, onze fois par seconde, et Tesseract n’est réveillé que si :

- l’image vient de se stabiliser après un mouvement — la carte est posée ;
- **et** l’empreinte stable diffère de celle de la carte déjà identifiée.

D’où la bascule instantanée : présenter une autre carte fait décrocher l’empreinte, l’état
repasse en visée, et un scan part dès la re-stabilisation. Une énergie de gradient sert de
mesure de netteté : un cadre vide ou flou ne déclenche rien.

Les deux zones sont lues **en parallèle**, par deux workers dédiés. Changer
`tessedit_char_whitelist` entre deux appels force Tesseract à reconstruire son moteur : un
worker par configuration supprime ce coût. Le modèle est téléchargé dès l’affichage de
l’écran, pendant que vous autorisez la caméra.

## Rareté et état

**La rareté** est le seul point que la caméra ne peut pas trancher : elle ne voit pas
l’holographie. On la déduit du code d’extension via YGOPRODeck. Un seul résultat : validé
d’office. Plusieurs — une Secret et une Ultimate dans la même série, ou une réédition
anniversaire en Common — l’utilisateur choisit.

**L’état de conservation** ne se déduit d’aucune donnée : ni YGOPRODeck ni la fiche
Cardmarket ne connaissent l’état de *votre* exemplaire. L’échelle proposée est celle de
Cardmarket (MT, NM, EX, GD, LP, PL, PO) et sert à deux choses :

- la fonction de prix transmet `minCondition` à Cardmarket, qui renvoie alors le « à
  partir de » **réel** des exemplaires dans cet état ou mieux ;
- à défaut, un coefficient d’usure est appliqué à la cote de référence. Ce montant est
  alors explicitement étiqueté « cote estimée » à l’écran et dans le CSV.

## Cotes

`netlify/functions/price.js` interroge Cardmarket, puis retombe sur YGOPRODeck.

Le repli n’est pas théorique. Cardmarket **interdit la collecte automatisée** dans ses
conditions d’utilisation et bloque les adresses IP mutualisées d’hébergeur : depuis
Netlify, la requête est refusée la plupart du temps. L’application reste utilisable en
toutes circonstances, et **le champ `source` de la réponse est affiché à l’écran** — vous
savez toujours d’où vient le chiffre. Un lien mène à la fiche Cardmarket, filtrée sur
l’état choisi, pour vérifier les offres réelles.

Sur un hébergement statique (GitHub Pages, `vite preview`), aucune fonction ne répond :
`src/lib/price.js` le constate au premier appel et bascule définitivement sur YGOPRODeck,
qui sert des en-têtes CORS.

Variables d’environnement de la fonction :

| Variable | Défaut | Rôle |
|---|---|---|
| `CARDMARKET_SCRAPE` | `true` | `false` pour n’utiliser que YGOPRODeck |
| `CARDMARKET_TIMEOUT_MS` | `4000` | délai au-delà duquel on passe au repli |

## Historique et export

Les cartes scannées s’accumulent dans le navigateur (`localStorage`), avec leur rareté,
leur état et leur cote. Rouvrir le site **réactualise toutes les cotes** — c’est le
réglage « Actualiser les cotes à l’ouverture ».

L’export CSV reprend l’historique tel qu’il est filtré à l’écran : nom, code, série,
rareté, état, cote, si elle est estimée, cote de référence, source, moyennes, type,
catégorie, attribut, ATK, DEF, niveau, nombre de scans, dates, identifiant et lien
Cardmarket. Séparateur point-virgule et BOM UTF-8 : le fichier s’ouvre directement dans
un tableur francophone, accents compris.

## Réglages

Le panneau est **entièrement dessiné à partir du schéma de `src/lib/settings.js`** :
ajouter une option là-bas la fait apparaître à l’écran, avec son libellé et son
explication. Rien à synchroniser.

- **Scan** — scan continu ou bouton manuel, sensibilité de la détection, affichage de la
  lecture OCR
- **Cartes** — demander l’état à chaque carte, état par défaut
- **Apparence** — animations, voile holographique, fond animé
- **Retour** — bip à l’identification, vibration
- **Données** — conserver l’historique, actualiser les cotes à l’ouverture

Couper « Animations » pose `data-motion="off"` sur la racine du document : une seule règle
CSS neutralise alors toutes les animations, y compris celles déclarées hors de React.
`prefers-reduced-motion` est respecté indépendamment de ce réglage.

## Déploiement

### Netlify (cible)

Le dépôt contient `netlify.toml`. Réglages : dossier de base `yugioh-scanner`, commande
`npm run build`, publication `dist`, fonctions `netlify/functions`. La redirection
`/api/*` vers `/.netlify/functions/:splat` est déjà déclarée.

### GitHub Pages (banc d’essai)

`.github/workflows/pages.yml` construit et publie à chaque poussée. Une seule action
manuelle, la première fois : **Settings → Pages → Source : « GitHub Actions »**.

Le chemin de base est réglé par `VITE_BASE` — `/` sur Netlify, `/<dépôt>/` sur Pages.

L’accès à la caméra exige HTTPS ; `localhost` fait exception. Les deux hébergements sont
en HTTPS.

## Tests

```bash
npm test
```

52 tests sous `node:test`, sans navigateur ni dépendance de test :

- `parse` — formats de code, confusions de glyphes, absence de tiret, bruit de bordure
- `motion` — seuils de stabilité, non-répétition sur la même carte, reprise sur une autre
- `cardmarket` — montants au format européen, lecture du tableau de prix, slugs d’URL
- `collection` — fusion des entrées, échappement et contenu du CSV
- `condition` — échelle Cardmarket, coefficients, distinction relevé / estimation
- `settings` — cohérence du schéma, fusion avec un stockage ancien ou corrompu

## Limites connues

- Cardmarket bloque la plupart des requêtes serveur (voir « Cotes »). Le repli YGOPRODeck
  donne une moyenne toutes raretés confondues.
- L’OCR est entraîné sur l’anglais. Les codes d’extension sont latins dans toutes les
  régions TCG, mais un titre en japonais ou en coréen ne sera pas lu — le code suffit
  alors à identifier la carte.
- Les visuels sont servis par YGOPRODeck. Pour un usage soutenu, leur documentation
  demande de les héberger soi-même.
- `localStorage` peut être refusé (navigation privée, quota) : l’application continue en
  mémoire, sans historique persistant.
