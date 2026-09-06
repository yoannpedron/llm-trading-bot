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

## Performance

- Parsing des 300k entrées dans un Web Worker (UI jamais bloquée).
- Carrousels et grilles virtualisés : ~40 à 160 cartes dans le DOM quel que soit le volume.
- Jaquettes du provider utilisées dans les grilles ; TMDB n'est appelé que pour l'item focus / la page détails.
- Cache TMDB en IndexedDB, un titre n'est jamais refetché.

## Proxy

En dev, `vite.config.ts` proxifie `/xtream/<host>/…` vers le serveur Xtream (évite le CORS). En prod, servir `dist/` derrière un reverse proxy équivalent, ou définir `VITE_XTREAM_DIRECT=1` si le serveur autorise le CORS.
