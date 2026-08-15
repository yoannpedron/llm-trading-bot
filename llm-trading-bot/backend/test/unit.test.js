import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isole les tests du portefeuille réel : DATA_DIR doit être défini AVANT
// l'import de config.js (lu une seule fois au chargement du module).
const TMP_DIR = path.join(os.tmpdir(), `bot-test-${Date.now()}`);
process.env.DATA_DIR = TMP_DIR;
process.env.INITIAL_CAPITAL = '100';
process.env.BASE_CURRENCY = 'EUR';
process.env.FEE_PCT = '0.001';
process.env.SLIPPAGE_PCT = '0';
process.env.LLM_CALLS_PER_KEY_PER_DAY = '3';
process.env.GEMINI_API_KEYS = 'clef-de-test-numero-un-aaaaaa,clef-de-test-numero-deux-bbbbb';
// dotenv n'écrase pas une variable déjà définie : en la déclarant vide ici, le
// `.env` du développeur ne peut pas injecter sa vraie clé dans les tests.
process.env.GEMINI_API_KEY = '';
process.env.SYMBOLS = 'TSLA,AAPL';

const { rsi, ema, sma, macd, atr, computeIndicators } = await import('../src/data/indicators.js');
const { PaperBrokerAdapter } = await import('../src/brokers/PaperBrokerAdapter.js');
const { RiskManager } = await import('../src/core/riskManager.js');
const { normalizeDecision, normalizeForecast, deriveAction } = await import('../src/llm/agent.js');
const { parseRss } = await import('../src/news/providers/rss.js');
const { keyPool, recommendCron } = await import('../src/llm/keyPool.js');

after(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

describe('indicateurs techniques', () => {
  test('SMA calcule la moyenne glissante', () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    assert.equal(out[0], null);
    assert.equal(out[2], 2);
    assert.equal(out[4], 4);
  });

  test('EMA démarre sur la SMA et suit le prix', () => {
    const out = ema([1, 2, 3, 4, 5, 6], 3);
    assert.equal(out[1], null);
    assert.equal(out[2], 2);
    assert.ok(out[5] > out[2]);
  });

  test('RSI vaut 100 sur une série strictement haussière', () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 + i);
    const out = rsi(values, 14);
    assert.equal(out[29], 100);
  });

  test('RSI vaut 0 sur une série strictement baissière', () => {
    const values = Array.from({ length: 30 }, (_, i) => 200 - i);
    const out = rsi(values, 14);
    assert.equal(out[29], 0);
  });

  test('RSI reste borné entre 0 et 100 sur une série bruitée', () => {
    const values = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 3) * 10 + i * 0.1);
    for (const v of rsi(values, 14).filter((x) => x != null)) {
      assert.ok(v >= 0 && v <= 100, `RSI hors bornes : ${v}`);
    }
  });

  test('MACD aligne ligne, signal et histogramme sur la longueur d\'entrée', () => {
    const values = Array.from({ length: 100 }, (_, i) => 100 + i * 0.5);
    const { line, signal, histogram } = macd(values);
    assert.equal(line.length, 100);
    assert.equal(signal.length, 100);
    assert.equal(histogram.length, 100);
    const i = 99;
    assert.ok(Math.abs(histogram[i] - (line[i] - signal[i])) < 1e-9);
  });

  test('ATR est positif et croît avec l\'amplitude', () => {
    const candles = Array.from({ length: 40 }, (_, i) => ({
      open: 100, high: 105 + i, low: 95 - i, close: 100, volume: 1000,
    }));
    const out = atr(candles, 14);
    assert.ok(out[39] > 0);
    assert.ok(out[39] > out[20]);
  });

  test('computeIndicators produit le paquet attendu par le prompt', () => {
    const candles = Array.from({ length: 250 }, (_, i) => {
      const close = 100 + Math.sin(i / 8) * 5 + i * 0.05;
      return { time: new Date(Date.now() - (250 - i) * 3600_000).toISOString(), open: close - 0.3, high: close + 1, low: close - 1, close, volume: 10_000 + i };
    });
    const ind = computeIndicators(candles);
    for (const key of ['price', 'rsi14', 'macd', 'ema20', 'ema50', 'sma200', 'bollinger', 'atr14', 'trend', 'change', 'support', 'resistance']) {
      assert.ok(key in ind, `clé manquante : ${key}`);
    }
    assert.ok(ind.rsi14 >= 0 && ind.rsi14 <= 100);
    assert.ok(['bullish_cross', 'bearish_cross', 'above_signal', 'below_signal', 'unknown'].includes(ind.macd.crossover));
    assert.ok(ind.support <= ind.resistance);
  });
});

