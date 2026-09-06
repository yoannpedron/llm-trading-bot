# LUMEN — lecteur IPTV (Xtream Codes) façon Netflix

React 19 + Vite + TypeScript. Catalogue Xtream (films / séries / live) parsé dans un Web Worker, enrichi par TMDB, affiché avec des listes virtualisées.

## Démarrage

```bash
cp .env.example .env      # renseigner VITE_TMDB_API_KEY
npm install
npm run dev               # http://localhost:5173
```

Sans identifiants Xtream l'app tourne en **mode démo** sur un échantillon réel (3 000 films, 500 séries, 800 chaînes) embarqué dans `src/api/mock/`. Le bouton « Mode démo / Connecté » en haut à droite ouvre le formulaire de connexion pour charger le catalogue complet d'un serveur (300k+ entrées).

```bash
npm test                  # parseur + mapping TMDB (vitest)
npm run build             # tsc + vite build -> dist/
npm run lint
```

## Fonctionnalités

- **Accueil piloté par TMDB, croisé avec le serveur** : Top 10 films et séries de la semaine, dernières sorties cinéma disponibles, ajouts récents du serveur classés par popularité, 4K disponibles, sagas complètes (page collection avec films présents / absents), chefs-d'œuvre, pépites, réalisateurs, genres. Chaque titre n'apparaît que dans une seule rangée.
- **Profil international** : langue d'interface (FR, EN, AR avec RTL, DE, ES, PL, TR), langues de contenu par ordre de préférence (détermine la version audio par défaut et fusionne les doublons inter-langues), pays pour les sorties cinéma, hubs par cinématographie (Bollywood, Dizi, K-Drama, Anime, arabe, latino…). Métadonnées TMDB dans la langue de l'interface.
- **Fiche unique par film** avec sélecteur de version (FR, EN, AR, 4K, sous-titré…).
- **Live TV par pays et thème**, guide des programmes (EPG Xtream) sur le lecteur, **agenda sport** construit en parsant les flux événementiels datés (`NEXT | ROMA - ATALANTA | Sat 05 Sep 18:35 GMT`).
- **Match Center** : calendriers et scores en direct ESPN + TheSportsDB (sans clé), rapprochement flou de chaque flux PPV du serveur avec son match, carte par match avec logos, score, minute, meilleur flux selon le profil et bascule automatique en cas d'échec, favoris équipes et compétitions, rappels, multi-match jusqu'à 4 flux, chaînes sport du pays avec EPG. Direct et à venir uniquement.
- **Accueil dynamique** : rangées du jour (tendances, sorties, ajouts, épisodes), rotation quotidienne (genre, décennie, pays, saga), personnalisation depuis l'historique (parce que tu as regardé, suite de saga, acteurs et réalisateurs, tes séries). Aucune rangée statique.
- **Paramètres** : comptes Xtream multiples avec état du créneau, langues, rangées masquées/épinglées/renommées/réordonnées, masquage par langue ou catégorie, catalogue, cache, export/import.
- **Hero avec bande-annonce YouTube** muette, Ma liste, reprise de lecture, "Continuer à regarder", épisode suivant automatique, mode enfant.

## Architecture

```
src/
├── api/
│   ├── xtream.ts        client player_api.php + URLs de lecture (live m3u8, movie, series)
│   ├── tmdb.ts          client TMDB : 1 requête/titre (append_to_response), limiteur de concurrence, cache IndexedDB
│   ├── tmdbLists.ts     rangées officielles et croisées (listes TMDB ∩ catalogue, dédoublonnage strict, sagas)
│   └── mock/            échantillon de catalogue réel (adulte exclu)
├── parser/
│   ├── regex.ts         nettoyage des titres (préfixe langue, année, SxxExx, N. Bölüm, qualité, bruit)
│   ├── live.ts          pays / thème des catégories live, événements sportifs datés
│   ├── classify.ts      routage movie / series / live
│   ├── normalize.ts     Xtream -> MediaItem unifié
│   └── index.ts         parseCatalog(): items + index par catégorie
├── workers/parser.worker.ts   parsing hors thread principal
├── store/               zustand : session, catalogue + index TMDB, profil (langues, région, enfant), ma liste, progression, UI
├── hooks/useEnrich.ts   react-query -> TMDB
├── components/          Backdrop (crossfade), Hero (logo TMDB), Carousel & VirtualGrid (TanStack Virtual), Player (hls.js)
└── pages/               Home, Browse (genres TMDB ou catégories serveur), Live (pays × thème), Sport, Collection, Details, Watch, Search, MyList, Profile, Login
```

## Stratégie de parsing

| Entrée | Sortie |
|---|---|
| `EN - The Postman (1997) KEVIN COSTNER` | title `The Postman`, year 1997, lang EN, tags [KEVIN COSTNER] |
| `4K - The New Pope (2020) (IT)` | title `The New Pope`, lang 4K, tags [IT] |
| `Sekizinci.Aile.S01E04.1080p.WEB-DL` | title `Sekizinci Aile`, S1 E4, quality 1080P -> reclassé **série** |
| `Kızılcık Şerbeti 58. Bölüm @showtv` | title `Kızılcık Şerbeti`, épisode 58 -> reclassé **série** |
| `VO| GAMETOON ᴴᴰ` | title `GAMETOON`, quality HD |
| `[X][…]` / `is_adult=1` | exclu du catalogue |

