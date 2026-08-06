import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
const { normalizeDecision } = await import('../src/llm/agent.js');
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
    baseCurrency: 'EUR', initialCapital: 100, maxPositions: 3, maxPositionPct: 0.35,
    minOrderValue: 5, stopLossPct: 0.05, takeProfitPct: 0.12, maxDailyLossPct: 0.1,
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

  test('une confiance trop faible fait rejeter l\'achat', () => {
    const budget = risk.computeBudget({ account, position: null, price: 10, fxRate: 1, circuitBreaker: { tripped: false } });
    const validation = risk.validate({
      decision: { action: 'BUY', confidence: 0.2, sizePct: 1 },
      account, position: null, price: 10, fxRate: 1, budget,
    });
    assert.equal(validation.approved, false);
    assert.match(validation.reason, /confiance/);
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

  test('le stop-loss se déclenche sous le niveau', () => {
    const exit = risk.checkExits({ quantity: 1, avgPrice: 100, stopPrice: 95, takeProfitPrice: 112 }, 94);
    assert.equal(exit.triggered, 'STOP_LOSS');
  });

  test('le take-profit se déclenche au-dessus de l\'objectif', () => {
    const exit = risk.checkExits({ quantity: 1, avgPrice: 100, stopPrice: 95, takeProfitPrice: 112 }, 115);
    assert.equal(exit.triggered, 'TAKE_PROFIT');
  });

  test('aucune sortie entre les deux niveaux', () => {
    assert.equal(risk.checkExits({ quantity: 1, avgPrice: 100, stopPrice: 95, takeProfitPrice: 112 }, 103), null);
  });

  test('les niveaux de protection encadrent le prix d\'entrée', () => {
    const levels = risk.protectionLevels(100, { stopLossPct: 0.05, takeProfitPct: 0.12 });
    assert.equal(levels.stopPrice, 95);
    assert.equal(levels.takeProfitPrice, 112);
  });
});

describe('normalisation des décisions LLM', () => {
  const base = {
    action: 'BUY', confidence: 0.8, size_pct: 0.5,
    technical_rationale: 'RSI bas', news_sentiment: 'POSITIF',
    news_rationale: 'bonnes nouvelles',
    justification: 'J\'achète car le RSI est bas ET les actualités sont positives.',
  };

  test('une décision conforme passe intacte', () => {
    const d = normalizeDecision(base);
    assert.equal(d.action, 'BUY');
    assert.equal(d.sizePct, 0.5);
    assert.deepEqual(d.warnings, []);
  });

  test('une action inconnue est ramenée à HOLD', () => {
    const d = normalizeDecision({ ...base, action: 'SHORT' });
    assert.equal(d.action, 'HOLD');
    assert.equal(d.sizePct, 0);
  });

  test('les valeurs hors bornes sont écrêtées', () => {
    const d = normalizeDecision({ ...base, confidence: 42, size_pct: 9 });
    assert.equal(d.confidence, 1);
    assert.equal(d.sizePct, 1);
  });

  test('un BUY de taille nulle devient HOLD', () => {
    const d = normalizeDecision({ ...base, size_pct: 0 });
    assert.equal(d.action, 'HOLD');
    assert.ok(d.warnings.length > 0);
  });

  test('une justification sans référence aux actualités est signalée', () => {
    const d = normalizeDecision({ ...base, justification: 'Le RSI est bas.' });
    assert.ok(d.warnings.some((w) => /actualités/.test(w)));
  });

  test('les champs manquants reçoivent des valeurs sûres', () => {
    const d = normalizeDecision({ action: 'HOLD' });
    assert.equal(d.confidence, 0.3);
    assert.equal(d.sizePct, 0);
    assert.equal(typeof d.justification, 'string');
    assert.ok(d.stopLossPct > 0);
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