describe('PaperBrokerAdapter', () => {
  let broker;

  before(async () => {
    broker = await new PaperBrokerAdapter({ feePct: 0.001, slippagePct: 0, initialCapital: 100 }).init();
    await broker.reset();
  });

  test('démarre avec le capital initial en liquidités', async () => {
    const account = await broker.getAccount();
    assert.equal(account.cash, 100);
    assert.equal(account.equity, 100);
    assert.equal(account.positionsCount, 0);
  });

  test('un achat débite les liquidités frais compris', async () => {
    const res = await broker.buy({ symbol: 'TEST', quantity: 2, price: 10, currency: 'EUR', fxRate: 1 });
    assert.equal(res.status, 'filled');
    const account = await broker.getAccount();
    // 2 × 10 = 20 € + 0,1 % de frais = 20,02 €
    assert.equal(account.cash, 79.98);
    assert.equal(account.positionsCount, 1);
  });

  test('convertit une position en devise étrangère au taux fourni', async () => {
    await broker.buy({ symbol: 'USDX', quantity: 1, price: 10, currency: 'USD', fxRate: 0.9 });
    const position = await broker.getPosition('USDX');
    // 1 × 10 USD × 0,9 = 9 € de valeur de marché
    assert.equal(position.marketValue, 9);
  });

  test('refuse un achat au-delà des liquidités', async () => {
    const res = await broker.buy({ symbol: 'TEST', quantity: 1000, price: 10, currency: 'EUR', fxRate: 1 });
    assert.equal(res.status, 'rejected');
    assert.match(res.reason, /liquidités insuffisantes/);
  });

  test('refuse la vente à découvert', async () => {
    const res = await broker.sell({ symbol: 'INCONNU', quantity: 1, price: 10, fxRate: 1 });
    assert.equal(res.status, 'rejected');
    assert.match(res.reason, /aucune position/);
  });

  test('une vente réalise le P&L et solde la ligne', async () => {
    const before = await broker.getAccount();
    const res = await broker.sell({ symbol: 'TEST', quantity: 2, price: 15, fxRate: 1 });
    assert.equal(res.status, 'filled');
    assert.ok(res.trade.realizedPnl > 0, 'la plus-value doit être positive');
    const after = await broker.getAccount();
    assert.ok(after.cash > before.cash);
    assert.equal(await broker.getPosition('TEST'), null);
  });

  test('le prix moyen est pondéré sur un renforcement', async () => {
    await broker.buy({ symbol: 'AVG', quantity: 1, price: 10, currency: 'EUR', fxRate: 1 });
    await broker.buy({ symbol: 'AVG', quantity: 3, price: 20, currency: 'EUR', fxRate: 1 });
    const position = await broker.getPosition('AVG');
    assert.equal(position.quantity, 4);
    assert.equal(position.avgPrice, 17.5); // (10 + 60) / 4
  });

  test('markToMarket met à jour la valorisation latente', async () => {
    await broker.markToMarket({ AVG: { price: 25, fxRate: 1 } });
    const position = await broker.getPosition('AVG');
    assert.equal(position.lastPrice, 25);
    assert.ok(position.unrealizedPnl > 0);
  });

  test('l\'état survit à un rechargement depuis le disque', async () => {
    const reloaded = await new PaperBrokerAdapter({ initialCapital: 100 }).init();
    const position = await reloaded.getPosition('AVG');
    assert.ok(position, 'la position doit être relue depuis le fichier');
    assert.equal(position.quantity, 4);
  });
});

