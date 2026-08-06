# Back-end — moteur de trading

Node.js 20+ / Express. Aucune base de données à installer : l'état est persisté dans des fichiers
JSON (écriture atomique). Zéro dépendance native, donc déployable partout.

## Installation

```bash
npm install && cp .env.example .env
```

## Commandes

```bash
npm start                        # serveur API + planificateur cron (production)
npm run dev                      # idem avec rechargement à chaud
npm run cycle                    # un seul cycle puis sortie (test de bout en bout / cron externe)
npm test                         # 49 tests unitaires, aucun appel réseau

npm run keys                     # état du pool de clés + capacité + cron conseillé
npm run keys:add -- <clé> [nom]  # ajoute une clé Gemini (prise en compte immédiatement)
npm run keys:remove -- <id>      # retire une clé
```

---

## Configuration

Toutes les variables sont documentées dans [`.env.example`](.env.example). Les essentielles :

| Variable | Défaut | Rôle |
|---|---|---|
| `GEMINI_API_KEYS` | — | Clés du LLM, séparées par des virgules. Pool vide → moteur heuristique. |
| `LLM_CALLS_PER_KEY_PER_DAY` | `20` | Quota journalier **par clé**. La capacité totale vaut nb de clés × cette valeur. |
| `ADMIN_TOKEN` | — | Protège les routes d'écriture. **Absent → routes désactivées.** |
| `SYMBOLS` | `TSLA,AAPL,MSFT` | Univers suivi (tickers Yahoo : `BTC-USD`, `EURUSD=X` acceptés). |
| `CRON_SCHEDULE` | `*/30 * * * *` | Fréquence des cycles. |
| `INITIAL_CAPITAL` | `100` | Capital de départ, en `BASE_CURRENCY`. |
| `BROKER` | `paper` | `paper` (simulation) ou `alpaca` (réel, verrouillé). |
| `LLM_THINKING_BUDGET` | `0` | Raisonnement interne de Gemini 2.5. `0` = réponse directe. |
| `LLM_COOLDOWN_MS` | `8000` | Pause entre deux actifs : respecte aussi la limite *par minute*. |

## Pool de clés Gemini — plusieurs comptes gratuits cumulés

Le palier **gratuit** de `gemini-2.5-flash` est plafonné à **20 requêtes par jour et par projet
Google** (quota `GenerateRequestsPerDayPerProjectPerModel-FreeTier`). Ce plafond est *par compte* :
posséder plusieurs comptes gratuits multiplie donc la capacité réelle du bot.

Le bot gère un **pool de clés** qui :
- sélectionne à chaque appel la clé la moins consommée ;
- bascule instantanément sur la suivante dès qu'une clé renvoie 429 (ou 400/403 si elle est
  invalide), sans perdre le cycle en cours ;
- remet les compteurs à zéro **à minuit heure du Pacifique**, le fuseau où Google réinitialise ;
- retombe sur le moteur heuristique seulement quand *toutes* les clés sont à sec.

### Ajouter des clés

Trois méthodes, combinables.

**Depuis le dashboard** (le plus simple) : Réglages → jeton administrateur, puis la carte
**Clés API Gemini** permet d'ajouter, tester et retirer les clés, avec calcul immédiat de la
nouvelle capacité.

Par le fichier `.env` (source de vérité, nécessite un redémarrage) :

```bash
GEMINI_API_KEYS=AIzaSyAAA...,AIzaSyBBB...,AIzaSyCCC...
```

Ou à chaud, sans redémarrer le serveur — les clés sont écrites dans `data/llm-keys.json` :

```bash
npm run keys:add -- AIzaSyDDD... "compte perso"
```

```bash
npm run keys
```

`npm run keys` affiche l'état complet du pool et **calcule directement le réglage à appliquer** :

```
── CAPACITÉ ─────────────────────────────────────────
  Clés dans le pool      : 4
  Quota par clé et jour  : 20
  Capacité totale/jour   : 80 appels
  Consommé aujourd'hui   : 12
  Restant                : 68
  Actifs suivis          : TSLA, AAPL, MSFT (3 appel(s)/cycle)
  → cycles possibles/jour: 26
  → CRON_SCHEDULE conseillé : 0 * * * *
```

Pour retirer une clé : `npm run keys:remove -- <id>` (l'id est affiché entre crochets par
`npm run keys`). Une clé venant de `.env` ne peut être retirée que du `.env`.

### La formule

```
capacité/jour = nombre de clés × LLM_CALLS_PER_KEY_PER_DAY
cycles/jour   = capacité/jour ÷ nombre d'actifs suivis
```

| Clés | Capacité/jour | Avec 3 actifs | Cron conseillé |
|---|---|---|---|
| 1 | 20 | 6 cycles/jour | `0 */4 * * *` |
| 2 | 40 | 13 cycles/jour | `0 */2 * * *` |
| 4 | 80 | 26 cycles/jour | `0 * * * *` |
| 8 | 160 | 53 cycles/jour | `*/30 * * * *` |
| 15 | 300 | 100 cycles/jour | `*/15 * * * *` |