Le routage utilise en priorité les trois endpoints Xtream (`get_vod_streams`, `get_series`, `get_live_streams`). Les regex servent de filet de sécurité pour les épisodes rangés en VOD.

## Enrichissement TMDB

Priorité au `tmdb` fourni par le provider (85 % des films, 88 % des séries du provider testé), sinon recherche `searchTitle + year`. Une seule requête par titre :
`/movie/{id}?append_to_response=credits,images,similar,videos&include_image_language=fr,en,null` → jaquette, backdrop, logo détouré (fr > en > neutre), synopsis, casting, réalisateur, genres, similaires, bande-annonce. Les « similaires » sont remappés vers les titres présents dans le catalogue du provider.

## Performance mesurée (catalogue réel de 296 000 entrées, build de production, Chromium)

| Phase | Mesure |
|---|---|
| Premier démarrage, interface utilisable (chaînes + séries) | 6 à 9 s |
| Premier démarrage, catalogue complet | 17 à 25 s, borné par le serveur qui met 13 à 20 s à envoyer 86 Mo de films non compressés |
| Redémarrage depuis l'instantané local | 0,8 s |
| Mémoire JS du fil d'interface, catalogue complet chargé | 106 Mo (246 Mo avant la v2 des colonnes) |
| Construction de la vue catalogue | 65 ms |
| Index TMDB (250 000 clés) | 140 ms |
| Recherche sur 296 000 titres | 12 ms de calcul, 150 ms affichés |
| Mise à jour du catalogue | en arrière-plan, interface utilisable pendant toute la durée |

Les données ne résident pas sous forme d'objets : le catalogue est un jeu de colonnes (typed arrays pour les nombres, UTF-8 + offsets pour le texte) stocké tel quel dans IndexedDB et transféré sans copie du worker vers l'interface. Une entrée n'est décodée que lorsque l'interface la touche (quelques centaines à la fois), et synopsis / casting / réalisateur / genres restent dans un second enregistrement lu à la demande par le worker, jamais chargés dans le fil d'interface. Les préfixes d'URL d'affiches sont dédupliqués par dictionnaire, la recherche s'exécute directement sur les octets, l'index TMDB est trois typed arrays.

## Anciens appareils : palier « léger »

Détection automatique (RAM ≤ 2 Go, ≤ 2 cœurs, économiseur de données, réseau 2G, animations réduites) avec réglage manuel dans Paramètres › Données › Affichage. Le palier léger coupe les bandes-annonces, le flou, le zoom du fond et les transitions, charge des affiches TMDB en w342 et des fonds en w780, et réduit le sur-rendu des grilles.

## Un catalogue par personne : pays → langues

Au premier lancement l'application demande le pays (40 marchés). Le pays règle la langue de l'interface, les langues du contenu dans l'ordre de préférence (Suisse → DE, FR, IT ; Belgique → FR, NL ; Canada → EN, QFR, FR ; Inde → HI, EN, TA, TE, ML…) et la région des sorties cinéma. Les langues proposées sont celles que le serveur possède réellement, avec le nombre de titres ; l'utilisateur en ajoute ou en retire. Tout est modifiable dans Paramètres › Langues.

Détection de la langue d'un titre, en cascade : préfixe du titre (`FR|`, `[DE]`…) → préfixe de la catégorie serveur (`|TR| DIZI`) → non identifiée. Une soixantaine de codes et alias sont reconnus (`ENG`, `EXYU`, `SCA`, `IND`, `LAT`…) ; les préfixes de plateforme (`NF|`, `4K|`) deviennent des tags, jamais une langue. Sur le provider testé : 87 % des films portent un préfixe de langue sur le titre, la catégorie en résout une partie du reste, les titres restants sont affichables ou non par un réglage.

Navigation Films / Séries : genres TMDB uniquement, sur le catalogue du spectateur. Les catégories du provider ne sont plus dans la navigation ; elles s'activent ou se désactivent dans Paramètres › Catégories. Une entrée « Autres titres » regroupe les titres sans fiche TMDB (réglage). La recherche présente d'abord les résultats dans les langues du profil, les autres langues repliées dessous.

## Pages dynamiques par genre et par catégorie

Chaque page (Tout, genre TMDB, autres titres, catégorie serveur sans clé TMDB) est construite depuis les données du provider : ajouts récents, mieux notés (top 10), sorties de l'année et de l'année précédente, décennies réellement couvertes, 4K, versions par langue. Une rangée n'existe que si le provider a au moins 8 titres pour elle, et la page passe en simple grille sous 24 titres : le même code produit deux rangées chez un petit provider et douze chez un gros. Les rangées de l'accueil obéissent à la même règle (5 titres minimum pour un top 10, 6 pour une rangée TMDB).

## Proxy

En dev, `vite.config.ts` proxifie `/xtream/<host>/…` vers le serveur Xtream (évite le CORS). En prod, servir `dist/` derrière un reverse proxy équivalent, ou définir `VITE_XTREAM_DIRECT=1` si le serveur autorise le CORS.
