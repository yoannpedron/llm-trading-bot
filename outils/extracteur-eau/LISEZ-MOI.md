# Extracteur de Contrats d'Eau — lecture optique locale

Outil de dépouillement des factures d'eau. Il lit les PDF **sur le poste**,
propose une valeur pour chacun des seize champs du tableau de suivi, **montre
sur la facture l'endroit exact d'où sort chaque valeur**, et n'enregistre rien
avant que quelqu'un ait confirmé.

## Ce qui a changé

La version précédente envoyait chaque facture à un modèle de langage distant
(Gemini) avec des clés d'API inscrites en clair dans le fichier. Cette
version-ci n'en contient plus la moindre trace :

| | Avant | Maintenant |
|---|---|---|
| Lecture | modèle de langage distant | couche texte du PDF, sinon reconnaissance optique locale |
| Factures | téléversées chez un tiers | ne quittent jamais le poste |
| Clés d'API | deux, en clair dans le fichier | aucune |
| Coût | facturé au token | nul |
| Fonctionne hors ligne | non | oui |
| Vérifiabilité | il fallait croire le modèle | chaque valeur est encadrée sur l'image de la facture |

## Utilisation

Ouvrez `Extracteur_Contrats_Eau.html` par un double-clic. Rien à installer,
rien à télécharger : les moteurs de lecture sont contenus dans le fichier.
Navigateur requis : Edge, Chrome ou Firefox à jour.

1. **Lecture** — indiquez le dossier de travail, déposez les PDF, lancez.
2. **Contrôle visuel** — pour chaque champ, la zone lue est encadrée et
   agrandie. Vous confirmez (`Entrée`), corrigez (`E`), déclarez le champ
   absent (`N`), choisissez une autre lecture proposée, ou désignez vous-même
   la bonne zone à la souris — le texte de la zone est alors relu, au besoin en
   reconnaissance optique fine.
3. **Résultats** — le tableau, les contrôles de cohérence, l'arbitrage des
   doublons de compteur ou de contrat.
4. **Export** — classeur `.xlsx` et script `.bat` de classement des preuves.

### Raccourcis du contrôle visuel

| Touche | Effet |
|---|---|
| `Entrée` | confirmer la valeur et passer au champ suivant |
| `E` | corriger à la main |
| `N` | déclarer le champ absent de la facture |
| `←` `→` | champ précédent / suivant |
| `+` `−` | grossir / réduire |
| molette | grossir autour du pointeur |
| glisser | déplacer la vue |

## Comment la lecture fonctionne

Deux sources, dans cet ordre :

1. **La couche texte du PDF**, quand la facture a été produite par ordinateur.
   Elle est exacte au caractère près et donne la position de chaque mot.
2. **La reconnaissance optique** (Tesseract), pour les factures scannées. Les
   pages sont rendues en image puis reconnues ; chaque mot ressort avec sa
   position et son indice de confiance.

Les mots sont ensuite regroupés en lignes, les lignes en colonnes puis en
blocs, et des **règles explicites** en tirent les champs : étiquettes reconnues
(« N° de compteur », « Adresse desservie »…), motifs de valeur, position sur la
page — la fenêtre d'enveloppe désigne le payeur, une somme de lignes
d'abonnement ramenée à six mois donne l'abonnement, une période facturée donne
la périodicité. Aucune inférence statistique, aucun modèle : le champ
« pourquoi » de chaque proposition dit toujours quelle règle a joué.

## Ce qu'il faut en attendre

Mesuré sur onze factures réelles, toutes scannées, de sept émetteurs différents
(SAUR, SUEZ, Veolia, Noréade, AGUR, SEDIF, régie locale), avec une qualité de
reconnaissance optique comprise entre 67 % et 85 % :

| | |
|---|---|
| Champs renseignés automatiquement | environ trois sur quatre |
| Bloc d'adresse du payeur | juste dans la quasi-totalité des cas |
| Distributeur, référence client | juste le plus souvent |
| Numéro de compteur, abonnement | souvent absents de la première page |
| Champs manifestement faux | aucun : le moteur préfère ne rien proposer |

C'est le point important : **un champ douteux est laissé vide et signalé plutôt
que rempli au hasard**, et le contrôle visuel présente alors la page, les
lectures possibles, et le pointeur pour désigner la bonne zone. Une facture
scannée d'un émetteur inhabituel demandera quelques corrections ; elle ne
produira pas de ligne fausse passée inaperçue.

Deux réglages pèsent lourd sur des scans :

- **Finesse de numérisation** à 300 ppp (valeur par défaut). À 150 ppp, les
  numéros de compteur en petits caractères deviennent illisibles.
- **Pages examinées** : le détail de l'abonnement est fréquemment au verso.
  Trois pages est un bon compromis ; passez à cinq si vos factures sont longues.

## Confidentialité

- Aucun modèle de langage, aucune intelligence artificielle générative.
- Aucune clé d'API, aucun compte, aucun abonnement.
- Les factures ne sont jamais transmises : elles sont lues en mémoire.
- Un compteur, dans l'en-tête, recense **toute** requête réseau émise par la
  page. Il reste à zéro tant que l'annuaire postal n'est pas sollicité.
- Le seul appel réseau possible est la consultation de la
  [Base Adresse Nationale](https://adresse.data.gouv.fr/) — un annuaire postal
  public, sans clé ni compte, qui sert à développer les abréviations (`ALL` →
  `ALLÉE`). Il est **désactivé par défaut** et se coupe dans les réglages.
- La base de travail vit dans le stockage local du navigateur. Vider le cache
  l'efface : exportez-la régulièrement depuis l'onglet Export.

## Reconstruire le fichier

Le fichier livré est engendré à partir de `src/app.html`, dans lequel sont
injectés les moteurs compressés.

```sh
python3 outils/construire.py
```

Le script télécharge pdf.js, Tesseract, son cœur WebAssembly, le dictionnaire
français et les polices de secours de pdf.js, les compresse, et écrit
`Extracteur_Contrats_Eau.html`. Les téléchargements sont conservés dans
`.moteurs/` pour les reconstructions suivantes.

| Composant | Rôle |
|---|---|
| pdf.js 3.11.174 | lecture des PDF, couche texte, rendu des pages |
| tesseract.js 5.1.1 | reconnaissance optique |
| tesseract.js-core 5.1.1 | moteur WebAssembly |
| `fra.traineddata` (4.0.0 fast) | dictionnaire français |
| polices standard de pdf.js | rendu fidèle des PDF sans polices embarquées |

Un détail technique mérite d'être connu de qui reprendra ce code : ouverte
depuis un `file://`, une page ne peut pas donner à un *worker* né d'une URL
`blob:` l'accès à ses propres ressources — le *worker* hérite d'une origine
opaque. Tout ce dont le moteur optique a besoin est donc écrit à l'intérieur
même de sa source, et son `fetch` est détourné vers le dictionnaire embarqué.