describe('RiskManager', () => {
  const account = { equity: 100, cash: 100, currency: 'EUR', positionsCount: 0 };
  const risk = new RiskManager({
    baseCurrency: 'USD', initialCapital: 100, maxPositions: 3, maxPositionPct: 0.35,
    minOrderValue: 5, maxDailyLossPct: 0.1,
    stopAtrMultiple: 4, stopMinPct: 0.08, stopMaxPct: 0.2,
  });

  test('le budget respecte le plafond par position', () => {
    const budget = risk.computeBudget({ account, position: null, price: 10, fxRate: 1, circuitBreaker: { tripped: false } });
    assert.equal(budget.maxNotionalBase, 35);
    assert.equal(budget.maxQuantity, 3.5);
    assert.equal(budget.canBuy, true);
  });

  test('le coupe-circuit interdit tout achat', () => {
    const budget = risk.computeBudget({
      account, position: null, price: 10, fxRate: 1,
      circuitBreaker: { tripped: true, drawdownPct: 12 },
    });
    assert.equal(budget.canBuy, false);
    assert.match(budget.blockReason, /coupe-circuit/);
  });

  test('le plafond de positions simultanées bloque une nouvelle ligne', () => {
    const budget = risk.computeBudget({
      account: { ...account, positionsCount: 3 }, position: null, price: 10, fxRate: 1,
      circuitBreaker: { tripped: false },
    });
    assert.equal(budget.canBuy, false);
    assert.match(budget.blockReason, /nombre maximum/);
  });

  test('une probabilité trop faible fait rejeter l\'achat', () => {
    const budget = risk.computeBudget({ account, position: null, price: 10, fxRate: 1, circuitBreaker: { tripped: false } });
    const validation = risk.validate({
      decision: { action: 'BUY', confidence: 0.2, sizePct: 1 },
      account, position: null, price: 10, fxRate: 1, budget,
    });
    assert.equal(validation.approved, false);
    assert.match(validation.reason, /sous le seuil/);
  });

  test('le seuil de probabilité reste actif même si limits est incomplet', () => {
    // `confiance < undefined` vaut toujours faux : sans repli explicite, un
    // objet de limites partiel désactiverait ce garde-fou en silence.
    const partiel = new RiskManager({ maxPositions: 3, maxPositionPct: 0.35, minOrderValue: 5 });
    const budget = { canBuy: true, maxNotionalBase: 35, blockReason: null };
    const v = partiel.validate({
      decision: { action: 'BUY', confidence: 0.1, sizePct: 1 },
      account, position: null, price: 10, fxRate: 1, budget,
    });
    assert.equal(v.approved, false, 'le seuil doit s\'appliquer malgré la limite absente');
  });

  test('la taille ne dépend que de sizePct, pas deux fois de la conviction', () => {
    // sizePct est désormais DÉDUIT de l'écart de probabilité : le multiplier
    // encore par un facteur de confiance appliquerait une conviction au carré.
    const budget = risk.computeBudget({ account, position: null, price: 10, fxRate: 1, circuitBreaker: { tripped: false } });
    const faible = risk.validate({
      decision: { action: 'BUY', confidence: 0.45, sizePct: 0.5 },
      account, position: null, price: 10, fxRate: 1, budget,
    });
    const forte = risk.validate({
      decision: { action: 'BUY', confidence: 0.9, sizePct: 0.5 },
      account, position: null, price: 10, fxRate: 1, budget,
    });
    assert.equal(
      faible.quantity,
      forte.quantity,
      'à sizePct égal, la quantité ne doit pas varier avec la probabilité annoncée',
    );
  });

  test('une vente solde toujours la ligne entière', () => {
    const budget = risk.computeBudget({ account, position: { quantity: 3 }, price: 10, fxRate: 1, circuitBreaker: { tripped: false } });
    const v = risk.validate({
      decision: { action: 'SELL', confidence: 0.41, sizePct: 1 },
      account, position: { quantity: 3 }, price: 10, fxRate: 1, budget,
    });
    assert.equal(v.approved, true);
    assert.equal(v.quantity, 3, 'aucun résidu : un reliquat de quelques dollars ne protège de rien');
  });

  test('un achat validé ne dépasse jamais le budget autorisé', () => {
    const budget = risk.computeBudget({ account, position: null, price: 10, fxRate: 1, circuitBreaker: { tripped: false } });
    const validation = risk.validate({
      decision: { action: 'BUY', confidence: 1, sizePct: 1 },
      account, position: null, price: 10, fxRate: 1, budget,
    });
    assert.equal(validation.approved, true);
    assert.ok(validation.quantity * 10 <= budget.maxNotionalBase + 1e-9);
  });

  test('la vente sans position est refusée', () => {
    const validation = risk.validate({
      decision: { action: 'SELL', confidence: 0.9, sizePct: 1 },
      account, position: null, price: 10, fxRate: 1,
      budget: { canBuy: true, maxNotionalBase: 35 },
    });
    assert.equal(validation.approved, false);
    assert.match(validation.reason, /aucune position/);
  });

  test('une forte conviction solde toute la ligne', () => {
    const validation = risk.validate({
      decision: { action: 'SELL', confidence: 0.9, sizePct: 0.4 },
      account, position: { quantity: 4 }, price: 10, fxRate: 1,
      budget: { canBuy: true, maxNotionalBase: 35 },
    });
    assert.equal(validation.quantity, 4);
  });

  test('le stop se déclenche sous le niveau', () => {
    const exit = risk.checkExits({ quantity: 1, avgPrice: 100, stopPrice: 90 }, 89);
    assert.equal(exit.triggered, 'STOP_LOSS');
  });

  test('aucune sortie au-dessus du stop, même très haut', () => {
    // Plus de take-profit : une position gagnante n'est jamais coupée
    // mécaniquement, pour ne pas tronquer la queue droite de la distribution.
    assert.equal(risk.checkExits({ quantity: 1, avgPrice: 100, stopPrice: 90 }, 150), null);
  });

  test('le stop est dimensionné sur l\'ATR', () => {
    // ATR de 3 $ sur un prix de 100 $ → 4 × 3 = 12 % → dans les bornes [8 %, 20 %]
    const levels = risk.protectionLevels(100, 3);
    assert.equal(levels.stopPct, 0.12);
    assert.equal(levels.stopPrice, 88);
    assert.equal(levels.takeProfitPrice, null);
  });

  test('le stop respecte le plancher sur un actif très calme', () => {
    // ATR de 0,5 $ → 4 × 0,5 = 2 % → relevé au plancher de 8 %
    const levels = risk.protectionLevels(100, 0.5);
    assert.equal(levels.stopPct, 0.08);
    assert.equal(levels.stopPrice, 92);
  });

  test('le stop respecte le plafond sur un actif en crise', () => {
    // ATR de 10 $ → 4 × 10 = 40 % → ramené au plafond de 20 %
    const levels = risk.protectionLevels(100, 10);
    assert.equal(levels.stopPct, 0.2);
    assert.equal(levels.stopPrice, 80);
  });
});

