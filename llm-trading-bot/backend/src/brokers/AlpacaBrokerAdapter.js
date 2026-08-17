import { BrokerAdapter } from './BrokerAdapter.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { getJson, postJson, request, HttpError } from '../utils/http.js';
import { JsonStore } from '../storage/JsonStore.js';
import { alpacaProvider } from '../data/providers/alpaca.js';
import { executionQuality } from '../data/executionQuality.js';

const log = createLogger('alpaca');

const num = (v) => (v == null ? null : Number(v));
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

/**
 * Broker Alpaca — compte **paper trading** par défaut.
 *
 * Contrairement au PaperBrokerAdapter qui simule tout en interne, celui-ci
 * délègue l'exécution au moteur d'Alpaca : les fills se font au NBBO réel,
 * avec le vrai spread du moment. C'est un simulateur bien plus fidèle que
 * tout ce qu'on pourrait modéliser localement, et il ne coûte rien.
 *
 * Structure de coûts constatée chez Alpaca sur actions US fractionnées :
 *   - commission : 0
 *   - pas de majoration du spread, mais pas d'amélioration de prix non plus
 *     → on paie le spread NBBO plein sur un aller-retour
 *   - frais réglementaires à la VENTE uniquement (SEC ~20,60 $/M, FINRA TAF
 *     0,000119 $/action) : de l'ordre de 0,03 bps sur une position de 33 $
 *
 * ⚠️ `isLive` devient vrai si l'URL ne pointe plus vers paper-api. Le moteur
 * et l'API refusent alors certaines opérations destructrices (reset).
 */
export class AlpacaBrokerAdapter extends BrokerAdapter {
  constructor(options = {}) {
    super();
    this.baseUrl = (options.baseUrl ?? config.broker.alpaca.baseUrl).replace(/\/+$/, '');
    this.dataUrl = (options.dataUrl ?? config.broker.alpaca.dataUrl).replace(/\/+$/, '');
    this.keyId = options.keyId ?? config.broker.alpaca.keyId;
    this.secretKey = options.secretKey ?? config.broker.alpaca.secretKey;
    this.feed = options.feed ?? config.universe.feed;

    // Alpaca ne fournit pas d'historique d'équity exploitable sur un compte
    // neuf : on tient notre propre courbe, et le journal des protections
    // (stop/objectif) qui n'existent pas côté broker tant qu'on n'utilise
    // pas d'ordres bracket.
    this.store = new JsonStore(config.storage.dir, 'alpaca-state.json', {
      equityCurve: [],
      protections: {},
      initialCapital: null,
    });
  }

  get name() {
    return 'alpaca';
  }

  /** Vrai uniquement si on ne pointe plus vers l'endpoint paper. */
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

