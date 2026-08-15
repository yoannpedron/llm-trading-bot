import { getJson } from '../../utils/http.js';

const CHART_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

/**
 * Fournisseur de bougies OHLCV via l'API chart publique de Yahoo Finance.
 * Gratuit, sans clé. Couvre actions, ETF, indices, crypto (BTC-USD) et FX (EURUSD=X).
 */
export const yahooProvider = {
  name: 'yahoo',

  /**
   * @param {string} symbol   ticker Yahoo (TSLA, BTC-USD, EURUSD=X…)
   * @param {object} options  { interval: '1h', range: '3mo' }
   * @returns {Promise<{symbol, currency, exchange, marketState, candles: Array}>}
   */
  async getCandles(symbol, { interval = '1h', range = '3mo' } = {}) {
    const qs = new URLSearchParams({ interval, range, includePrePost: 'false', events: 'div,splits' });
    let lastErr;

    for (const host of CHART_HOSTS) {
      try {
        const data = await getJson(`${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`, {
          timeoutMs: 12000,
          retries: 1,
        });

        const result = data?.chart?.result?.[0];
        if (!result) throw new Error(data?.chart?.error?.description || 'réponse Yahoo vide');

        const { timestamp = [], indicators = {}, meta = {} } = result;
        const quote = indicators.quote?.[0] || {};
        const adj = indicators.adjclose?.[0]?.adjclose;

        const candles = timestamp
          .map((ts, i) => ({
            time: new Date(ts * 1000).toISOString(),
            open: quote.open?.[i],
            high: quote.high?.[i],
            low: quote.low?.[i],
            close: adj?.[i] ?? quote.close?.[i],
            volume: quote.volume?.[i] ?? 0,
          }))
          // Yahoo insère des trous (jours fériés, halts) : on les élimine.
          .filter((c) => [c.open, c.high, c.low, c.close].every((v) => typeof v === 'number' && Number.isFinite(v)));

        if (candles.length < (options?.minCandles ?? 30)) {
          throw new Error(`historique insuffisant pour ${symbol} (${candles.length} bougies)`);
        }

        return {
          symbol,
          currency: meta.currency || 'USD',
          exchange: meta.fullExchangeName || meta.exchangeName || 'unknown',
          marketState: meta.marketState || 'UNKNOWN',
          instrumentType: meta.instrumentType || 'EQUITY',
          lastPrice: meta.regularMarketPrice ?? candles[candles.length - 1].close,
          candles,
        };
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`Yahoo indisponible pour ${symbol} : ${lastErr?.message ?? 'erreur inconnue'}`);
  },

  /** Cotation légère (prix seul), utilisée pour le mark-to-market entre deux cycles. */
  async getQuote(symbol) {
    const { lastPrice, currency, marketState } = await this.getCandles(symbol, { interval: '5m', range: '1d' });
    return { symbol, price: lastPrice, currency, marketState };
  },
};