describe('normalisation des décisions LLM', () => {
  // Grille unanime : sans elle le second verrou (≥ 3 critères sur 4) bloque
  // tout achat, indépendamment de la prévision.
  const checks = {
    momentum_favorable: true, trend_favorable: true,
    news_confirms: true, volatility_acceptable: true,
  };

  const base = {
    action: 'BUY',
    checks,
    forecast: { sur_100_surperforme: 65, sur_100_sousperforme: 20, sur_100_indistinct: 15 },
    technical_rationale: 'RSI bas', news_sentiment: 'POSITIF',
    news_rationale: 'bonnes nouvelles',
    justification: 'J\'achète car le RSI est bas ET les actualités sont positives.',
  };

  test('une prévision nettement haussière produit un achat', () => {
    const d = normalizeDecision(base);
    assert.equal(d.action, 'BUY');
    assert.equal(d.confidence, 0.65, 'la confiance est la probabilité annoncée, pas un nombre inventé');
    assert.equal(d.sizePct, 1, 'poids égal — la taille ne traduit plus la conviction');
    assert.deepEqual(d.warnings, []);
  });

  test('un écart sous le seuil produit un HOLD, même si le modèle conseille d\'acheter', () => {
    const d = normalizeDecision({
      ...base,
      forecast: { sur_100_surperforme: 48, sur_100_sousperforme: 42, sur_100_indistinct: 10 },
    });
    assert.equal(d.action, 'HOLD', '6 points d\'écart ne suffisent pas');
    assert.equal(d.advisedAction, 'BUY');
    assert.equal(d.advisoryConflict, true, 'la divergence doit être tracée');
  });

  test('une prévision nettement baissière produit une vente', () => {
    const d = normalizeDecision({
      ...base,
      forecast: { sur_100_surperforme: 15, sur_100_sousperforme: 70, sur_100_indistinct: 15 },
    });
    assert.equal(d.action, 'SELL');
    assert.equal(d.sizePct, 1, 'une sortie est toujours totale');
    assert.equal(d.confidence, 0.7);
  });

  test('une répartition qui ne totalise pas 100 est renormalisée et signalée', () => {
    const d = normalizeDecision({
      ...base,
      forecast: { sur_100_surperforme: 130, sur_100_sousperforme: 40, sur_100_indistinct: 30 },
    });
    assert.equal(d.action, 'BUY');
    assert.equal(d.forecast.pUp, 0.65, '130/200 = 0,65');
    assert.ok(d.warnings.some((w) => /totalisant 200/.test(w)));
  });

  test('la probabilité conditionnelle exclut la bande d\'indécision', () => {
    const d = normalizeDecision({
      ...base,
      forecast: { sur_100_surperforme: 60, sur_100_sousperforme: 20, sur_100_indistinct: 20 },
    });
    // 60 / (60 + 20) = 0,75 : c'est cette valeur qui se confronte au signe du
    // rendement excédentaire dans la mesure de calibration.
    assert.equal(d.forecast.pUpGivenMove, 0.75);
  });

  test('une prévision absente conduit à HOLD sans planter', () => {
    const d = normalizeDecision({ action: 'BUY', checks, justification: 'x' });
    assert.equal(d.action, 'HOLD');
    assert.equal(d.forecast, null);
    assert.ok(d.warnings.some((w) => /prévision absente/.test(w)));
  });

  test('le vocabulaire de la justification ne déclenche plus d\'avertissement', () => {
    // Ce contrôle cherchait des mots-clés d'actualité dans la justification.
    // Mesuré en production : 15 déclenchements sur 35 décisions, et c'était le
    // seul avertissement jamais émis — que des fausses alertes, du type
    // « soutenue par des partenariats solides dans l'IA », qui référence les
    // actualités sans employer les mots cherchés. Un canal d'alerte saturé de
    // bruit entraîne à ignorer les vraies alertes.
    //
    // La question « les actualités servent-elles ? » est tranchée par la
    // segmentation AVEC/SANS actualités du carnet fantôme, pas par un regex.
    const d = normalizeDecision({ ...base, justification: 'Le RSI est bas.' });
    assert.deepEqual(d.warnings, [], 'aucun avertissement sur le seul vocabulaire');
    assert.equal(d.action, 'BUY', 'et la décision reste intacte');
  });

  test('le stop n\'est jamais une sortie du modèle', () => {
    const d = normalizeDecision({ action: 'HOLD', checks, justification: 'rien à faire' });
    assert.equal(d.stopLossPct, undefined);
    assert.equal(d.sizePct, 0);
  });

  test('le pré-mortem est conservé quand il est fourni', () => {
    const d = normalizeDecision({
      ...base,
      pre_mortem: { scenario_defavorable: 'la hausse était un rebond technique', signal_le_plus_fragile: 'le RSI' },
    });
    assert.equal(d.preMortem.scenario, 'la hausse était un rebond technique');
    assert.equal(d.preMortem.weakestSignal, 'le RSI');
  });
});

