import crypto from 'node:crypto';
import { BrokerAdapter } from './BrokerAdapter.js';
import { JsonStore } from '../storage/JsonStore.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('paper');

const round = (v, d = 2) => Number((v ?? 0).toFixed(d));
const nowIso = () => new Date().toISOString();

/**
 * Portefeuille fictif complet : liquidités, positions fractionnées, frais,
 * slippage, P&L réalisé/latent et courbe d'équity — le tout persisté sur disque
 * pour survivre à un redémarrage du serveur.
 */
export class PaperBrokerAdapter extends BrokerAdapter {
  constructor(options = {}) {
    super();
    this.feePct = options.feePct ?? config.broker.feePct;
    this.slippagePct = options.slippagePct ?? config.broker.slippagePct;
    this.currency = options.currency ?? config.risk.baseCurrency;
    this.initialCapital = options.initialCapital ?? config.risk.initialCapital;

    this.store = new JsonStore(config.storage.dir, 'portfolio.json', {
      currency: this.currency,
      initialCapital: this.initialCapital,
      cash: this.initialCapital,
      positions: {},
      trades: [],
      equityCurve: [],
      realizedPnl: 0,
      feesPaid: 0,
      createdAt: nowIso(),
    });
  }

  get name() {
    return 'paper';
  }

  get isLive() {
    return false;
  }

  async init() {
    await this.store.load();
    // Un changement de capital initial dans .env ne doit pas réécrire un
    // portefeuille déjà en cours : on ne l'applique qu'au premier démarrage.
    if (!this.store.data.equityCurve.length) {
      await this.#snapshotEquity();
    }
    log.info(`Portefeuille papier prêt : ${round(this.store.data.cash)} ${this.currency} de liquidités`);
    return this;
  }

