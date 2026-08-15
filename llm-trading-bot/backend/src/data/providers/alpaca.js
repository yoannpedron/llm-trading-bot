import { getJson } from '../../utils/http.js';
import { config } from '../../config.js';

const INTERVAL_MAP = {
  '5m': '5Min',
  '15m': '15Min',
  '30m': '30Min',
  '1h': '1Hour',
  '1d': '1Day',
};

/**
 * Fenêtres exprimées en jours CALENDAIRES à remonter.
 *
 * Les valeurs sont plus larges que la fenêtre nominale — 190 jours pour six
 * mois, 400 pour un an — parce que les week-ends et jours fériés ne produisent
 * pas de bougie : viser exactement 180 jours en rendrait environ 124.
 *
 * `1d` et `5d` manquaient, et leur absence était silencieuse : `?? 400`
 * ramenait 400 jours de bougies 5 minutes, soit 21 000 points pour un
 * graphique qui en affiche 80. Le défaut ne se voyait qu'au temps de réponse.
 */
const RANGE_DAYS = { '1d': 4, '5d': 9, '1mo': 30, '3mo': 90, '6mo': 190, '1y': 400, '2y': 760 };

/**
 * Nombre minimal de bougies exigé.
 *
 * Le seuil protège la chaîne de DÉCISION : les indicateurs (EMA50, SMA200)
 * n'ont aucun sens sur vingt points, et une décision prise dessus serait du
 * bruit. Il n'a en revanche rien à faire dans un graphique d'affichage, où
 * vingt bougies se tracent très bien — d'où `minCandles: 0` pour ce cas.
 */
const MIN_CANDLES = 30;

/**
 * Données de marché Alpaca — source primaire depuis la migration.
 *
 * Avantage décisif sur Yahoo : c'est le même fournisseur que celui qui exécute
 * nos ordres. Les prix analysés et les prix de fill viennent du même monde, ce
 * qui élimine une classe entière d'incohérences.
 *
 * Limite du palier gratuit : le flux `iex` ne voit qu'environ 2-3 % du volume
 * consolidé. Les spreads y paraissent plus larges que le NBBO auquel Alpaca
 * exécute réellement — une erreur dans le bon sens (on sous-estime notre
 * qualité d'exécution), mais qui interdit de prédire finement un prix de fill.
 */
export const alpacaProvider = {
  name: 'alpaca',

  get isConfigured() {
    return Boolean(config.broker.alpaca.keyId && config.broker.alpaca.secretKey);
  },

  headers() {
    return {
      'APCA-API-KEY-ID': config.broker.alpaca.keyId,
      'APCA-API-SECRET-KEY': config.broker.alpaca.secretKey,
    };
  },

  async getCandles(symbol, { interval = '1d', range = '1y', minCandles = MIN_CANDLES } = {}) {
    if (!this.isConfigured) throw new Error('Clés Alpaca absentes (ALPACA_KEY_ID / ALPACA_SECRET_KEY).');

    const timeframe = INTERVAL_MAP[interval] || '1Day';
    const days = RANGE_DAYS[range] ?? 400;
    // On recule d'un jour de plus que nécessaire : le SIP gratuit est bridé
    // sur les 15 dernières minutes, et une borne trop récente renvoie une 403.
    const start = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

    const candles = [];
    let pageToken = null;

    do {
      const qs = new URLSearchParams({
        timeframe,
        start,
        limit: '10000',
        adjustment: 'all',
        feed: config.universe.feed,
        sort: 'asc',
        ...(pageToken ? { page_token: pageToken } : {}),
      });

      const data = await getJson(
        `${config.broker.alpaca.dataUrl}/v2/stocks/${encodeURIComponent(symbol)}/bars?${qs}`,
        { headers: this.headers(), timeoutMs: 15000 },
      );

      for (const b of data.bars || []) {
        candles.push({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
      }
      pageToken = data.next_page_token || null;
    } while (pageToken && candles.length < 20000);

    if (candles.length < minCandles) {
      throw new Error(`historique Alpaca insuffisant pour ${symbol} (${candles.length} bougies, flux ${config.universe.feed})`);
    }

    return {
      symbol,
      currency: 'USD',
      exchange: `Alpaca/${config.universe.feed.toUpperCase()}`,
      marketState: 'UNKNOWN',
      instrumentType: 'EQUITY',
      lastPrice: candles[candles.length - 1].close,
      candles,
    };
  },

  /**
   * Cotation bid/ask courante. C'est la source de la mesure de spread :
   * c'est le seul coût de transaction réel chez Alpaca (commission nulle,
   * frais réglementaires de l'ordre de 0,03 bps).
   */
  async getQuote(symbol) {
    const qs = new URLSearchParams({ feed: config.universe.feed });
    const data = await getJson(
      `${config.broker.alpaca.dataUrl}/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest?${qs}`,
      { headers: this.headers(), timeoutMs: 10000 },
    );

    const q = data?.quote;
    if (!q || !(q.ap > 0) || !(q.bp > 0)) throw new Error(`cotation ${symbol} indisponible`);

    const mid = (q.ap + q.bp) / 2;
    return {
      symbol,
      price: mid,
      bid: q.bp,
      ask: q.ap,
      spread: q.ap - q.bp,
      spreadBps: ((q.ap - q.bp) / mid) * 10000,
      quotedAt: q.t,
      currency: 'USD',
      marketState: 'UNKNOWN',
    };
  },

  /** Horloge officielle du marché : plus fiable qu'une heuristique horaire. */
  async getClock() {
    return getJson(`${config.broker.alpaca.baseUrl}/v2/clock`, { headers: this.headers(), timeoutMs: 8000 });
  },
};