describe('dérivation de l\'action depuis la prévision', () => {
  const seuils = { minEdge: 0.2, minUpProbability: 0.4 };

  test('la taille NE dépend PAS de l\'écart de probabilité', () => {
    // Ce test affirmait l'inverse. Il a changé de sens avec le passage au poids
    // égal : dimensionner proportionnellement à l'écart revient à faire
    // confiance au NIVEAU des probabilités du modèle, c'est-à-dire à engager le
    // capital maximal exactement là où il est le plus exagérément confiant. Le
    // niveau est justement la propriété qu'on soupçonne fausse ; seul l'ordre
    // est présumé porteur d'information, et l'ordre est traité par le
    // classement transversal, pas ici.
    const petit = deriveAction(normalizeForecast({ sur_100_surperforme: 55, sur_100_sousperforme: 30, sur_100_indistinct: 15 }), seuils);
    const grand = deriveAction(normalizeForecast({ sur_100_surperforme: 85, sur_100_sousperforme: 5, sur_100_indistinct: 10 }), seuils);
    assert.equal(petit.action, 'BUY');
    assert.equal(grand.action, 'BUY');
    assert.equal(grand.sizePct, petit.sizePct, 'poids égal : 65 points d\'écart ne pèsent pas plus que 25');
    assert.equal(grand.sizePct, 1);
    // La probabilité annoncée continue d'être transmise telle quelle : elle
    // reste mesurée, elle n'est simplement plus utilisée pour dimensionner.
    assert.equal(grand.confidence, 0.85);
    assert.equal(petit.confidence, 0.55);
  });

  test('franchir tout juste le seuil engage la même taille que tout le reste', () => {
    const d = deriveAction(normalizeForecast({ sur_100_surperforme: 55, sur_100_sousperforme: 35, sur_100_indistinct: 10 }), seuils);
    assert.equal(d.action, 'BUY');
    assert.equal(d.sizePct, 1, 'plus de plancher à 0,25 : le poids est le même pour tous les retenus');
  });

  test('un écart suffisant mais une probabilité haussière faible reste un HOLD', () => {
    // 38/18/44 : l'écart atteint 20 points, mais le scénario dominant est
    // l'indécision. Agir dessus reviendrait à parier sur une minorité.
    const d = deriveAction(normalizeForecast({ sur_100_surperforme: 38, sur_100_sousperforme: 18, sur_100_indistinct: 44 }), seuils);
    assert.equal(d.action, 'HOLD');
  });

  test('une répartition dégénérée est refusée', () => {
    assert.equal(normalizeForecast({ sur_100_surperforme: 0, sur_100_sousperforme: 0, sur_100_indistinct: 0 }), null);
    assert.equal(normalizeForecast({ sur_100_surperforme: -10, sur_100_sousperforme: 50, sur_100_indistinct: 60 }), null);
    assert.equal(normalizeForecast(null), null);
  });
});

