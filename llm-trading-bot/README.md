# LLM Trading Bot

Bot de trading autonome où **un modèle de langage (Gemini) prend les décisions d'investissement**,
en croisant analyse technique (RSI, MACD, Bollinger, ATR…) et analyse fondamentale (actualités
financières récentes). Capital de départ : **100 €**, en paper trading.

> ⚠️ **Projet pédagogique.** Les décisions sont produites par un LLM et ne constituent pas un
> conseil en investissement. Le mode par défaut est la simulation : aucun argent réel n'est engagé.
> Ne passez en réel qu'après plusieurs mois de simulation concluante, et jamais avec un capital
> que vous ne pouvez pas perdre.

---

## 1. Architecture

Deux dépôts **séparés** : les clés d'API et la logique métier ne quittent jamais le serveur.

```
┌──────────────────────┐        HTTPS (GET only)        ┌────────────────────────┐
│  FRONT-END (Netlify) │ ─────────────────────────────► │  BACK-END (Render/VPS) │
│  Dashboard statique  │ ◄───────── JSON ────────────── │  Node.js + Express     │
│  lecture seule       │                                │  cron 24/7             │
└──────────────────────┘                                └───────────┬────────────┘
                                                                    │
                                    ┌───────────────────────────────┼───────────────────────┐
                                    ▼                               ▼                       ▼
                            Yahoo Finance API             Gemini API (LLM)         Finnhub / NewsAPI / RSS
                            (bougies OHLCV)               (le cerveau)             (actualités)
```

Le front-end ne connaît **aucune clé** : il n'appelle que des routes de lecture du back-end.

### Le cycle de décision

```
   ┌─ toutes les 30 min (cron) ──────────────────────────────────────────────┐
   │                                                                         │
   │  1. Valorisation du portefeuille aux prix courants                      │
   │  2. Coupe-circuit journalier (perte > 10 % → plus aucun achat)          │
   │  3. Stops & objectifs mécaniques (exécutés SANS consulter le LLM)       │
   │  4. Pour chaque actif :                                                 │
   │        bougies OHLCV ──► indicateurs techniques ─┐                      │
   │        actualités (5-10 articles) ───────────────┤                      │
   │        portefeuille + budget de risque ──────────┼──► PROMPT ──► Gemini │
   │                                                  │                 │    │
   │        décision JSON stricte ◄────────────────────────────────────┘     │
   │              │                                                          │
   │              ├─► validation par le gestionnaire de risque               │
   │              └─► exécution via le BrokerAdapter (paper ou réel)         │
   │  5. Journalisation complète (décision, raisonnement, sources)           │
   └─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Arborescence

```
llm-trading-bot/
│
├── backend/                          # Dépôt 1 — moteur privé, tourne 24/7
│   ├── package.json
│   ├── .env.example                  # modèle de configuration (à copier en .env)
│   ├── Dockerfile                    # image de production
│   ├── render.yaml                   # déploiement Render en un clic
│   ├── test/
│   │   └── unit.test.js              # 36 tests (indicateurs, broker, risque, LLM)
│   └── src/
│       ├── server.js                 # bootstrap Express + planificateur
│       ├── config.js                 # lecture/validation des variables d'environnement
│       ├── logger.js                 # logs + tampon circulaire exposé à l'API
│       │
│       ├── data/                     # ─── COMPOSANT 1 : Market Data Fetcher ───
│       │   ├── marketData.js         # orchestration, cache, conversion de devise, horaires
│       │   ├── indicators.js         # RSI, MACD, EMA, SMA, Bollinger, ATR
│       │   └── providers/
│       │       ├── yahoo.js          # source principale (gratuite, sans clé)
│       │       └── alpaca.js         # source de secours (clé gratuite)
│       │
│       ├── news/                     # ─── MODULE : Analyse fondamentale ───
│       │   ├── newsService.js        # bascule entre fournisseurs, dédoublonnage, tri
│       │   └── providers/
│       │       ├── finnhub.js        # actualités société (clé gratuite)
│       │       ├── newsapi.js        # presse généraliste (clé gratuite)
│       │       └── rss.js            # Yahoo + Google News — filet sans clé
│       │
│       ├── llm/                      # ─── COMPOSANT 2 : L'Agent LLM (le cerveau) ───
│       │   ├── agent.js              # appel, validation et normalisation des décisions
│       │   ├── promptTemplates.js    # prompt système + injection de contexte + schéma JSON
│       │   ├── keyPool.js            # pool multi-clés : rotation, quotas, capacité
│       │   └── providers/
│       │       ├── gemini.js         # génération structurée + bascule de clé sur 429
│       │       └── heuristic.js      # moteur de secours déterministe, sans réseau
│       │
│       ├── brokers/                  # ─── COMPOSANT 3 : Broker Interface (Adapter) ───
│       │   ├── BrokerAdapter.js      # contrat abstrait
│       │   ├── PaperBrokerAdapter.js # portefeuille fictif complet (frais, slippage, P&L)
│       │   ├── AlpacaBrokerAdapter.js# squelette trading réel (envoi d'ordres verrouillé)
│       │   └── index.js              # fabrique — le seul endroit qui choisit paper/réel
│       │
│       ├── core/
│       │   ├── engine.js             # orchestration d'un cycle complet
│       │   ├── riskManager.js        # taille des positions, stops, coupe-circuit
│       │   ├── journal.js            # journal de bord de l'IA
│       │   └── scheduler.js          # boucle temporelle (node-cron)
│       │
│       ├── storage/
│       │   └── JsonStore.js          # persistance fichier, écriture atomique
│       │
│       ├── api/
│       │   └── routes.js             # API REST consommée par le dashboard
│       │
│       └── scripts/
│           ├── runOnce.js            # un seul cycle puis sortie (cron externe / test)
│           └── keys.js               # CLI de gestion du pool de clés
│
└── frontend/                         # Dépôt 2 — public, statique, lecture seule
    ├── index.html
    ├── netlify.toml                  # en-têtes de sécurité + fallback SPA
    └── assets/
        ├── app.js                    # récupération API + rendu (zéro dépendance)
        └── styles.css                # thème clair/sombre automatique
