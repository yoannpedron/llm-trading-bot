import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Le test qui manquait, et son absence a coûté cher.
 *
 * 337 tests couvraient chaque pièce du moteur — classement, combinaison,
 * filtres, dimensionnement — et AUCUN n'exécutait un cycle. Résultat : une
 * variable utilisée 83 lignes avant sa déclaration a traversé tous les tests
 * sans être vue. Le bot aurait planté au premier cycle réel, avec un
 * `ReferenceError` que rien n'annonçait.
 *
 * Un test unitaire vérifie qu'une pièce fonctionne. Seul un test de bout en
 * bout vérifie qu'elles sont branchées dans le bon ordre.
 */

const TMP = path.join(os.tmpdir(), `bot-cycle-${Date.now()}`);
process.env.DATA_DIR = TMP;
process.env.GEMINI_API_KEY = '';
process.env.LLM_PROVIDER = 'heuristic';
process.env.ONLY_MARKET_HOURS = 'false';
process.env.LLM_COOLDOWN_MS = '0';
process.env.SYMBOLS = Array.from({ length: 40 }, (_, i) => `T${i}`).join(',');
process.env.RANKING_TIRAGES_BOOTSTRAP = '30';

const { config } = await import('../src/config.js');
const { RiskManager } = await import('../src/core/riskManager.js');

const symbols = config.universe.symbols;

/** Instantané déterministe : aucun appel réseau, aucune dépendance à l'heure. */
function snapshotFactice(symbol) {
  const i = symbols.indexOf(symbol);
  const base = 50 + (i >= 0 ? i : 99);
  return {
    symbol,
    currency: 'USD',
    candles: bougies(base, 0.2 + (i % 7) * 0.03),
    recentCandles: [],
    indicators: {
      price: base, rsi14: 40 + (i % 40), atr14: base * 0.02, atrPct: 2,
      ema20: base, ema50: base * 0.99, sma200: base * 0.95, trend: 'haussière',
    },
  };
}

// Les modules ES sont figés : on ne peut pas réassigner leurs exports. Le
// remplacement doit donc intervenir AVANT le chargement du moteur.
mock.module('../src/data/marketData.js', {
  namedExports: {
    getMarketSnapshot: async (symbol) => snapshotFactice(symbol),
    getQuote: async (symbol) => {
      const i = symbols.indexOf(symbol);
      const base = 50 + (i >= 0 ? i : 99);
      return { price: base, bid: base * 0.9999, ask: base * 1.0001, spreadBps: 2 };
    },
    isTradeable: async () => ({ open: true, reason: 'ouvert' }),
    getMarketClock: async () => ({ isOpen: true }),
    getPrice: async () => 50,
    getFxRate: async () => 1,
    toBaseCurrency: async (v) => v,
  },
});

mock.module('../src/news/newsService.js', {
  namedExports: { getNews: async () => ({ articles: [], degraded: true, errors: [] }) },
});

mock.module('../src/data/earnings.js', {
  namedExports: {
    filtrerResultats: async (syms) => ({
      eligibles: syms, exclus: new Map(), calendrierDisponible: true, protectionAbsente: false,
    }),
    chargerCalendrier: async () => ({ ok: true, dates: new Map() }),
    fenetreResultats: () => ({ exclu: false, raison: 'test' }),
    SEANCES_AVANT: 5,
    SEANCES_APRES: 1,
  },
});

// La fenêtre d'exécution est forcée ouverte : le test ne doit pas dépendre de
// l'heure à laquelle on le lance.
const executionReel = await import('../src/core/execution.js');
mock.module('../src/core/execution.js', {
  namedExports: {
    ...executionReel,
    fenetreExecution: () => ({ ouverte: true, heureET: '12:00', fenetre: '11:00–14:00 ET', raison: 'test' }),
  },
});

const { TradingEngine } = await import('../src/core/engine.js');

/** Bougies synthétiques déterministes. */
function bougies(base, derive, n = 260) {
  return Array.from({ length: n }, (_, i) => {
    const c = base * (1 + derive * (i / n)) * (1 + 0.01 * Math.sin(i));
    return { t: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, time: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, open: c, high: c * 1.01, low: c * 0.99, close: c };
  });
}

/** Courtier en mémoire, réduit au strict nécessaire. */
class BrokerFactice {
  constructor() {
    this.name = 'factice'; this.isLive = false;
    this.cash = 100; this.positions = new Map(); this.ordres = [];
  }

  async getAccount() {
    const investi = [...this.positions.values()].reduce((s, p) => s + p.marketValue, 0);
    return { equity: this.cash + investi, cash: this.cash, currency: 'USD', positionsCount: this.positions.size };
  }

  async getPositions() { return [...this.positions.values()]; }
  async getPosition(symbol) { return this.positions.get(symbol) ?? null; }
  async markToMarket() {}