describe('pool de clés LLM', () => {
  before(async () => {
    await keyPool.init();
  });

  test('la capacité cumule le quota de chaque clé', async () => {
    const c = await keyPool.capacity();
    assert.equal(c.keys, 2, '2 clés déclarées dans GEMINI_API_KEYS');
    assert.equal(c.perKeyLimit, 3);
    assert.equal(c.totalPerDay, 6, '2 clés × 3 appels');
    assert.equal(c.callsPerCycle, 2, '2 actifs suivis');
    assert.equal(c.cyclesPerDay, 3, '6 appels / 2 actifs');
  });

  test('la rotation répartit la charge sur la clé la moins utilisée', async () => {
    const first = await keyPool.acquire();
    await keyPool.recordUse(first.id);
    const second = await keyPool.acquire();
    assert.notEqual(second.id, first.id, 'la seconde clé doit être une autre clé');
  });

  test('une clé marquée épuisée n\'est plus proposée', async () => {
    const entry = await keyPool.acquire();
    await keyPool.markExhausted(entry.id, 'test');
    for (let i = 0; i < 5; i += 1) {
      const next = await keyPool.acquire();
      if (!next) break;
      assert.notEqual(next.id, entry.id);
      await keyPool.recordUse(next.id);
    }
  });

  test('acquire() retourne null quand tout est épuisé', async () => {
    for (const key of await keyPool.list()) {
      await keyPool.markExhausted(key.id, 'test');
    }
    assert.equal(await keyPool.acquire(), null);
  });

  test('la liste ne divulgue jamais la clé en clair', async () => {
    for (const key of await keyPool.list()) {
      assert.ok(key.masked.includes('…'), 'la clé doit être masquée');
      assert.equal(key.key, undefined, 'le matériel de clé ne doit pas être exposé');
    }
  });

  test('ajouter une clé augmente la capacité', async () => {
    const before = await keyPool.capacity();
    await keyPool.add('clef-ajoutee-a-chaud-cccccccc', 'test runtime');
    const after = await keyPool.capacity();
    assert.equal(after.keys, before.keys + 1);
    assert.equal(after.totalPerDay, before.totalPerDay + 3);
  });

  test('une clé en double est refusée', async () => {
    await assert.rejects(() => keyPool.add('clef-ajoutee-a-chaud-cccccccc'), /déjà dans le pool/);
  });

  test('une clé trop courte est refusée', async () => {
    await assert.rejects(() => keyPool.add('trop-court'), /trop courte/);
  });

  test('le cron conseillé suit la capacité disponible', () => {
    assert.equal(recommendCron(6), '0 */4 * * *');
    assert.equal(recommendCron(24), '0 * * * *');
    assert.equal(recommendCron(48), '*/30 * * * *');
    assert.equal(recommendCron(Infinity), '*/15 * * * *');
    assert.match(recommendCron(0), /ajoute des clés/);
  });
});