```

---

## 3. Démarrage rapide

### Back-end

```bash
cd backend && npm install && cp .env.example .env
```

Renseigne au minimum `GEMINI_API_KEY` et `ADMIN_TOKEN` dans `.env`, puis :

> 💡 Le palier gratuit de Gemini est limité à **20 requêtes par jour et par compte Google**. Le bot
> gère un **pool de plusieurs clés** et bascule automatiquement de l'une à l'autre : 4 comptes
> gratuits = 80 appels/jour = 26 cycles/jour sur 3 actifs. `npm run keys` affiche ta capacité et le
> `CRON_SCHEDULE` correspondant. Voir [le détail](backend/README.md#pool-de-clés-gemini--plusieurs-comptes-gratuits-cumulés).

```bash
npm run cycle
```

Cette commande exécute **un seul cycle** et affiche le résumé : c'est le meilleur test de bout en
bout (données de marché → actualités → décision Gemini → validation du risque). Ensuite :

```bash
npm start
```

L'API écoute sur `http://localhost:8080` et le planificateur lance un cycle toutes les 30 minutes.

### Front-end

Ouvre `frontend/index.html`, clique sur **Réglages** et saisis l'URL de ton back-end.
Elle est mémorisée dans le navigateur (`localStorage`) — aucune configuration au build.

---

## 4. Les garde-fous

Le LLM propose ; le gestionnaire de risque dispose. Aucune décision du modèle ne peut contourner :

| Garde-fou | Variable | Défaut | Effet |
|---|---|---|---|
| Exposition par position | `MAX_POSITION_PCT` | 35 % | Plafonne le notionnel d'une ligne |
| Positions simultanées | `MAX_POSITIONS` | 3 | Bloque l'ouverture d'une 4ᵉ ligne |
| Ordre minimum | `MIN_ORDER_VALUE` | 5 € | Évite les micro-lignes rongées par les frais |
| Stop-loss | `STOP_LOSS_PCT` | 5 % | Sortie mécanique, sans consulter le LLM |
| Take-profit | `TAKE_PROFIT_PCT` | 12 % | Sortie mécanique, sans consulter le LLM |
| Coupe-circuit | `MAX_DAILY_LOSS_PCT` | 10 % | Interdit tout achat jusqu'au lendemain |
| Confiance minimale | — | 0,35 | Un achat peu convaincu est rejeté |
| Vente à découvert | — | interdite | `SELL` n'est possible que sur une position détenue |

À quoi s'ajoutent les protections logicielles : réponse LLM illisible → `HOLD`, API en panne →
bascule sur un fournisseur de secours, cycle déjà en cours → déclenchement ignoré.

---

## 5. Documentation détaillée

- [`backend/README.md`](backend/README.md) — configuration, pool de clés, API REST, hébergement 24/7, passage au trading réel
- [`frontend/README.md`](frontend/README.md) — déploiement Netlify, personnalisation
- [`docs/prompts-deep-research.md`](docs/prompts-deep-research.md) — 8 prompts Deep Research pour chercher des edges et valider la stratégie
