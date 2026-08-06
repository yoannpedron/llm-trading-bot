import { BrokerAdapter } from './BrokerAdapter.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { getJson, postJson } from '../utils/http.js';

const log = createLogger('alpaca');

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  SQUELETTE — TRADING RÉEL. NON ACTIVÉ PAR DÉFAUT.                        │
 * │                                                                          │
 * │  Cet adaptateur montre qu'on passe au réel SANS toucher au moteur :      │
 * │  mêmes méthodes, même contrat, seule l'implémentation change.            │
 * │  `submitOrder()` est volontairement bloquée : décommenter cet appel      │
 * │  envoie de VRAIS ordres sur un VRAI compte. À faire uniquement en toute  │
 * │  connaissance de cause, après avoir validé la stratégie en paper trading │
 * │  sur plusieurs mois, et en commençant par l'endpoint paper d'Alpaca.     │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
export class AlpacaBrokerAdapter extends BrokerAdapter {
  constructor(options = {}) {
    super();
    this.baseUrl = options.baseUrl ?? config.broker.alpaca.baseUrl;
    this.keyId = options.keyId ?? config.broker.alpaca.keyId;
    this.secretKey = options.secretKey ?? config.broker.alpaca.secretKey;
    // Garde-fou logiciel : tant que ce drapeau est faux, aucun ordre ne part.
    this.orderSubmissionEnabled = options.orderSubmissionEnabled === true;
  }

  get name() {
    return 'alpaca';
  }

  get isLive() {
    return !this.baseUrl.includes('paper-api');
  }

  #headers() {
    return {
      'APCA-API-KEY-ID': this.keyId,
      'APCA-API-SECRET-KEY': this.secretKey,
    };
  }

  async init() {
    if (!this.keyId || !this.secretKey) {
      throw new Error('ALPACA_KEY_ID / ALPACA_SECRET_KEY manquants.');
    }
    const account = await getJson(`${this.baseUrl}/v2/account`, { headers: this.#headers() });
    if (account.trading_blocked) throw new Error('Compte Alpaca bloqué au trading.');
    log.warn(`Broker ${this.isLive ? 'RÉEL' : 'paper Alpaca'} connecté — équity ${account.equity} ${account.currency}`);
    return this;
  }

  async getAccount() {
    const a = await getJson(`${this.baseUrl}/v2/account`, { headers: this.#headers() });
    const equity = Number(a.equity);
    const initial = Number(a.last_equity) || equity;
    return {
      broker: this.name,
      isLive: this.isLive,
      currency: a.currency,
      cash: Number(a.cash),
      positionsValue: Number(a.long_market_value),
      equity,
      positionsCount: undefined,
      initialCapital: initial,
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: equity - initial,
      totalPnlPct: initial ? ((equity - initial) / initial) * 100 : 0,
      feesPaid: 0,
    };
  }

  async getPositions() {
    const positions = await getJson(`${this.baseUrl}/v2/positions`, { headers: this.#headers() });
    return positions.map((p) => ({
      symbol: p.symbol,
      quantity: Number(p.qty),
      avgPrice: Number(p.avg_entry_price),
      lastPrice: Number(p.current_price),
      currency: 'USD',
      marketValue: Number(p.market_value),
      costBasis: Number(p.cost_basis),
      unrealizedPnl: Number(p.unrealized_pl),
      unrealizedPnlPct: Number(p.unrealized_plpc) * 100,
      openedAt: null,
      stopPrice: null,
      takeProfitPrice: null,
    }));
  }

  async getPosition(symbol) {
    return (await this.getPositions()).find((p) => p.symbol === symbol) ?? null;
  }

  async #submitOrder({ symbol, quantity, side }) {
    if (!this.orderSubmissionEnabled) {
      const reason = 'envoi d\'ordres désactivé (orderSubmissionEnabled=false) — sécurité';
      log.warn(`Ordre ${side} ${quantity} ${symbol} NON transmis : ${reason}`);
      return { status: 'rejected', reason };
    }

    const order = await postJson(
      `${this.baseUrl}/v2/orders`,
      { symbol, qty: String(quantity), side: side.toLowerCase(), type: 'market', time_in_force: 'day' },
      { headers: this.#headers() },
    );

    return {
      status: 'filled',
      trade: {
        id: order.id,
        timestamp: order.submitted_at,
        side,
        symbol,
        quantity: Number(order.qty),
        price: Number(order.filled_avg_price ?? 0),
        currency: 'USD',
        brokerOrderId: order.id,
        brokerStatus: order.status,
      },
    };
  }

  async buy({ symbol, quantity }) {
    return this.#submitOrder({ symbol, quantity, side: 'BUY' });
  }

  async sell({ symbol, quantity }) {
    return this.#submitOrder({ symbol, quantity, side: 'SELL' });
  }

  /** Chez un vrai courtier, la valorisation est faite côté broker. */
  async markToMarket() {
    return this.getAccount();
  }

  /** À implémenter avec un ordre bracket (`order_class: 'bracket'`). */
  async setProtection(symbol) {
    log.warn(`setProtection(${symbol}) non implémenté pour Alpaca — utiliser un ordre bracket.`);
    return null;
  }

  async getTrades(limit = 100) {
    const activities = await getJson(
      `${this.baseUrl}/v2/account/activities/FILL?page_size=${limit}`,
      { headers: this.#headers() },
    );
    return activities.map((a) => ({
      id: a.id,
      timestamp: a.transaction_time,
      side: a.side.toUpperCase(),
      symbol: a.symbol,
      quantity: Number(a.qty),
      price: Number(a.price),
      currency: 'USD',
      realizedPnl: 0,
    }));
  }

  /** Alpaca expose l'historique via /v2/account/portfolio/history. */
  async getEquityCurve(limit = 500) {
    const history = await getJson(
      `${this.baseUrl}/v2/account/portfolio/history?period=1M&timeframe=1H`,
      { headers: this.#headers() },
    );
    return (history.timestamp || [])
      .map((ts, i) => ({
        t: new Date(ts * 1000).toISOString(),
        equity: history.equity?.[i] ?? null,
        cash: null,
        positionsValue: null,
      }))
      .slice(-limit);
  }
}