Réduire `SYMBOLS` augmente mécaniquement le nombre de cycles possibles. Avec une clé payante
(« pay-as-you-go » dans Google AI Studio), mets `LLM_CALLS_PER_KEY_PER_DAY=0` : la limite disparaît.

La capacité et les cycles restants s'affichent en direct dans le dashboard et sur
`GET /api/capacity`.

### Gérer les clés depuis le dashboard

C'est la méthode la plus simple : renseigne l'`ADMIN_TOKEN` dans **Réglages**, et la carte
**Clés API Gemini** devient interactive — ajout, suppression, test, et calcul automatique de la
capacité. Voir [`frontend/README.md`](../frontend/README.md#gérer-les-clés-gemini-depuis-linterface).

### Gérer les clés par l'API

Réservé à l'admin ; la liste ne renvoie que des clés masquées, jamais le matériel complet.

```bash
curl -H "X-Admin-Token: $ADMIN_TOKEN" https://mon-bot.onrender.com/api/llm/keys
```

L'ajout **teste la clé auprès de Google avant de l'enregistrer** (via `GET /models`, qui ne
consomme pas de quota de génération) et distingue clé valide, quota déjà atteint, et clé refusée :

```bash
curl -X POST -H "X-Admin-Token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"AIzaSy...","label":"compte 5"}' https://mon-bot.onrender.com/api/llm/keys
```

```bash
curl -X POST -H "X-Admin-Token: $ADMIN_TOKEN" https://mon-bot.onrender.com/api/llm/keys/check
```

```bash
curl -X DELETE -H "X-Admin-Token: $ADMIN_TOKEN" https://mon-bot.onrender.com/api/llm/keys/<id>
```

### Sur le choix du modèle

`gemini-2.5-flash` suffit largement et coûte peu. `LLM_COOLDOWN_MS` espace les appels d'un même
cycle pour respecter aussi la limite *par minute*.

Si l'API Gemini tombe ou dépasse son quota, l'agent bascule automatiquement sur
`llm/providers/heuristic.js` — une stratégie déterministe MACD + RSI + sentiment lexical. Le bot ne
s'arrête jamais et le journal indique clairement `heuristic-v1` comme auteur de la décision.

---

## API REST

Lecture publique, écriture protégée par l'en-tête `X-Admin-Token`.

### Lecture

| Route | Description |
|---|---|
| `GET /api/health` | Sonde de santé (health check du PaaS). |
| `GET /api/dashboard` | **Agrégat** : compte, positions, ordres, courbe, journal, état. Une seule requête pour tout le dashboard. |
| `GET /api/account` | Liquidités, équity, P&L réalisé/latent, frais. |
| `GET /api/positions` | Positions ouvertes avec P&L latent, stop et objectif. |
| `GET /api/trades?limit=50` | Historique des ordres. |
| `GET /api/equity?limit=500` | Courbe d'équity. |
| `GET /api/journal?limit=30&symbol=TSLA` | Journal de bord de l'IA. |
| `GET /api/cycles` | Résumés des derniers cycles. |
| `GET /api/logs` | Logs récents du moteur. |
| `GET /api/config` | Paramètres de stratégie (**aucune clé exposée**). |
| `GET /api/market/:symbol` | Bougies + indicateurs calculés. |
| `GET /api/news/:symbol` | Actualités récupérées pour cet actif. |

### Écriture (`X-Admin-Token` requis)

| Route | Description |
|---|---|
| `POST /api/cycle` | Déclenche un cycle immédiatement. |
| `POST /api/pause` / `POST /api/resume` | Suspend / reprend les cycles planifiés. |
| `POST /api/scheduler/stop` / `start` | Arrête / relance le planificateur. |
| `GET /api/llm/keys` | Liste les clés du pool (masquées) et la capacité. |
| `POST /api/llm/keys` | Ajoute une clé (testée auprès de Google avant enregistrement). |
| `POST /api/llm/keys/check` | Re-teste toutes les clés sans consommer de quota. |
| `DELETE /api/llm/keys/:id` | Retire une clé ajoutée à chaud. |
| `POST /api/reset` | Réinitialise portefeuille et journal (**interdit sur broker réel**). |
| `GET /api/prompt/:symbol` | Reconstitue le prompt exact envoyé au LLM, sans consommer de quota. |

```bash
curl -X POST -H "X-Admin-Token: $ADMIN_TOKEN" https://mon-bot.onrender.com/api/cycle
```

`GET /api/prompt/:symbol` est l'outil de mise au point le plus utile : il montre exactement ce que
le modèle voit — indicateurs, titres de presse, budget de risque disponible.

---

## Hébergement 24/7

Le bot doit tourner en permanence. Quatre approches, de la plus simple à la moins chère :

### Render — le plus simple (recommandé pour démarrer)

Un [`render.yaml`](render.yaml) est fourni. Connecte le dépôt sur [render.com](https://render.com),
Render détecte le fichier et propose le service. Renseigne les variables secrètes dans
*Environment* (jamais dans le dépôt).

⚠️ **Le plan gratuit met le service en veille après 15 min d'inactivité** : les cycles cron ne
s'exécutent plus. Deux solutions : passer au plan payant (~7 $/mois), ou garder le plan gratuit et
déclencher les cycles depuis l'extérieur (voir « cron externe » plus bas).

⚠️ Le disque d'un plan gratuit est **éphémère** : le portefeuille est perdu à chaque redéploiement.
Ajoute un *Persistent Disk* monté sur `/data` et mets `DATA_DIR=/data`.

### Railway / Fly.io

Même principe, avec un [`Dockerfile`](Dockerfile) fourni. Railway facture à l'usage (~5 $/mois pour
ce bot). Fly.io propose un volume persistant gratuit — bon compromis. Pense à monter un volume et à
pointer `DATA_DIR` dessus.

### VPS (Hetzner, OVH, Scaleway — à partir de 4 €/mois)

Le plus économique et le plus robuste ; aucune mise en veille, disque persistant natif.

```bash
# sur le serveur
git clone <ton-depot-backend> && cd backend
npm ci --omit=dev && cp .env.example .env && nano .env

sudo tee /etc/systemd/system/trading-bot.service > /dev/null <<'EOF'
[Unit]
Description=LLM Trading Bot
After=network-online.target

[Service]
Type=simple
User=bot
WorkingDirectory=/home/bot/backend
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=10
EnvironmentFile=/home/bot/backend/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now trading-bot
sudo journalctl -u trading-bot -f
```

Ajoute Caddy ou Nginx devant pour le HTTPS — **indispensable** : un dashboard servi en HTTPS par
Netlify ne peut pas appeler une API en HTTP (le navigateur bloque le contenu mixte).

### Cron externe — coût nul

`npm run cycle` exécute un cycle puis sort. Un ordonnanceur externe l'appelle à intervalle régulier,
et il n'y a plus de serveur à maintenir.

- **GitHub Actions** : un workflow planifié qui lance `npm run cycle`. Attention, il faut alors
  persister `data/` entre deux exécutions (cache d'artefacts ou commit automatique) — sinon le
  portefeuille repart de zéro à chaque fois.
- **cron-job.org / Cloud Scheduler** : appelle `POST /api/cycle` avec le jeton admin sur une instance
  gratuite. Cela réveille aussi le service Render endormi. C'est la combinaison la plus économique.

### Comparatif

| Solution | Coût | Persistance | Mise en veille | Mise en place |
|---|---|---|---|---|
| Render gratuit + cron externe | 0 € | ⚠️ disque éphémère | contournée | ★★★★★ |
| Render payant | ~7 $/mois | disque persistant | non | ★★★★★ |
| Fly.io | 0–5 $/mois | volume gratuit | non | ★★★☆☆ |
| Railway | ~5 $/mois | volume | non | ★★★★☆ |
| VPS + systemd | 4–6 €/mois | native | non | ★★☆☆☆ |

---

## Passer au trading réel

`brokers/AlpacaBrokerAdapter.js` montre que le moteur n'a **pas à changer** : mêmes méthodes, même
contrat. La marche à suivre :

1. Valider la stratégie en paper trading sur plusieurs mois, avec des statistiques (taux de
   réussite, drawdown maximum, P&L net de frais).
2. Créer un compte chez un courtier avec API, et **commencer par son endpoint paper**
   (`https://paper-api.alpaca.markets`).
3. Renseigner `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY`, mettre `BROKER=alpaca`.
4. L'envoi d'ordres est verrouillé par le drapeau `orderSubmissionEnabled` dans l'adaptateur. Tant
   qu'il est à `false`, aucun ordre ne part : les ordres sont journalisés mais non transmis. C'est
   volontaire — ce drapeau est le dernier cran de sécurité avant d'engager de l'argent réel.

Points à traiter avant tout passage en réel : gestion des ordres partiellement exécutés,
réconciliation des positions au redémarrage, ordres bracket pour les stops côté courtier, et
fiscalité.

### Écrire un autre adaptateur

```js
import { BrokerAdapter } from './BrokerAdapter.js';

export class MonCourtierAdapter extends BrokerAdapter {
  get name() { return 'mon-courtier'; }
  get isLive() { return true; }

  async init() { /* ouverture de session */ return this; }
  async getAccount() { /* … */ }
  async getPositions() { /* … */ }
  async getPosition(symbol) { /* … */ }
  async buy({ symbol, quantity, price, fxRate }) { /* … */ }
  async sell({ symbol, quantity, price, fxRate }) { /* … */ }
  async markToMarket(quotes) { /* … */ }
  async setProtection(symbol, levels) { /* … */ }
  async getTrades(limit) { /* … */ }
  async getEquityCurve(limit) { /* … */ }
}
```

Puis enregistre-le dans `brokers/index.js`. Le moteur n'a pas connaissance de son existence.

---

## Sécurité

- `.env` est dans `.gitignore` — **ne le committe jamais**.
- Restreins `CORS_ORIGINS` au domaine exact de ton dashboard une fois en production.
- `ADMIN_TOKEN` doit être long et aléatoire : `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.
- Si une clé a transité par un canal non sécurisé (chat, capture d'écran, dépôt public),
  révoque-la et régénère-la.
