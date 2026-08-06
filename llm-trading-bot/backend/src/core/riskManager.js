import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { JsonStore } from '../storage/JsonStore.js';

const log = createLogger('risk');

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Gestionnaire de risque — la seule autorité qui décide de la TAILLE des ordres.
 * Le LLM propose une direction et une conviction ; ce module traduit cela en
 * quantité, puis oppose son veto si une limite est franchie.
 *
 * Garde-fous appliqués :
 *  1. Nombre maximum de positions simultanées
 *  2. Exposition maximale par position (% de l'équity)
 *  3. Ordre minimum (évite d'émietter 100 € en micro-lignes rongées par les frais)
 *  4. Stop-loss / take-profit automatiques, indépendants du LLM
 *  5. Coupe-circuit sur perte journalière
 */
export class RiskManager {
  constructor(limits = config.risk) {
    this.limits = limits;
    this.store = new JsonStore(config.storage.dir, 'risk-state.json', {
      day: today(),
      dayStartEquity: null,
      circuitBreakerTrippedAt: null,
      blockedTradesToday: 0,
    });
  }

  async init(account) {
    await this.store.load();
    await this.#rollDay(account);
    return this;
  }

  async #rollDay(account) {
    const s = this.store.data;
    if (s.day !== today() || s.dayStartEquity == null) {
      s.day = today();
      s.dayStartEquity = account.equity;
      s.circuitBreakerTrippedAt = null;
      s.blockedTradesToday = 0;
      await this.store.save();
      log.info(`Nouvelle journée de trading — équity de référence ${account.equity} ${account.currency}`);
    }
  }

  /**
   * Coupe-circuit : au-delà de MAX_DAILY_LOSS_PCT de perte sur la journée,
   * toute ouverture de position est interdite jusqu'au lendemain.
   * Les sorties (SELL) restent autorisées : on doit toujours pouvoir se protéger.
   */
  async checkCircuitBreaker(account) {
    await this.#rollDay(account);
    const s = this.store.data;
    const reference = s.dayStartEquity || account.equity;
    const drawdown = (reference - account.equity) / reference;

    if (drawdown >= this.limits.maxDailyLossPct) {
      if (!s.circuitBreakerTrippedAt) {
        s.circuitBreakerTrippedAt = new Date().toISOString();
        await this.store.save();
        log.error(
          `COUPE-CIRCUIT déclenché : -${(drawdown * 100).toFixed(2)} % sur la journée (limite ${(this.limits.maxDailyLossPct * 100).toFixed(0)} %). Aucun nouvel achat aujourd'hui.`,
        );
      }
      return { tripped: true, drawdownPct: drawdown * 100, since: s.circuitBreakerTrippedAt };
    }
    return { tripped: false, drawdownPct: drawdown * 100, since: null };
  }

  /**
   * Budget mobilisable sur un actif, exprimé en devise de compte ET en quantité.
   * Ce calcul est injecté dans le prompt : le LLM connaît ainsi ses limites
   * réelles au lieu de proposer des tailles fantaisistes.
   */
  computeBudget({ account, position, price, fxRate, circuitBreaker }) {
    const priceBase = price * fxRate;
    const maxByEquity = account.equity * this.limits.maxPositionPct;
    const alreadyInvested = position ? position.marketValue ?? 0 : 0;
    const headroom = Math.max(0, maxByEquity - alreadyInvested);
    const maxNotionalBase = Math.max(0, Math.min(headroom, account.cash));

    let canBuy = true;
    let blockReason = null;

    if (circuitBreaker?.tripped) {
      canBuy = false;
      blockReason = `coupe-circuit actif (-${circuitBreaker.drawdownPct.toFixed(1)} % aujourd'hui)`;
    } else if (!position && account.positionsCount >= this.limits.maxPositions) {
      canBuy = false;
      blockReason = `nombre maximum de positions atteint (${this.limits.maxPositions})`;
    } else if (maxNotionalBase < this.limits.minOrderValue) {
      canBuy = false;
      blockReason = `budget disponible ${maxNotionalBase.toFixed(2)} ${account.currency} < minimum ${this.limits.minOrderValue}`;
    }

    return {
      maxNotionalBase,
      maxQuantity: priceBase > 0 ? Number((maxNotionalBase / priceBase).toFixed(6)) : 0,
      canBuy,
      blockReason,
    };
  }

  /**
   * Traduit la décision du LLM en ordre exécutable, ou la rejette.
   * @returns {{approved:boolean, quantity:number, reason:string, adjustments:string[]}}
   */
  validate({ decision, account, position, price, fxRate, budget }) {
    const adjustments = [];
    const priceBase = price * fxRate;

    if (decision.action === 'HOLD') {
      return { approved: false, quantity: 0, reason: 'décision HOLD', adjustments };
    }

    if (decision.action === 'SELL') {
      if (!position || position.quantity <= 0) {
        return {
          approved: false,
          quantity: 0,
          reason: 'vente refusée : aucune position détenue (vente à découvert interdite)',
          adjustments,
        };
      }
      // Une conviction faible ne justifie pas de solder toute la ligne d'un coup.
      const fraction = decision.confidence >= 0.7 ? 1 : Math.max(decision.sizePct, 0.5);
      const quantity = Number((position.quantity * Math.min(fraction, 1)).toFixed(6));
      if (fraction < 1) adjustments.push(`sortie partielle ${(fraction * 100).toFixed(0)} % (confiance ${decision.confidence})`);
      return { approved: quantity > 0, quantity, reason: 'vente autorisée', adjustments };
    }

    // --- BUY ---
    if (!budget.canBuy) {
      return { approved: false, quantity: 0, reason: `achat bloqué : ${budget.blockReason}`, adjustments };
    }
    if (decision.confidence < 0.35) {
      return {
        approved: false,
        quantity: 0,
        reason: `achat bloqué : confiance ${decision.confidence} sous le seuil 0.35`,
        adjustments,
      };
    }

    // La conviction module la taille à l'intérieur du budget autorisé.
    const notional = budget.maxNotionalBase * decision.sizePct * (0.5 + decision.confidence / 2);
    if (notional < this.limits.minOrderValue) {
      return {
        approved: false,
        quantity: 0,
        reason: `achat bloqué : notionnel ${notional.toFixed(2)} ${account.currency} sous le minimum ${this.limits.minOrderValue}`,
        adjustments,
      };
    }

    const quantity = Number((notional / priceBase).toFixed(6));
    if (decision.sizePct > 1) adjustments.push('taille demandée > 100 % du budget, ramenée au plafond');
    adjustments.push(`notionnel retenu ${notional.toFixed(2)} ${account.currency} sur ${budget.maxNotionalBase.toFixed(2)} autorisés`);

    return { approved: quantity > 0, quantity, reason: 'achat autorisé', adjustments };
  }

  /** Niveaux de protection posés à l'ouverture, en devise native de l'actif. */
  protectionLevels(entryPrice, decision) {
    const sl = decision?.stopLossPct ?? this.limits.stopLossPct;
    const tp = decision?.takeProfitPct ?? this.limits.takeProfitPct;
    return {
      stopPrice: Number((entryPrice * (1 - sl)).toFixed(4)),
      takeProfitPrice: Number((entryPrice * (1 + tp)).toFixed(4)),
    };
  }

  /**
   * Sorties automatiques, évaluées AVANT toute consultation du LLM.
   * Un stop ne se négocie pas : il s'exécute.
   */
  checkExits(position, price) {
    if (!position || position.quantity <= 0) return null;

    const stop = position.stopPrice ?? position.avgPrice * (1 - this.limits.stopLossPct);
    const target = position.takeProfitPrice ?? position.avgPrice * (1 + this.limits.takeProfitPct);

    if (price <= stop) {
      return { triggered: 'STOP_LOSS', reason: `stop-loss touché : ${price} <= ${stop.toFixed(4)}`, level: stop };
    }
    if (price >= target) {
      return { triggered: 'TAKE_PROFIT', reason: `objectif atteint : ${price} >= ${target.toFixed(4)}`, level: target };
    }
    return null;
  }

  get state() {
    return this.store.data;
  }
}
