import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { computeIndicators } from './indicators.js';
import { alpacaProvider } from './providers/alpaca.js';
import { yahooProvider } from './providers/yahoo.js';
import { spreadLog } from './spreadLog.js';

const log = createLogger('market');

// Alpaca est la source primaire : c'est le même fournisseur que celui qui
// exécute les ordres, donc prix analysés et prix de fill sont cohérents.
// Yahoo reste en secours (gratuit, sans clé) si Alpaca est indisponible.
const primary = alpacaProvider.isConfigured ? alpacaProvider : yahooProvider;
const fallback = primary === alpacaProvider ? yahooProvider : alpacaProvider;

const cache = new Map();
const CACHE_TTL_MS = 60_000;
let clockCache = { at: 0, value: null };

function readCache(key) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.value : null;
}

function writeCache(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * État officiel du marché selon Alpaca. Bien plus fiable que l'heuristique
 * horaire précédente : l'horloge du broker gère les jours fériés, les demi-
 * séances et les fermetures exceptionnelles, ce qu'aucun calcul d'heures UTC
 * ne peut faire correctement.
 */
export async function getMarketClock() {
  if (clockCache.value && Date.now() - clockCache.at < 30_000) return clockCache.value;
  try {
    const clock = await alpacaProvider.getClock();
    clockCache = { at: Date.now(), value: clock };
    return clock;
  } catch (err) {
    log.warn(`Horloge Alpaca indisponible (${err.message}) — repli sur l'estimation NYSE.`);
    const now = new Date();
    const day = now.getUTCDay();
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const open = day !== 0 && day !== 6 && minutes >= 870 && minutes <= 1260;
    return { is_open: open, estimated: true };
  }
}

/** Bougies + indicateurs, avec bascule automatique sur le fournisseur secondaire. */
export async function getMarketSnapshot(symbol, options = {}) {
  const interval = options.interval || config.universe.interval;
  const range = options.range || config.universe.range;
  const key = `snap:${symbol}:${interval}:${range}`;

  const cached = readCache(key);
  if (cached) return cached;

  let series;
  try {
    series = await primary.getCandles(symbol, { interval, range });
  } catch (err) {
    log.warn(`${primary.name} en échec sur ${symbol} (${err.message}) → tentative ${fallback.name}`);
    series = await fallback.getCandles(symbol, { interval, range });
  }

  const indicators = computeIndicators(series.candles);
  const snapshot = {
    ...series,
    indicators,
    // 10 bougies seulement : au-delà, le prompt sature la fenêtre d'attention
    // utile du modèle sans rien apporter (« lost in the middle »).
    recentCandles: series.candles.slice(-10).map((c) => ({
      t: c.time.slice(0, 10),
      o: Number(c.open.toFixed(2)),
      h: Number(c.high.toFixed(2)),
      l: Number(c.low.toFixed(2)),
      c: Number(c.close.toFixed(2)),
      v: c.volume,
    })),
    fetchedAt: new Date().toISOString(),
  };

  return writeCache(key, snapshot);
}

/**
 * Cotation courante + enregistrement du spread.
 * C'est ici que se construit, cycle après cycle, la mesure empirique du seul
 * coût de transaction qui compte chez Alpaca.
 */
export async function getQuote(symbol) {
  const key = `quote:${symbol}`;
  const cached = readCache(key);
  if (cached) return cached;

  try {
    const quote = await alpacaProvider.getQuote(symbol);
    const clock = await getMarketClock();

    await spreadLog.record({
      symbol,
      bid: quote.bid,
      ask: quote.ask,
      spreadBps: quote.spreadBps,
      price: quote.price,
      marketOpen: Boolean(clock.is_open),
    });

    return writeCache(key, quote);
  } catch (err) {
    log.warn(`Cotation ${symbol} indisponible (${err.message}) — repli sur le dernier cours.`);
    const snap = await getMarketSnapshot(symbol);
    return writeCache(key, {
      symbol,
      price: snap.lastPrice,
      bid: null,
      ask: null,
      spread: null,
      spreadBps: null,
      currency: 'USD',
    });
  }
}

/** Dernier prix connu, en dollars (le compte et les actifs sont en USD). */
export async function getPrice(symbol) {
  return (await getQuote(symbol)).price;
}

/**
 * Le compte Alpaca et les actions US sont libellés en dollars : il n'y a plus
 * aucune conversion de devise. La fonction est conservée pour compatibilité
 * avec le moteur, mais retourne toujours 1.
 */
export async function getFxRate() {
  return 1;
}

export async function toBaseCurrency(amount) {
  return amount;
}

/**
 * Décide si un actif est analysable maintenant. On s'appuie sur l'horloge
 * officielle du broker : inutile de brûler du quota LLM sur des prix figés.
 */
export async function isTradeable(snapshot) {
  const type = (snapshot.instrumentType || '').toUpperCase();
  if (type === 'CRYPTOCURRENCY' || type === 'CURRENCY') return { open: true, reason: 'marché 24/7' };

  const clock = await getMarketClock();
  if (clock.is_open) return { open: true, reason: 'séance ouverte' };

  const nextOpen = clock.next_open ? ` — réouverture ${new Date(clock.next_open).toLocaleString('fr-FR')}` : '';
  return { open: false, reason: `marché fermé${nextOpen}${clock.estimated ? ' (estimation)' : ''}` };
}