describe('parseur RSS', () => {
  test('extrait titre, lien et date en gérant les CDATA', () => {
    const xml = `<rss><channel>
      <item>
        <title><![CDATA[Tesla beats Q3 estimates]]></title>
        <link>https://example.com/a</link>
        <description>&lt;p&gt;Revenue up 12%&lt;/p&gt;</description>
        <pubDate>Tue, 05 Aug 2025 14:00:00 GMT</pubDate>
      </item>
      <item>
        <title>Apple &amp; suppliers</title>
        <link>https://example.com/b</link>
        <pubDate>Tue, 05 Aug 2025 15:00:00 GMT</pubDate>
      </item>
    </channel></rss>`;

    const items = parseRss(xml, 'Test Feed');
    assert.equal(items.length, 2);
    assert.equal(items[0].title, 'Tesla beats Q3 estimates');
    assert.equal(items[0].summary, 'Revenue up 12%');
    assert.equal(items[0].url, 'https://example.com/a');
    assert.ok(items[0].publishedAt.startsWith('2025-08-05'));
    assert.equal(items[1].title, 'Apple & suppliers');
    assert.equal(items[1].source, 'Test Feed');
  });

  test('retourne un tableau vide sur un flux sans items', () => {
    assert.deepEqual(parseRss('<rss><channel></channel></rss>', 'x'), []);
  });
});