  async buy({ symbol, quantity, price }) {
    const notional = quantity * price;
    if (notional > this.cash) return { status: 'rejected', reason: 'cash insuffisant' };
    this.cash -= notional;
    this.positions.set(symbol, {
      symbol, quantity, avgPrice: price, marketValue: notional,
      openedAt: new Date().toISOString(), stopPrice: null,
    });
    this.ordres.push({ side: 'buy', symbol, quantity, price });
    return { status: 'filled', trade: { symbol, quantity, price } };
  }

  async sell({ symbol, quantity, price }) {
    this.cash += quantity * price;
    this.positions.delete(symbol);
    this.ordres.push({ side: 'sell', symbol, quantity, price });
    return { status: 'filled', trade: { symbol, quantity, price } };
  }

  async setProtection(symbol, levels) {
    const p = this.positions.get(symbol);
    if (p) p.stopPrice = levels.stopPrice;
  }

  async getTrades() { return this.ordres; }
  async getEquityCurve() { return []; }
}

const journalFactice = {
  lastCycleAt: null,
  entrees: [],
  cycles: [],
  async record(e) { this.entrees.push(e); },
  async recordCycle(c) { this.cycles.push(c); this.lastCycleAt = new Date().toISOString(); },
};

describe('cycle complet — les pièces sont-elles branchées dans le bon ordre ?', () => {
  let moteur; let broker; let resultat;

  before(async () => {
    await fs.mkdir(TMP, { recursive: true });

    broker = new BrokerFactice();
    moteur = new TradingEngine({
      broker,
      risk: new RiskManager(config.risk),
      journal: journalFactice,
    });

    resultat = await moteur.runCycle({ trigger: 'test' });
  });

  after(async () => {
    await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
  });

  test('le cycle se termine SANS erreur', () => {
    // C'est précisément ce qu'aucun test ne vérifiait. Une variable utilisée
    // avant sa déclaration passait tous les tests unitaires et faisait planter
    // le premier cycle réel.
    assert.equal(resultat?.error, undefined, `le cycle a échoué : ${resultat?.error}`);
    assert.notEqual(resultat?.skipped, true, 'le cycle ne doit pas être ignoré');
  });

  test('un classement a bien été produit', () => {
    const r = moteur.lastRanking;
    assert.ok(r, 'lastRanking doit être renseigné');
    assert.ok(r.classement?.length > 0, 'le classement ne doit pas être vide');
  });

  test('la combinaison des signaux a bien piloté la décision', () => {
    const c = moteur.lastRanking?.combinaison;
    assert.ok(c, 'les diagnostics de combinaison doivent être publiés');
    assert.ok(Number.isFinite(c.entropieDiversite), 'l\'entropie doit être calculée');
  });

  test('le classement ne contient AUCUN ex æquo', () => {
    // Le défaut d'origine : 50 actifs partageant la même note, départagés par
    // l'ordre du fichier de configuration.
    const edges = moteur.lastRanking.classement.map((r) => r.edge).filter(Number.isFinite);
    assert.equal(new Set(edges.map((v) => v.toFixed(9))).size, edges.length);
  });

  test('des ordres d\'achat ont réellement été passés', () => {
    // L'autre défaut trouvé aujourd'hui : le moteur classait parfaitement puis
    // n'achetait jamais, faute de promouvoir la sélection en BUY.
    const achats = broker.ordres.filter((o) => o.side === 'buy');
    assert.ok(achats.length > 0, 'aucun achat exécuté alors que le classement a abouti');
  });

  test('le nombre de positions respecte le plafond', () => {
    assert.ok(broker.positions.size <= config.risk.maxPositions);
  });

  test('chaque ligne pèse environ l\'enveloppe prévue', () => {
    const attendu = 100 * config.risk.maxPositionPct;
    for (const p of broker.positions.values()) {
      assert.ok(
        p.marketValue <= attendu * 1.05 + 0.01,
        `${p.symbol} pèse ${p.marketValue.toFixed(2)} pour une enveloppe de ${attendu.toFixed(2)}`,
      );
    }
  });

  test('un coupe-circuit est posé sur chaque position ouverte', () => {
    for (const p of broker.positions.values()) {
      assert.ok(Number.isFinite(p.stopPrice), `${p.symbol} sans protection`);
      const distance = (p.avgPrice - p.stopPrice) / p.avgPrice;
      assert.ok(distance > 0.2, `stop trop proche : ${(distance * 100).toFixed(1)} %`);
    }
  });

  test('tout est consigné, y compris les non-décisions', () => {
    assert.ok(journalFactice.entrees.length > 0, 'le journal doit contenir des entrées');
  });

  test('le cycle est rejouable sans effet de bord', async () => {
    const second = await moteur.runCycle({ trigger: 'test' });
    assert.equal(second?.error, undefined, `le second cycle a échoué : ${second?.error}`);
    // Les positions déjà tenues ne doivent pas être rachetées : la cible est
    // atteinte, l'écart à combler vaut zéro.
    assert.ok(broker.positions.size <= config.risk.maxPositions);
  });
});
