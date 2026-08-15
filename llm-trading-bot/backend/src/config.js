import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// entities.js ne dépend que de node: — pas de cycle d'import avec config.
import { entityCoverage } from './llm/entities.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const str = (key, fallback = '') => (process.env[key] ?? fallback).toString().trim();
const num = (key, fallback) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (key, fallback) => {
  const raw = str(key, String(fallback)).toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
};
const list = (key, fallback = []) => {
  const raw = str(key);
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
};

/**
 * Budget de raisonnement interne par famille de modèle.
 *
 * Gemini 2.x accepte `thinkingBudget: 0` pour désactiver complètement la
 * réflexion. Gemini 3.x le REFUSE avec un HTTP 400 : il faut lui donner un
 * budget strictement positif. Un budget de 128 suffit — vérifié en pratique,
 * le modèle n'en consomme alors aucun et répond directement.
 */
function defaultThinkingBudget(model) {
  return /^gemini-[3-9]/.test(model) ? 128 : 0;
}

const model = str('GEMINI_MODEL', 'gemini-3.5-flash-lite');

export const config = {
  server: {
    port: num('PORT', 8080),
    corsOrigins: list('CORS_ORIGINS', ['*']),
    adminToken: str('ADMIN_TOKEN'),
  },

  llm: {
    provider: str('LLM_PROVIDER', 'gemini'),
    // Plusieurs comptes gratuits = plusieurs quotas cumulés.
    apiKeys: [...new Set([...list('GEMINI_API_KEYS'), ...(str('GEMINI_API_KEY') ? [str('GEMINI_API_KEY')] : [])])],
    model,
    // Température NULLE. Ce n'est pas un réglage de style, c'est une condition
    // de la mesure : le SPRT teste UNE stratégie, pas un nuage de stratégies.
    // À température 0,2 le même contexte peut produire des décisions
    // différentes, ce qui injecte de la variance qui n'est due qu'à
    // l'échantillonnage du décodeur. Cette variance gonfle σ, écrase le Sharpe
    // observé, et rallonge le test sans rien apprendre. On la supprime.
    temperature: num('LLM_TEMPERATURE', 0),
    maxOutputTokens: num('LLM_MAX_OUTPUT_TOKENS', 4096),
    thinkingBudget: num('LLM_THINKING_BUDGET', defaultThinkingBudget(model)),
    timeoutMs: num('LLM_TIMEOUT_MS', 60000),
    // 15 requêtes/minute sur le palier gratuit → 5 s d'écart garantit la marge.
    cooldownMs: num('LLM_COOLDOWN_MS', 5000),
    // Plafond journalier PAR CLÉ. Recalibré automatiquement si un 429 révèle
    // une valeur différente (voir keyPool.calibrateFrom429).
    callsPerKeyPerDay: num('LLM_CALLS_PER_KEY_PER_DAY', 500),
  },

  universe: {
    // Watchlist analysée à chaque cycle. Ce n'est PAS le nombre de positions :
    // le gestionnaire de risque en autorise 3 simultanées au maximum.
    symbols: list('SYMBOLS', ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'AMD', 'NFLX', 'AVGO']),
    // Bougies journalières : l'horizon de détention visé est de 1 à 7 jours.
    // L'intraday est écarté — le coût de rotation le rend non rentable ici.
    interval: str('CANDLE_INTERVAL', '1d'),
    range: str('CANDLE_RANGE', '1y'),
    // Flux de données Alpaca : `iex` (gratuit) ou `sip` (abonnement payant).
    feed: str('ALPACA_DATA_FEED', 'iex'),
  },

  schedule: {
    cron: str('CRON_SCHEDULE', '30 16,19,21 * * 1-5'),
    timezone: str('CRON_TIMEZONE', 'Europe/Paris'),
    runOnStart: bool('RUN_ON_START', true),
    onlyMarketHours: bool('ONLY_MARKET_HOURS', true),
  },

  risk: {
    // Le compte Alpaca est libellé en dollars : aucune conversion de devise.
    baseCurrency: str('BASE_CURRENCY', 'USD'),
    initialCapital: num('INITIAL_CAPITAL', 100),
    maxPositions: num('MAX_POSITIONS', 3),
    maxPositionPct: num('MAX_POSITION_PCT', 0.35),
    // Plancher d'ordre volontairement bas.
    //
    // Les rapports de recherche justifiaient un plancher élevé (50 € et plus)
    // par la dilution des COMMISSIONS FIXES : chez IBKR ou Trade Republic, un
    // ordre à 0,35-1 € rend toute position inférieure à ~50 € non rentable.
    // Cet argument ne s'applique PAS ici : Alpaca ne prend aucune commission,
    // et les frais réglementaires (~0,03 bps) sont proportionnels. Le coût
    // dominant est le spread, lui aussi proportionnel — donc un ordre de 5 $
    // coûte exactement le même POURCENTAGE qu'un ordre de 50 $.
    //
    // On garde 5 $ comme marge au-dessus du plancher technique d'Alpaca (1 $).
    minOrderValue: num('MIN_ORDER_VALUE', 5),

    // ── Stops ─────────────────────────────────────────────────────────────
    // La recherche est nette : un stop serré (5 %) est SOUS le bruit
    // quotidien d'une valeur comme TSLA (ATR journalier 3-5 %) et coupe des
    // positions gagnantes au hasard. On dimensionne donc sur l'ATR, avec un
    // plancher et un plafond pour éviter les valeurs aberrantes.
    stopAtrMultiple: num('STOP_ATR_MULTIPLE', 4),
    stopMinPct: num('STOP_MIN_PCT', 0.08),
    stopMaxPct: num('STOP_MAX_PCT', 0.2),
    // Pas de take-profit fixe : il tronque la queue droite de la distribution
    // et détruit l'espérance des stratégies de suivi de tendance. La sortie
    // se fait sur signal du LLM ou sur stop.
    takeProfitPct: num('TAKE_PROFIT_PCT', 0) || null,

    // Coupe-circuit MENSUEL et non journalier : 10 % de 100 $ = 10 $, très
    // en dessous du bruit stochastique normal du portefeuille.
    maxMonthlyLossPct: num('MAX_MONTHLY_LOSS_PCT', 0.15),
    // Confiance minimale du LLM pour autoriser une ouverture.
    minConfidence: num('MIN_CONFIDENCE', 0.35),

    // ── Seuils appliqués à la PRÉVISION du modèle ─────────────────────────
    // Le modèle ne choisit plus l'action : il annonce une répartition d'issues
    // sur 100 scénarios, et c'est ici qu'on décide quoi en faire. Ce
    // déplacement est délibéré. Un LLM entraîné par RLHF privilégie la réponse
    // prudente quand on lui demande d'agir — le biais penche vers HOLD, pour
    // des raisons de politesse apprise et non d'analyse. En lui demandant
    // seulement de prévoir, puis en fixant NOUS-MÊMES le seuil de passage à
    // l'acte, on récupère la prévision sans hériter du biais, et le seuil
    // devient un paramètre visible et mesurable au lieu d'un réflexe caché.
    //
    // 0,20 d'écart : il faut 60/40 au minimum, pas 51/49. En dessous, l'écart
    // est indiscernable du bruit d'estimation du modèle lui-même.
    minEdge: num('MIN_EDGE', 0.2),
    // Et une probabilité haussière absolue suffisante. L'écart seul ne suffit
    // pas : un 20/0/80 affiche 20 points d'écart alors que le modèle annonce
    // 80 % de chances qu'il ne se passe rien. Ce seuil écarte ces cas où le
    // pari porte sur un scénario minoritaire.
    //
    // Il est atteint de justesse par un 40/20/40, qui passe donc — et c'est
    // volontaire : à 40 contre 20, la hausse reste deux fois plus probable que
    // la baisse, l'espérance est positive, et la bande d'indécision ne coûte
    // presque rien. Ce n'est pas le cas que ce garde-fou vise.
    minUpProbability: num('MIN_UP_PROBABILITY', 0.4),

    // ── Seuil relevé quand les actualités manquent ────────────────────────
    // Mesuré, pas supposé. En rejouant une séance sans actualités
    // reconstituables, le modèle a penché à la baisse dans 9 cas sur 10 — alors
    // que la consigne du prompt lui demande explicitement de RESSERRER vers
    // l'équilibre quand une des deux sources manque. Il lit l'absence
    // d'information comme une mauvaise nouvelle.
    //
    // On ne corrige pas sa prévision : elle doit rester telle qu'annoncée, sans
    // quoi la mesure de calibration mesurerait nos retouches. On exige
    // simplement DAVANTAGE d'écart avant d'agir — moins d'information, plus de
    // preuves. Le seuil s'applique dans les deux sens : une sortie déclenchée
    // par une panne de flux RSS coûte le tail droit d'une position saine.
    //
    // 0,35 est provisoire. Dès que le carnet fantôme comptera assez de
    // décisions en mode dégradé, le décalage réel sera mesurable et remplacera
    // ce chiffre.
    minEdgeDegraded: num('MIN_EDGE_DEGRADED', 0.35),
  },

  broker: {
    // `alpaca` = compte paper réel chez Alpaca (recommandé).
    // `paper`  = simulateur interne, conservé pour les tests hors ligne.
    kind: str('BROKER', 'alpaca'),
    feePct: num('FEE_PCT', 0),
    slippagePct: num('SLIPPAGE_PCT', 0),
    alpaca: {
      keyId: str('ALPACA_KEY_ID'),
      secretKey: str('ALPACA_SECRET_KEY'),
      baseUrl: str('ALPACA_BASE_URL', 'https://paper-api.alpaca.markets'),
      dataUrl: str('ALPACA_DATA_URL', 'https://data.alpaca.markets'),
    },
  },

  news: {
    providers: list('NEWS_PROVIDERS', ['finnhub', 'newsapi', 'rss']),
    lookbackHours: num('NEWS_LOOKBACK_HOURS', 48),
    maxArticles: num('NEWS_MAX_ARTICLES', 6),
    finnhubKey: str('FINNHUB_API_KEY'),
    newsapiKey: str('NEWSAPI_KEY'),
    // Remplace les noms d'entreprise par des jetons génériques avant l'appel
    // LLM. Contre-intuitif mais démontré (Glasserman & Lin 2023) : supprime
    // « l'effet de distraction » et améliore la performance hors échantillon.
    anonymize: bool('NEWS_ANONYMIZE', true),
  },

  storage: {
    dir: path.isAbsolute(str('DATA_DIR', './data'))
      ? str('DATA_DIR', './data')
      : path.resolve(ROOT, str('DATA_DIR', './data')),
  },
};