describe('mode dégradé — actualités indisponibles', () => {
  const checks = {
    momentum_favorable: true, trend_favorable: true,
    news_confirms: false, volatility_acceptable: true,
  };
  // Écart de 25 points : suffisant en mode normal, insuffisant sans actualités.
  const base = {
    checks,
    action: 'SELL',
    forecast: { sur_100_surperforme: 30, sur_100_sousperforme: 55, sur_100_indistinct: 15 },
    news_sentiment: 'INDISPONIBLE',
    justification: 'Technique seule, aucune actualité disponible.',
  };

  test('un écart de 25 points déclenche une vente en mode normal', () => {
    const d = normalizeDecision(base, null, { degraded: false });
    assert.equal(d.action, 'SELL');
  });

  test('le même écart ne suffit plus sans actualités', () => {
    // Le modèle penche à la baisse quand l'information manque, au lieu de se
    // resserrer comme le prompt le demande. Une panne de flux RSS ne doit pas
    // suffire à solder une position saine.
    const d = normalizeDecision(base, null, { degraded: true });
    assert.equal(d.action, 'HOLD');
    assert.ok(d.warnings.some((w) => /écart minimal relevé/.test(w)));
  });

  test('un écart franc passe même en mode dégradé', () => {
    const d = normalizeDecision(
      { ...base, forecast: { sur_100_surperforme: 20, sur_100_sousperforme: 70, sur_100_indistinct: 10 } },
      null,
      { degraded: true },
    );
    assert.equal(d.action, 'SELL');
  });

  test('la prévision annoncée reste intacte quel que soit le seuil', () => {
    // Le seuil filtre l'ACTION. Toucher à la probabilité corromprait la mesure
    // de calibration, qui doit juger le modèle et non nos garde-fous.
    const normal = normalizeDecision(base, null, { degraded: false });
    const degrade = normalizeDecision(base, null, { degraded: true });
    assert.deepEqual(normal.forecast, degrade.forecast);
    assert.equal(degrade.forecast.pDown, 0.55);
  });
});

describe('journalisation — une sortie cassée ne doit pas tuer le bot', () => {
  test('des milliers de lignes sur un tuyau fermé ne bouclent pas', () => {
    // Panne réelle : le serveur lancé avec sa sortie dirigée vers un `head` a vu
    // le tuyau se fermer au bout de 60 lignes. Chaque écriture suivante a levé
    // EPIPE ; le gestionnaire d'exception non capturée a voulu journaliser
    // l'erreur — par la même sortie — qui a relevé EPIPE. Récursion infinie,
    // 100 % d'un cœur pendant six minutes, cycle de trading bloqué, aucune
    // décision enregistrée. Le processus répondait toujours à /api/health, ce
    // qui rendait la panne invisible.
    //
    // En production la sortie casse quand journald redémarre ou qu'un
    // `docker logs` est interrompu : le bot doit continuer à trader.
    const enfant = spawnSync(
      process.execPath,
      ['-e', `
        const { createLogger } = await import('./src/logger.js');
        const log = createLogger('t');
        for (let i = 0; i < 20000; i += 1) log.info('ligne ' + i);
        process.exit(0);
      `.replace(/await import/, 'require')],
      { input: '', timeout: 20000, encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'] },
    );
    // stdio 'ignore' ferme la sortie : c'est la même condition que le `head`.
    assert.notEqual(enfant.signal, 'SIGTERM', 'aucun dépassement de délai — donc aucune boucle');
  });

  test('le tampon circulaire survit à la perte de la console', async () => {
    // C'est ce qui rend la panne supportable : /api/logs et le dashboard
    // restent complets même quand plus rien ne sort sur la console. On perd
    // l'affichage, jamais la trace.
    const { createLogger, getRecentLogs } = await import('../src/logger.js');
    const log = createLogger('tampon');
    for (let i = 0; i < 500; i += 1) log.info(`entrée ${i}`);
    const recent = getRecentLogs(300);
    assert.equal(recent.length, 300, 'le tampon garde ses 300 dernières entrées');
    assert.equal(recent[recent.length - 1].message, 'entrée 499', 'et la plus récente est bien la dernière');
  });
});
