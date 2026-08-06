/**
 * Contrat commun à tous les brokers (Adapter Pattern).
 *
 * Le moteur de trading (`core/engine.js`) ne connaît QUE cette interface : il
 * ignore totalement s'il pilote un portefeuille fictif ou un vrai compte titres.
 * Ajouter un courtier réel = créer une classe qui étend `BrokerAdapter` et
 * implémente ces méthodes, puis l'enregistrer dans `brokers/index.js`.
 *
 * Conventions :
 * - Les montants monétaires exposés (cash, equity, valeurs) sont TOUJOURS dans la
 *   devise de compte (`BASE_CURRENCY`).
 * - Les prix passés à buy()/sell() sont dans la devise NATIVE de l'instrument,
 *   accompagnés du taux de change `fxRate` (natif → devise de compte).
 */
export class BrokerAdapter {
  /** @returns {string} identifiant lisible du broker */
  get name() {
    return 'abstract';
  }

  /** Vrai si les ordres partent sur un marché réel : sert aux garde-fous et à l'UI. */
  get isLive() {
    return false;
  }

  /** Chargement de l'état / ouverture de session courtier. */
  async init() {
    throw new Error('init() non implémenté');
  }

  /**
   * @returns {Promise<{currency, cash, equity, positionsValue, positionsCount,
   *                    initialCapital, realizedPnl, unrealizedPnl, totalPnl, totalPnlPct}>}
   */
  async getAccount() {
    throw new Error('getAccount() non implémenté');
  }

  /** @returns {Promise<Array<Position>>} */
  async getPositions() {
    throw new Error('getPositions() non implémenté');
  }

  /** @returns {Promise<Position|null>} */
  async getPosition(_symbol) {
    throw new Error('getPosition() non implémenté');
  }

  /**
   * @param {{symbol, quantity, price, currency, fxRate, meta}} order
   * @returns {Promise<{status:'filled'|'rejected', trade?, reason?}>}
   */
  async buy(_order) {
    throw new Error('buy() non implémenté');
  }

  /** Même signature que buy(). Ne peut vendre que ce qui est détenu (pas de short). */
  async sell(_order) {
    throw new Error('sell() non implémenté');
  }

  /**
   * Réévalue les positions avec les prix courants.
   * @param {Record<string,{price:number, fxRate:number}>} quotes
   */
  async markToMarket(_quotes) {
    throw new Error('markToMarket() non implémenté');
  }

  /** Attache un stop-loss / take-profit à une position existante. */
  async setProtection(_symbol, _levels) {
    throw new Error('setProtection() non implémenté');
  }

  /** @returns {Promise<Array<Trade>>} historique, du plus récent au plus ancien */
  async getTrades(_limit) {
    throw new Error('getTrades() non implémenté');
  }

  /** Courbe d'équity pour le dashboard. */
  async getEquityCurve(_limit) {
    throw new Error('getEquityCurve() non implémenté');
  }
}
