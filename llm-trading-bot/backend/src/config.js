import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export const config = {
  server: {
    port: num('PORT', 8080),
    corsOrigins: list('CORS_ORIGINS', ['*']),
    adminToken: str('ADMIN_TOKEN'),
  },

  llm: {
    provider: str('LLM_PROVIDER', 'gemini'),
    // Plusieurs comptes gratuits = plusieurs quotas. `GEMINI_API_KEYS` accepte
    // une liste séparée par des virgules ; `GEMINI_API_KEY` reste accepté seul.
    apiKeys: [...new Set([...list('GEMINI_API_KEYS'), ...(str('GEMINI_API_KEY') ? [str('GEMINI_API_KEY')] : [])])],
    model: str('GEMINI_MODEL', 'gemini-2.5-flash'),
    temperature: num('LLM_TEMPERATURE', 0.2),
    maxOutputTokens: num('LLM_MAX_OUTPUT_TOKENS', 4096),
    // 0 = raisonnement interne désactivé (réponse directe, moins de tokens).
    thinkingBudget: num('LLM_THINKING_BUDGET', 0),
    timeoutMs: num('LLM_TIMEOUT_MS', 60000),
    // Pause entre deux analyses d'un même cycle (quotas par minute du palier gratuit).
    cooldownMs: num('LLM_COOLDOWN_MS', 8000),
    // Plafond d'appels par jour ET PAR CLÉ. 0 = illimité (clé payante).
    // La capacité totale du bot vaut : nombre de clés × cette valeur.
    callsPerKeyPerDay: num('LLM_CALLS_PER_KEY_PER_DAY', num('LLM_MAX_CALLS_PER_DAY', 20)),
  },

  universe: {
    symbols: list('SYMBOLS', ['TSLA', 'AAPL', 'MSFT']),
    interval: str('CANDLE_INTERVAL', '1h'),
    range: str('CANDLE_RANGE', '3mo'),
  },

  schedule: {
    cron: str('CRON_SCHEDULE', '*/30 * * * *'),
    timezone: str('CRON_TIMEZONE', 'Europe/Paris'),
    runOnStart: bool('RUN_ON_START', true),
    onlyMarketHours: bool('ONLY_MARKET_HOURS', true),
  },

  risk: {
    baseCurrency: str('BASE_CURRENCY', 'EUR'),
    initialCapital: num('INITIAL_CAPITAL', 100),
    maxPositions: num('MAX_POSITIONS', 3),
    maxPositionPct: num('MAX_POSITION_PCT', 0.35),
    minOrderValue: num('MIN_ORDER_VALUE', 5),
    stopLossPct: num('STOP_LOSS_PCT', 0.05),
    takeProfitPct: num('TAKE_PROFIT_PCT', 0.12),
    maxDailyLossPct: num('MAX_DAILY_LOSS_PCT', 0.1),
  },

  broker: {
    kind: str('BROKER', 'paper'),
    feePct: num('FEE_PCT', 0.001),
    slippagePct: num('SLIPPAGE_PCT', 0.0005),
    alpaca: {
      keyId: str('ALPACA_KEY_ID'),
      secretKey: str('ALPACA_SECRET_KEY'),
      baseUrl: str('ALPACA_BASE_URL', 'https://paper-api.alpaca.markets'),
    },
  },

  news: {
    providers: list('NEWS_PROVIDERS', ['finnhub', 'newsapi', 'rss']),
    lookbackHours: num('NEWS_LOOKBACK_HOURS', 48),
    maxArticles: num('NEWS_MAX_ARTICLES', 8),
    finnhubKey: str('FINNHUB_API_KEY'),
    newsapiKey: str('NEWSAPI_KEY'),
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

  // Le pool peut aussi contenir des clés ajoutées à chaud (data/llm-keys.json),
  // on ne bascule donc sur l'heuristique que si `.env` ET le pool sont vides —
  // ce second contrôle est fait au démarrage dans server.js.
  if (config.llm.provider === 'gemini' && !config.llm.apiKeys.length) {
    warnings.push('Aucune clé dans GEMINI_API_KEYS/GEMINI_API_KEY — ajoute-en via `npm run keys:add`.');
  }
  if (!config.server.adminToken) {
    warnings.push('ADMIN_TOKEN absent → les routes d\'écriture sont désactivées.');
  }
  if (config.broker.kind !== 'paper') {
    warnings.push(`BROKER=${config.broker.kind} : trading réel. Vérifie tes clés et tes limites de risque.`);
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
  return warnings;
}