    await this.store.load();
    const account = await getJson(`${this.baseUrl}/v2/account`, { headers: this.#headers() });

    if (account.trading_blocked) throw new Error('Compte Alpaca bloqué au trading.');
    if (account.account_blocked) throw new Error('Compte Alpaca bloqué.');

    // Le capital initial est figé au premier démarrage : sans ça, le P&L
    // global se réinitialiserait à chaque redémarrage du serveur.
    if (this.store.data.initialCapital == null) {
      this.store.data.initialCapital = num(account.equity);
      await this.store.save();
    }

    this.shortingEnabled = Boolean(account.shorting_enabled);
    log.warn(
      `Broker ${this.isLive ? '🔴 RÉEL' : '🟢 paper'} connecté — équity ${account.equity} ${account.currency}` +
        `, vente à découvert ${this.shortingEnabled ? 'activée' : 'désactivée'}`,
    );

    await this.#snapshotEquity(num(account.equity), num(account.cash));
    return this;
  }

  async getAccount() {
    const a = await getJson(`${this.baseUrl}/v2/account`, { headers: this.#headers() });
    const positions = await this.getPositions();

    const equity = num(a.equity);
    const positionsValue = positions.reduce((s, p) => s + p.marketValue, 0);
    const unrealized = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const initial = this.store.data.initialCapital ?? config.risk.initialCapital;

    return {
      broker: this.name,
      isLive: this.isLive,
      currency: a.currency,
      cash: round(num(a.cash)),
      positionsValue: round(positionsValue),
      equity: round(equity),
      positionsCount: positions.length,
      initialCapital: round(initial),
      // Alpaca ne renvoie pas de P&L réalisé cumulé : on le déduit.
      realizedPnl: round(equity - initial - unrealized),
      unrealizedPnl: round(unrealized),
      totalPnl: round(equity - initial),
      totalPnlPct: round(initial ? ((equity - initial) / initial) * 100 : 0, 2),
      feesPaid: 0,
      buyingPower: round(num(a.buying_power)),
      shortingEnabled: this.shortingEnabled ?? false,
      daytradeCount: num(a.daytrade_count),
    };
  }

  async getPositions() {
    let raw;
    try {
      raw = await getJson(`${this.baseUrl}/v2/positions`, { headers: this.#headers() });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return [];
      throw err;
    }

    const protections = this.store.data.protections || {};
    return (raw || []).map((p) => {
      const prot = protections[p.symbol] || {};
      return {
        symbol: p.symbol,
        quantity: num(p.qty),
        avgPrice: round(num(p.avg_entry_price), 4),
        lastPrice: round(num(p.current_price), 4),
        currency: 'USD',
        marketValue: round(num(p.market_value)),
        costBasis: round(num(p.cost_basis)),
        unrealizedPnl: round(num(p.unrealized_pl)),
        unrealizedPnlPct: round(num(p.unrealized_plpc) * 100, 2),
        openedAt: prot.openedAt ?? null,
        stopPrice: prot.stopPrice ?? null,
        takeProfitPrice: prot.takeProfitPrice ?? null,
      };
    });
  }

  async getPosition(symbol) {
    return (await this.getPositions()).find((p) => p.symbol === symbol) ?? null;
  }

  /**
   * Soumet un ordre et attend son exécution.
   *
   * On utilise des ordres **notionnels** (en dollars) plutôt qu'en quantité :
   * c'est le seul moyen fiable d'acheter une fraction sans se heurter aux
   * arrondis, et ça garantit qu'on ne dépasse jamais le budget autorisé.
   */
  async #submitOrder({ symbol, notional, quantity, side }) {
    // Cotation capturée JUSTE AVANT la soumission. C'est la seule référence
    // valable pour mesurer la qualité d'exécution : la reprendre après le fill
    // comparerait le prix obtenu à un marché qui a déjà bougé.
    let quoteAtSubmit = null;
    try {
      quoteAtSubmit = await alpacaProvider.getQuote(symbol);
    } catch {
      // Une cotation manquante ne doit jamais empêcher un ordre : on perd la
      // mesure, pas la décision.
    }

    const payload = {
      symbol,
      side: side.toLowerCase(),
      type: 'market',
      time_in_force: 'day',
      ...(notional != null ? { notional: notional.toFixed(2) } : { qty: String(quantity) }),
    };

    let order;
    try {
      order = await postJson(`${this.baseUrl}/v2/orders`, payload, { headers: this.#headers(), retries: 0 });
    } catch (err) {
      const reason = err instanceof HttpError ? `${err.status} ${err.body}` : err.message;
      log.error(`Ordre ${side} ${symbol} refusé par Alpaca : ${reason}`);
      return { status: 'rejected', reason: `Alpaca a refusé l'ordre : ${reason}` };
    }

    const filled = await this.#awaitFill(order.id);
    if (!filled) {
      return { status: 'rejected', reason: `ordre ${order.id} non exécuté dans le délai imparti` };
    }

    const price = num(filled.filled_avg_price);
    const qty = num(filled.filled_qty);
    const trade = {
      id: filled.id,
      timestamp: filled.filled_at || new Date().toISOString(),
      side: side.toUpperCase(),
      symbol,
      quantity: round(qty, 9),
      price: round(price, 4),
      currency: 'USD',
      fxRate: 1,
      notional: round(qty * price),
      fee: 0,
      realizedPnl: 0,
      brokerOrderId: filled.id,
      brokerStatus: filled.status,
    };

    await executionQuality.record({
      symbol,
      side: side.toUpperCase(),
      quote: quoteAtSubmit,
      fillPrice: price,
      quantity: qty,
      orderId: filled.id,
    });

    log.info(`${side.toUpperCase()} ${trade.quantity} ${symbol} @ ${trade.price} → ${trade.notional} $`);
    return { status: 'filled', trade };
  }

  /**
   * Sonde l'ordre jusqu'à son exécution. Un ordre au marché sur une valeur
   * liquide part en quelques centaines de millisecondes, mais hors séance il
   * reste en attente : on abandonne alors proprement plutôt que de bloquer
   * le cycle indéfiniment.
   */
  async #awaitFill(orderId, { timeoutMs = 20000, intervalMs = 700 } = {}) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const order = await getJson(`${this.baseUrl}/v2/orders/${orderId}`, { headers: this.#headers() });

      if (order.status === 'filled') return order;
      if (['canceled', 'expired', 'rejected', 'suspended'].includes(order.status)) {
        log.warn(`Ordre ${orderId} terminé sans exécution : ${order.status}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    // Ordre encore en attente : on l'annule pour ne pas le voir s'exécuter
    // à un prix imprévisible plus tard, hors du contexte de la décision.
    try {
      await request(`${this.baseUrl}/v2/orders/${orderId}`, { method: 'DELETE', headers: this.#headers(), retries: 0 });
      log.warn(`Ordre ${orderId} annulé (non exécuté après ${timeoutMs} ms).`);
    } catch {
      // L'ordre s'est peut-être exécuté entre-temps : sans gravité.
    }
    return null;
  }

  async buy({ symbol, quantity, price, meta = {} }) {
    // On convertit la quantité voulue en montant notionnel : Alpaca gère
    // alors lui-même le fractionnement au centime près.
    const notional = quantity * price;
    if (!(notional > 0)) return { status: 'rejected', reason: 'notionnel invalide' };

    const account = await this.getAccount();
    if (notional > account.cash) {
      return { status: 'rejected', reason: `liquidités insuffisantes (besoin ${notional.toFixed(2)} $, dispo ${account.cash} $)` };
    }

    // ── La date d'ouverture ne s'hérite que d'une position VIVANTE ─────────
    // Cette ligne conservait `openedAt` dès qu'une entrée existait dans l'état
    // local, sans vérifier qu'une position lui correspondait encore chez le
    // courtier. L'intention était bonne — renforcer une ligne ne doit pas
    // rajeunir sa date d'ouverture — mais la condition était fausse.
    //
    // Constaté en production le 17 août : quatre entrées subsistaient pour
    // AVGO, MSFT, AMZN et NVDA, datées du 6 et du 11 août, alors que le compte
    // ne détenait AUCUNE position. Racheter AVGO aurait donné à la nouvelle
    // ligne un âge de onze séances qu'elle n'avait pas.
    //
    // La conséquence est sournoise. `sortiesParRang` interdit de vendre avant
    // 21 séances, et c'est le garde-fou le plus rentable de la stratégie :
    // mesuré sur dix ans, le désactiver fait passer de 140 à 803 achats et
    // détruit le résultat. Un âge surévalué le contourne — silencieusement,
    // et de plus en plus souvent à mesure que les entrées orphelines
    // s'accumulent pour chaque titre déjà négocié.
    //
    // On interroge donc le courtier, qui est la seule source de vérité sur ce
    // qui est réellement détenu. Un appel de plus par achat, dix par jour au
    // maximum.
    const dejaDetenu = await this.getPosition(symbol);
    const ancienne = this.store.data.protections[symbol];
    const heriteLaDate = dejaDetenu?.quantity > 0 && ancienne?.openedAt;

    const result = await this.#submitOrder({ symbol, notional, side: 'buy' });
    if (result.status === 'filled') {
      Object.assign(result.trade, meta);
      this.store.data.protections[symbol] = {
        ...(heriteLaDate ? ancienne : {}),
        openedAt: heriteLaDate ? ancienne.openedAt : new Date().toISOString(),
      };
      await this.store.save();
      await this.#snapshotEquity();
    }
    return result;
  }

  /**
   * Écarte les protections qui ne correspondent à aucune position détenue.
   *
   * Ces entrées orphelines apparaissent quand une ligne se ferme sans passer
   * par `sell()` — sortie partielle dont le résidu disparaît ensuite, clôture
   * manuelle chez le courtier, ou incident. Elles ne gênent pas la lecture des
   * positions, qui part toujours de ce que dit Alpaca ; elles faussaient en
   * revanche la date d'ouverture d'un rachat ultérieur.
   *
   * `buy()` ne s'y fie plus, mais on les retire quand même : un état local qui
   * décrit des positions inexistantes finit toujours par tromper quelqu'un.
   */
  async reconcilierProtections() {
    const vivantes = new Set((await this.getPositions()).map((p) => p.symbol));
    const orphelines = Object.keys(this.store.data.protections ?? {})
      .filter((s) => !vivantes.has(s));
    if (!orphelines.length) return { retirees: [] };

    for (const s of orphelines) delete this.store.data.protections[s];
    await this.store.save();
    log.info(
      `${orphelines.length} protection(s) orpheline(s) retirée(s) — aucune position correspondante : `
      + orphelines.join(', '),
    );
    return { retirees: orphelines };
  }

  async sell({ symbol, quantity, meta = {} }) {
    const position = await this.getPosition(symbol);
    if (!position) {
      return { status: 'rejected', reason: `aucune position sur ${symbol} (vente à découvert interdite)` };
    }

    const qty = Math.min(quantity, position.quantity);
    if (!(qty > 0)) return { status: 'rejected', reason: 'quantité invalide' };

    // Sortie totale : `DELETE /positions/{symbol}` évite les résidus de
    // fraction qu'un arrondi de quantité laisserait derrière lui.
    const isFullExit = qty >= position.quantity - 1e-9;
    const result = isFullExit
      ? await this.#closePosition(symbol)
      : await this.#submitOrder({ symbol, quantity: round(qty, 9), side: 'sell' });

    if (result.status === 'filled') {
      const costBasis = position.avgPrice * qty;
      result.trade.realizedPnl = round(result.trade.notional - costBasis);
      result.trade.realizedPnlPct = round((result.trade.realizedPnl / costBasis) * 100, 2);
      Object.assign(result.trade, meta);

      if (isFullExit) delete this.store.data.protections[symbol];
      await this.store.save();
      await this.#snapshotEquity();
    }
    return result;
  }

  async #closePosition(symbol) {
    let order;
    try {
      order = await getJson(`${this.baseUrl}/v2/positions/${symbol}`, {
        method: 'DELETE',
        headers: this.#headers(),
        retries: 0,
      });
    } catch (err) {
      const reason = err instanceof HttpError ? `${err.status} ${err.body}` : err.message;
      return { status: 'rejected', reason: `clôture refusée : ${reason}` };
    }

    const filled = await this.#awaitFill(order.id);
    if (!filled) return { status: 'rejected', reason: 'clôture non exécutée dans le délai imparti' };

    const price = num(filled.filled_avg_price);
    const qty = num(filled.filled_qty);
    return {
      status: 'filled',
      trade: {
        id: filled.id,
        timestamp: filled.filled_at || new Date().toISOString(),
        side: 'SELL',
        symbol,
        quantity: round(qty, 9),
        price: round(price, 4),
        currency: 'USD',
        fxRate: 1,
        notional: round(qty * price),
        fee: 0,
        brokerOrderId: filled.id,
        brokerStatus: filled.status,
      },
    };
  }

  /** La valorisation est faite par Alpaca : on ne fait qu'archiver un point. */
  async markToMarket() {
    await this.#snapshotEquity();
    return this.getAccount();
  }

  /**
   * Stop et objectif sont tenus côté bot, pas côté broker.
   * Un ordre stop réel chez Alpaca resterait actif entre deux cycles, ce qui
   * retirerait au gestionnaire de risque la possibilité de le recalculer sur
   * l'ATR courant. On le vérifie donc à chaque cycle, en mémoire.
   */
  async setProtection(symbol, { stopPrice, takeProfitPrice }) {
    const current = this.store.data.protections[symbol] || {};
    this.store.data.protections[symbol] = {
      ...current,
      openedAt: current.openedAt ?? new Date().toISOString(),
      ...(stopPrice != null ? { stopPrice: round(stopPrice, 4) } : {}),
      ...(takeProfitPrice != null ? { takeProfitPrice: round(takeProfitPrice, 4) } : {}),
    };
    await this.store.save();
    return this.store.data.protections[symbol];
  }

  async getTrades(limit = 100) {
    const qs = new URLSearchParams({ status: 'closed', limit: String(Math.min(limit, 500)), direction: 'desc' });
    const orders = await getJson(`${this.baseUrl}/v2/orders?${qs}`, { headers: this.#headers() });

    return (orders || [])
      .filter((o) => o.status === 'filled')
      .map((o) => {
        const price = num(o.filled_avg_price);
        const qty = num(o.filled_qty);
        return {
          id: o.id,
          timestamp: o.filled_at,
          side: o.side.toUpperCase(),
          symbol: o.symbol,
          quantity: round(qty, 9),
          price: round(price, 4),
          currency: 'USD',
          notional: round(qty * price),
          fee: 0,
          realizedPnl: 0,
          source: 'alpaca',
        };
      });
  }

  async getEquityCurve(limit = 500) {
    return this.store.data.equityCurve.slice(-limit);
  }

  /** Un point par minute au maximum, pour garder une courbe lisible. */
  async #snapshotEquity(equityHint, cashHint) {
    let equity = equityHint;
    let cash = cashHint;

    if (equity == null) {
      const a = await getJson(`${this.baseUrl}/v2/account`, { headers: this.#headers() });
      equity = num(a.equity);
      cash = num(a.cash);
    }

    const point = {
      t: new Date().toISOString(),
      equity: round(equity),
      cash: round(cash),
      positionsValue: round(equity - cash),
    };

    const curve = this.store.data.equityCurve;
    const last = curve[curve.length - 1];
    if (last && Date.parse(point.t) - Date.parse(last.t) < 60_000) curve[curve.length - 1] = point;
    else curve.push(point);
    if (curve.length > 5000) curve.splice(0, curve.length - 5000);

    await this.store.save();
  }

  /** Remet le compte paper à plat : ferme tout et purge l'état local. */
  async reset() {
    if (this.isLive) throw new Error('Reset interdit sur un compte réel.');

    try {
      await request(`${this.baseUrl}/v2/positions?cancel_orders=true`, {
        method: 'DELETE',
        headers: this.#headers(),
        retries: 0,
      });
    } catch (err) {
      log.warn(`Clôture globale : ${err.message}`);
    }

    await this.store.reset();
    const account = await this.getAccount();
    this.store.data.initialCapital = account.equity;
    await this.store.save();
    log.warn('État Alpaca réinitialisé (positions closes, courbe purgée).');
    return this.getAccount();
  }
}