/**
 * Vérifie la cohérence de la configuration au démarrage.
 * Retourne la liste des avertissements (non bloquants) ; lève sur erreur fatale.
 */
export function validateConfig() {
  const warnings = [];

  if (config.llm.provider === 'gemini' && !config.llm.apiKeys.length) {
    warnings.push('Aucune clé dans GEMINI_API_KEYS/GEMINI_API_KEY — ajoute-en via `npm run keys:add`.');
  }
  if (!config.server.adminToken) {
    warnings.push('ADMIN_TOKEN absent → les routes d\'écriture sont désactivées.');
  }
  if (config.broker.kind === 'alpaca') {
    if (!config.broker.alpaca.keyId || !config.broker.alpaca.secretKey) {
      throw new Error('BROKER=alpaca exige ALPACA_KEY_ID et ALPACA_SECRET_KEY.');
    }
    if (!config.broker.alpaca.baseUrl.includes('paper-api')) {
      warnings.push('⚠️  ALPACA_BASE_URL ne pointe PAS vers paper-api : ordres sur compte RÉEL.');
    }
  }
  if (!config.universe.symbols.length) {
    throw new Error('SYMBOLS est vide : aucun actif à analyser.');
  }
  if (config.risk.maxPositionPct <= 0 || config.risk.maxPositionPct > 1) {
    throw new Error('MAX_POSITION_PCT doit être compris entre 0 et 1.');
  }
  if (config.risk.initialCapital <= 0) {
    throw new Error('INITIAL_CAPITAL doit être strictement positif.');
  }

  // Le quota LLM doit couvrir l'univers : sinon les derniers actifs de chaque
  // cycle basculeront systématiquement sur le moteur heuristique.
  const callsPerCycle = config.universe.symbols.length;
  if (config.llm.callsPerKeyPerDay > 0 && callsPerCycle > config.llm.callsPerKeyPerDay) {
    warnings.push(
      `${callsPerCycle} actifs pour ${config.llm.callsPerKeyPerDay} appels/jour/clé : un seul cycle épuise le quota.`,
    );
  }

  // ── Couverture de l'anonymisation ───────────────────────────────────────
  // Un symbole sans dictionnaire d'entités part avec ses dirigeants et ses
  // produits en clair. Le modèle identifie alors l'entreprise et répond depuis
  // sa mémoire plutôt que depuis les faits du jour — ce que le carnet fantôme
  // enregistrera comme une prévision, sans moyen de le distinguer.
  //
  // L'avertissement est ici, et pas seulement dans un script à lancer à la
  // main, parce que c'est au démarrage qu'il faut le voir : une fois le bot
  // parti, les décisions contaminées s'accumulent en silence.
  if (config.news.anonymize) {
    const c = entityCoverage(config.universe.symbols);
    const manquants = c.partiels.length + c.absents.length;
    if (manquants > 0) {
      warnings.push(
        `Anonymisation incomplète : ${c.couverts}/${c.total} symboles couverts. `
        + `${manquants} partiront avec dirigeants et produits en clair — leurs décisions sont `
        + 'contaminées par la mémoire du modèle. Corriger avec `npm run entities:build`, '
        + 'détail avec `npm run entities`.',
      );
    }
  }

  return warnings;
}
