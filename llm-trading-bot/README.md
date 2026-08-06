# LLM Trading Bot

Bot de trading autonome où **un modèle de langage (Gemini) produit les prévisions
d'investissement**, en croisant analyse technique (RSI, tendance, ATR) et analyse fondamentale
(actualités financières récentes, entités anonymisées). Capital de départ : **100 $** sur un compte
paper Alpaca réel.

Le projet n'a pas pour but de gagner de l'argent — 100 $ ne le permettent pas. Il a pour but de
**mesurer** si un LLM possède un avantage directionnel, avec un instrument qui puisse répondre
« non » de façon crédible.

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
                            Alpaca Market Data            Gemini API (LLM)         Finnhub / NewsAPI / RSS
                            (bougies + cotations)         (le cerveau)             (actualités)
                            Yahoo = secours
```

Le front-end ne connaît **aucune clé** : il n'appelle que des routes de lecture du back-end.

### Le cycle de décision

```
   ┌─ aux heures de CRON_SCHEDULE, marché ouvert ────────────────────────────┐
   │                                                                         │
   │  1. Résolution du carnet fantôme (décisions dont l'horizon est échu)    │
   │  2. Valorisation du portefeuille aux prix courants                      │
   │  3. Coupe-circuit MENSUEL (perte > 15 % sur le mois → plus aucun achat) │
   │  4. Stops ATR mécaniques (exécutés SANS consulter le LLM)               │
   │  5. Pour chaque actif :                                                 │
   │        bougies OHLCV ──► 3 indicateurs orthogonaux ─┐                   │
   │        actualités filtrées puis ANONYMISÉES ────────┤                   │
   │        portefeuille + budget de risque ─────────────┼──► PROMPT ──► IA  │
   │                                                     │              │    │
   │        prévision : 100 scénarios répartis ◄─────────────────────────┘   │
   │              │                                                          │
   │              ├─► seuil appliqué ICI → action + taille déduites          │
   │              ├─► validation par le gestionnaire de risque               │
   │              ├─► exécution via le BrokerAdapter (fill ou annulation)    │
   │              └─► enregistrement au carnet fantôme, exécutée ou non      │
   │  6. Journalisation complète (prévision, pré-mortem, sources)            │
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
│   ├── test/                         # 129 tests : unitaires, mesure, prompt, rotation de clés
│   └── src/
│       ├── server.js                 # bootstrap Express + planificateur
│       ├── config.js                 # lecture/validation des variables d'environnement
│       ├── logger.js                 # logs + tampon circulaire exposé à l'API
│       │
│       ├── data/                     # ─── COMPOSANT 1 : Market Data Fetcher ───
│       │   ├── marketData.js         # orchestration, cache, horloge officielle du broker
│       │   ├── indicators.js         # RSI, MACD, EMA, SMA, Bollinger, ATR
│       │   ├── calendar.js           # phase intra-mensuelle (PreTOM / TOM)
│       │   ├── spreadLog.js          # mesure du coût de transaction réel
│       │   ├── executionQuality.js   # prix de fill vs cotation à la soumission
│       │   └── providers/
│       │       ├── alpaca.js         # source principale (même fournisseur que l'exécution)
│       │       └── yahoo.js          # source de secours (gratuite, sans clé)
│       │
│       ├── news/                     # ─── MODULE : Analyse fondamentale ───
│       │   ├── newsService.js        # bascule entre fournisseurs, dédoublonnage, tri
│       │   └── providers/
│       │       ├── finnhub.js        # actualités société (clé gratuite)
│       │       ├── newsapi.js        # presse généraliste (clé gratuite)
│       │       └── rss.js            # Yahoo + Google News — filet sans clé
│       │
│       ├── llm/                      # ─── COMPOSANT 2 : L'Agent LLM (le cerveau) ───
│       │   ├── agent.js              # validation, ancrage des preuves, grille booléenne
│       │   ├── promptTemplates.js    # schéma ordonné : evidence → checks → pré-mortem → prévision
│       │   ├── anonymize.js          # protocole Glasserman & Lin en 4 couches
│       │   ├── entities.js           # graphe d'entités (dirigeants, produits, filiales)
│       │   ├── keyPool.js            # pool multi-clés : rotation, quotas, capacité
│       │   └── providers/
│       │       ├── gemini.js         # génération structurée + bascule de clé sur 429
│       │       └── heuristic.js      # moteur de secours déterministe, sans réseau
│       │
│       ├── brokers/                  # ─── COMPOSANT 3 : Broker Interface (Adapter) ───
│       │   ├── BrokerAdapter.js      # contrat abstrait
│       │   ├── PaperBrokerAdapter.js # portefeuille fictif complet (frais, slippage, P&L)
│       │   ├── AlpacaBrokerAdapter.js# compte paper Alpaca réel (ordres notionnels, annulation à 20 s)
│       │   └── index.js              # fabrique — le seul endroit qui choisit paper/réel
│       │
│       ├── core/
│       │   ├── engine.js             # orchestration d'un cycle complet
│       │   ├── riskManager.js        # taille, stops ATR, coupe-circuit mensuel
│       │   ├── shadowBook.js         # ─── L'INSTRUMENT DE MESURE ───
│       │   ├── sprt.js               # verdict séquentiel (Wald, Student-t, échelle expansive)
│       │   ├── calibration.js        # les fréquences annoncées tiennent-elles ? (Brier, Murphy)
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

> 💡 Le palier gratuit de `gemini-3.5-flash-lite` autorise **500 requêtes par jour et par clé**
> (15 par minute). Le bot gère un **pool de plusieurs clés** et bascule automatiquement de l'une à
> l'autre : 3 comptes = 1 500 appels/jour = 150 cycles/jour sur 10 actifs. Le plafond réel est
> **recalibré tout seul** à partir du corps d'une réponse 429, seule source qui l'expose.
> `npm run keys` affiche ta capacité et le `CRON_SCHEDULE` correspondant.
> Voir [le détail](backend/README.md#pool-de-clés-gemini--plusieurs-comptes-gratuits-cumulés).

```bash
npm run cycle
```

Cette commande exécute **un seul cycle** et affiche le résumé : c'est le meilleur test de bout en
bout (données de marché → actualités → décision Gemini → validation du risque). Ensuite :

```bash
npm start
```

L'API écoute sur `http://localhost:8080` et le planificateur lance un cycle aux heures définies par `CRON_SCHEDULE`.

### Front-end

Ouvre `frontend/index.html`, clique sur **Réglages** et saisis l'URL de ton back-end.
Elle est mémorisée dans le navigateur (`localStorage`) — aucune configuration au build.

---

## 4. Les garde-fous

**Le modèle ne décide pas — il prévoit.** On ne lui demande pas quoi faire, mais de répartir
100 scénarios entre trois issues : l'actif bat son indice de référence, il fait moins bien, ou
l'écart reste sous 0,5 %. Le passage à l'acte est décidé par le code, à partir de seuils explicites.

Ce déplacement n'est pas cosmétique. Un modèle entraîné par RLHF penche vers la réponse prudente
quand on lui demande d'**agir** — un réflexe appris, pas une analyse. En lui demandant seulement de
**prévoir**, on récupère son jugement sans hériter du biais ; et le seuil devient un paramètre
visible et réglable au lieu d'un trait de caractère caché. Le dashboard mesure d'ailleurs l'écart
entre ce que le modèle recommanderait et ce que sa propre prévision implique.

| Garde-fou | Variable | Défaut | Effet |
|---|---|---|---|
| Écart minimal | `MIN_EDGE` | 0,20 | Il faut 60/40, pas 51/49 : en dessous, indiscernable du bruit |
| Probabilité minimale | `MIN_UP_PROBABILITY` | 0,40 | Écarte un 40/20/40 où l'indécision domine |
| Exposition par position | `MAX_POSITION_PCT` | 35 % | Plafonne le notionnel d'une ligne |
| Positions simultanées | `MAX_POSITIONS` | 3 | Bloque l'ouverture d'une 4ᵉ ligne |
| Ordre minimum | `MIN_ORDER_VALUE` | 5 $ | Marge au-dessus du plancher technique d'Alpaca |
| Stop | `STOP_ATR_MULTIPLE` | 4 × ATR | Dimensionné sur la volatilité, borné 8-20 % |
| Take-profit | — | **aucun** | Un objectif fixe tronque la queue droite de la distribution |
| Coupe-circuit | `MAX_MONTHLY_LOSS_PCT` | 15 % **/ mois** | Un seuil journalier serait sous le bruit |
| Grille de critères | — | 3 / 4 | Verrou indépendant du seuil : sans majorité, pas d'ouverture |
| Vente à découvert | — | interdite | Bloquée par le bot **et** par Alpaca |

La taille de position est elle aussi déduite de l'écart de probabilité — un quart du budget au
seuil, la totalité sur une prévision unanime — et non demandée au modèle. Deux nombres arbitraires
en moins à sa charge.

> ⚠️ Les probabilités annoncées **ne sont jamais retouchées** par les garde-fous. Quand un contrôle
> échoue, l'action est bloquée mais la prévision est enregistrée telle quelle. La raboter
> reviendrait à mesurer nos propres corrections au lieu du modèle — et fabriquerait une calibration
> artificiellement bonne, puisqu'on écraserait précisément les valeurs suspectes.

S'y ajoutent les protections logicielles : réponse illisible → `HOLD`, ancrage des preuves
défaillant → décision annulée, API en panne → fournisseur de secours, ordre non exécuté en 20 s →
annulé, cycle déjà en cours → déclenchement ignoré.

**Principe directeur : toute panne mène à l'inaction, jamais à une action imprévue.**

## 5. L'instrument de mesure

Le bot ne se contente pas de trader : il produit la seule évaluation non biaisée possible d'un LLM
en finance. Les modèles ayant mémorisé les prix historiques, tout backtest antérieur à leur date de
coupure est corrompu — le modèle récite l'histoire au lieu de la prédire. Seules des décisions
prises en temps réel, avant que le résultat n'existe, échappent à cette contamination.

| Module | Rôle |
|---|---|
| **Carnet fantôme** | Score **chaque** décision (exécutée ou non) à +1/+3/+7 jours, en rendement excédentaire vs SPY |
| **SPRT tronqué** | Verdict séquentiel `CONTINUER` / `ARRÊTER` / `VALIDÉ` / `TRONQUÉ`, densités Student-t |
| **Calibration** | Les fréquences annoncées correspondent-elles aux constatées ? (Brier, ECE, décomposition de Murphy) |
| **Journal des spreads** | Mesure le seul coût de transaction réel chez Alpaca |
| **Qualité d'exécution** | Compare le prix de fill à la cotation au moment de la soumission |

Le carnet fantôme est ce qui rend le SPRT exploitable : ~1 000 observations indépendantes par an au
lieu de ~70 allers-retours, soit un verdict de futilité en **~10 semaines** au lieu de ~3 ans.

### Deux propriétés du test qui ne se voient pas mais qui décident de tout

**L'échelle est estimée de façon expansive.** À chaque pas, l'écart-type n'est calculé que sur les
observations *antérieures*. Les bornes de Wald ne sont valides que si `exp(LLR)` est une martingale
sous H0, ce qui exige des paramètres mesurables par rapport au passé seul. Une version qui calcule
σ sur la série entière puis parcourt les pas utilise du futur à chaque incrément : le contrôle
d'erreur annoncé ne veut alors plus rien dire. Le prix payé est une période de calibration initiale
(20 observations) qui ne produit aucune preuve — bien préférable à une garantie fausse.

**Le test s'arrête pour de bon à sa troncature.** Passé `maxSamples` sans franchissement, le verdict
est `TRONQUÉ` et les observations suivantes ne sont pas lues. Continuer à regarder jusqu'à ce que le
résultat plaise est exactement l'arrêt optionnel que le SPRT existe pour interdire.

### Calibration : deux échecs à ne pas confondre

Le SPRT dit s'il y a un avantage directionnel. Il ne dit rien sur la qualité du nombre que le
modèle place à côté de sa prévision — or c'est ce nombre qui dimensionne les positions.

- **Mal calibrée** — annonce 0,8, réalise 0,55. Le classement est bon, l'échelle est fausse.
  Réparable par recalibration.
- **Non informative** — annonce 0,8 sur les bonnes comme sur les mauvaises. Pas réparable :
  il faut cesser de s'en servir pour dimensionner.

La décomposition de Murphy (`Brier = fiabilité − résolution + incertitude`) les sépare. On expose
surtout la **pente de calibration** : le biais moyen s'annule quand la surconfiance est symétrique
et afficherait « équilibré » sur un modèle qui exagère de 10 points à ses deux extrémités.
Une pente de 0,64 signifie « les écarts annoncés devraient être divisés par 1,6 » — un diagnostic
accompagné de son correctif.

---

## 5. Documentation détaillée

- [`backend/README.md`](backend/README.md) — configuration, pool de clés, API REST, hébergement 24/7, passage au trading réel
- [`frontend/README.md`](frontend/README.md) — déploiement Netlify, personnalisation
- [`docs/prompts-deep-research.md`](docs/prompts-deep-research.md) — 8 prompts Deep Research pour chercher des edges et valider la stratégie