  get #state() {
    return this.store.data;
  }

  #positionsValue() {
    return Object.values(this.#state.positions).reduce(
      (sum, p) => sum + p.quantity * (p.lastPrice ?? p.avgPrice) * (p.lastFxRate ?? p.fxRateAtEntry ?? 1),
      0,
    );
  }

  async getAccount() {
    const s = this.#state;
    const positionsValue = this.#positionsValue();
    const equity = s.cash + positionsValue;
    const costBasis = Object.values(s.positions).reduce(
      (sum, p) => sum + p.quantity * p.avgPrice * (p.fxRateAtEntry ?? 1),
      0,
    );

    return {
      broker: this.name,
      isLive: false,
      currency: s.currency,
      cash: round(s.cash),
      positionsValue: round(positionsValue),
      equity: round(equity),
      positionsCount: Object.keys(s.positions).length,
      initialCapital: s.initialCapital,
      realizedPnl: round(s.realizedPnl),
      unrealizedPnl: round(positionsValue - costBasis),
      totalPnl: round(equity - s.initialCapital),
      totalPnlPct: round(((equity - s.initialCapital) / s.initialCapital) * 100, 2),
      feesPaid: round(s.feesPaid, 4),
      createdAt: s.createdAt,
    };
  }

  async getPositions() {
    return Object.values(this.#state.positions).map((p) => {
      const price = p.lastPrice ?? p.avgPrice;
      const fx = p.lastFxRate ?? p.fxRateAtEntry ?? 1;
      const marketValue = p.quantity * price * fx;
      const costBasis = p.quantity * p.avgPrice * (p.fxRateAtEntry ?? 1);
      return {
        ...p,
        quantity: round(p.quantity, 6),
        avgPrice: round(p.avgPrice, 4),
        lastPrice: round(price, 4),
        marketValue: round(marketValue),
        costBasis: round(costBasis),
        unrealizedPnl: round(marketValue - costBasis),
        unrealizedPnlPct: round(((price - p.avgPrice) / p.avgPrice) * 100, 2),
      };
    });
  }

  async getPosition(symbol) {
    const all = await this.getPositions();
    return all.find((p) => p.symbol === symbol) ?? null;
  }

  #recordTrade(trade) {
    const entry = { id: crypto.randomUUID(), ...trade };
    this.#state.trades.unshift(entry);
    if (this.#state.trades.length > 1000) this.#state.trades.length = 1000;
    return entry;
  }

  async buy({ symbol, quantity, price, currency = this.currency, fxRate = 1, meta = {} }) {
    const s = this.#state;

    if (!(quantity > 0) || !(price > 0)) {
      return { status: 'rejected', reason: 'quantité ou prix invalide' };
    }

    // Le slippage dégrade toujours le prix d'exécution dans le sens du trade.
    const fillPrice = price * (1 + this.slippagePct);
    const gross = quantity * fillPrice * fxRate;
    const fee = gross * this.feePct;
    const totalCost = gross + fee;

    if (totalCost > s.cash + 1e-9) {
      return { status: 'rejected', reason: `liquidités insuffisantes (besoin ${round(totalCost)} ${s.currency}, disponible ${round(s.cash)})` };
    }

    const existing = s.positions[symbol];
    if (existing) {
      const totalQty = existing.quantity + quantity;
      existing.avgPrice = (existing.avgPrice * existing.quantity + fillPrice * quantity) / totalQty;
      existing.quantity = totalQty;
      existing.lastPrice = fillPrice;
      existing.lastFxRate = fxRate;
      existing.updatedAt = nowIso();
    } else {
      s.positions[symbol] = {
        symbol,
        quantity,
        avgPrice: fillPrice,
        currency,
        fxRateAtEntry: fxRate,
        lastPrice: fillPrice,
        lastFxRate: fxRate,
        openedAt: nowIso(),
        updatedAt: nowIso(),
        stopPrice: null,
        takeProfitPrice: null,
      };
    }

    s.cash -= totalCost;
    s.feesPaid += fee;

    const trade = this.#recordTrade({
      timestamp: nowIso(),
      side: 'BUY',
      symbol,
      quantity: round(quantity, 6),
      price: round(fillPrice, 4),
      currency,
      fxRate: round(fxRate, 6),
      notional: round(gross),
      fee: round(fee, 4),
      cashAfter: round(s.cash),
      realizedPnl: 0,
      ...meta,
    });

    await this.#snapshotEquity();
    log.info(`ACHAT ${quantity} ${symbol} @ ${round(fillPrice, 4)} ${currency} (${round(totalCost)} ${s.currency})`);
    return { status: 'filled', trade };
  }

  async sell({ symbol, quantity, price, fxRate = 1, meta = {} }) {
    const s = this.#state;
    const position = s.positions[symbol];

    if (!position) return { status: 'rejected', reason: `aucune position sur ${symbol} (vente à découvert interdite)` };
    if (!(price > 0)) return { status: 'rejected', reason: 'prix invalide' };

    const qty = Math.min(quantity, position.quantity);
    if (!(qty > 0)) return { status: 'rejected', reason: 'quantité invalide' };

    const fillPrice = price * (1 - this.slippagePct);
    const gross = qty * fillPrice * fxRate;
    const fee = gross * this.feePct;
    const proceeds = gross - fee;

    const costBasis = qty * position.avgPrice * (position.fxRateAtEntry ?? 1);
    const realized = proceeds - costBasis;

    s.cash += proceeds;
    s.feesPaid += fee;
    s.realizedPnl += realized;

    position.quantity -= qty;
    position.lastPrice = fillPrice;
    position.lastFxRate = fxRate;
    position.updatedAt = nowIso();
    if (position.quantity <= 1e-9) delete s.positions[symbol];

    const trade = this.#recordTrade({
      timestamp: nowIso(),
      side: 'SELL',
      symbol,
      quantity: round(qty, 6),
      price: round(fillPrice, 4),
      currency: position.currency,
      fxRate: round(fxRate, 6),
      notional: round(gross),
      fee: round(fee, 4),
      cashAfter: round(s.cash),
      realizedPnl: round(realized),
      realizedPnlPct: round((realized / costBasis) * 100, 2),
      ...meta,
    });

    await this.#snapshotEquity();
    log.info(`VENTE ${qty} ${symbol} @ ${round(fillPrice, 4)} → P&L ${round(realized)} ${s.currency}`);
    return { status: 'filled', trade };
  }

  async markToMarket(quotes) {
    let touched = false;
    for (const [symbol, quote] of Object.entries(quotes)) {
      const position = this.#state.positions[symbol];
      if (position && Number.isFinite(quote?.price)) {
        position.lastPrice = quote.price;
        position.lastFxRate = quote.fxRate ?? position.lastFxRate ?? 1;
        touched = true;
      }
    }
    if (touched) await this.#snapshotEquity();
    return this.getAccount();
  }

  async setProtection(symbol, { stopPrice, takeProfitPrice }) {
    const position = this.#state.positions[symbol];
    if (!position) return null;
    if (stopPrice != null) position.stopPrice = round(stopPrice, 4);
    if (takeProfitPrice != null) position.takeProfitPrice = round(takeProfitPrice, 4);
    await this.store.save();
    return position;
  }

  async getTrades(limit = 100) {
    return this.#state.trades.slice(0, limit);
  }

  async getEquityCurve(limit = 500) {
    return this.#state.equityCurve.slice(-limit);
  }

  /** Ajoute un point à la courbe d'équity (max 1 point/minute pour rester lisible). */
  async #snapshotEquity() {
    const s = this.#state;
    const equity = s.cash + this.#positionsValue();
    const point = {
      t: nowIso(),
      equity: round(equity),
      cash: round(s.cash),
      positionsValue: round(this.#positionsValue()),
    };

    const last = s.equityCurve[s.equityCurve.length - 1];
    if (last && Date.parse(point.t) - Date.parse(last.t) < 60_000) {
      s.equityCurve[s.equityCurve.length - 1] = point;
    } else {
      s.equityCurve.push(point);
    }
    if (s.equityCurve.length > 5000) s.equityCurve.splice(0, s.equityCurve.length - 5000);

    await this.store.save();
  }

  /** Remet le portefeuille à zéro (route admin `/api/reset`). */
  async reset() {
    await this.store.reset();
    await this.#snapshotEquity();
    log.warn('Portefeuille papier réinitialisé.');
    return this.getAccount();
  }
}
