import express from 'express';
import { config } from '../config.js';
import { getRecentLogs } from '../logger.js';
import { getMarketSnapshot, getFxRate } from '../data/marketData.js';
import { getNews } from '../news/newsService.js';
import { buildUserPrompt } from '../llm/agent.js';
import { keyPool } from '../llm/keyPool.js';

/**
 * API REST consommée par le dashboard.
 *
 * Lecture : publique (le tableau de bord est en lecture seule).
 * Écriture : protégée par ADMIN_TOKEN (en-tête `X-Admin-Token`).
 * Si ADMIN_TOKEN n'est pas défini, les routes d'écriture sont désactivées :
 * un bot exposé sur Internet sans jeton ne doit pas être pilotable par un tiers.
 */
export function createRouter({ engine, broker, risk, journal, scheduler }) {
  const router = express.Router();

  const requireAdmin = (req, res, next) => {
    const token = req.get('X-Admin-Token') || req.query.token;
    if (!config.server.adminToken) {
      return res.status(503).json({ error: 'ADMIN_TOKEN non configuré : routes d\'écriture désactivées.' });
    }
    if (token !== config.server.adminToken) {
      return res.status(401).json({ error: 'Jeton administrateur invalide.' });
    }
    return next();
  };

  const asyncRoute = (handler) => (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      res.status(500).json({ error: err.message });
    });
  };

  const intParam = (value, fallback, max) => {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, max);
  };

  // ── Lecture ──────────────────────────────────────────────────────────────

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSec: Math.round(process.uptime()), time: new Date().toISOString() });
  });

  router.get('/status', asyncRoute(async (_req, res) => {
    res.json({ ...engine.status, risk: risk.state, capacity: await keyPool.capacity() });
  }));

  /** Capacité du pool de clés : public, ne révèle aucun matériel de clé. */
  router.get('/capacity', asyncRoute(async (_req, res) => {
    res.json(await keyPool.capacity());
  }));

  router.get('/account', asyncRoute(async (_req, res) => {
    res.json(await broker.getAccount());
  }));

  router.get('/positions', asyncRoute(async (_req, res) => {
    res.json(await broker.getPositions());
  }));

  router.get('/trades', asyncRoute(async (req, res) => {
    res.json(await broker.getTrades(intParam(req.query.limit, 50, 500)));
  }));

  router.get('/equity', asyncRoute(async (req, res) => {
    res.json(await broker.getEquityCurve(intParam(req.query.limit, 500, 5000)));
  }));

  router.get('/journal', (req, res) => {
    res.json(journal.entries(intParam(req.query.limit, 30, 200), req.query.symbol || null));
  });

  router.get('/cycles', (req, res) => {
    res.json(journal.cycles(intParam(req.query.limit, 20, 100)));
  });

  router.get('/logs', (req, res) => {
    res.json(getRecentLogs(intParam(req.query.limit, 100, 300)));
  });

  router.get('/config', (_req, res) => {
    // Aucune clé d'API n'est exposée ici : uniquement les paramètres de stratégie.
    res.json({
      symbols: config.universe.symbols,
      interval: config.universe.interval,
      cron: config.schedule.cron,
      timezone: config.schedule.timezone,
      onlyMarketHours: config.schedule.onlyMarketHours,
      llm: { provider: config.llm.provider, model: config.llm.model, temperature: config.llm.temperature },
      risk: config.risk,
      broker: { kind: broker.name, isLive: broker.isLive, feePct: config.broker.feePct, slippagePct: config.broker.slippagePct },
      news: { providers: config.news.providers, lookbackHours: config.news.lookbackHours, maxArticles: config.news.maxArticles },
    });
  });

  /** Agrégat : une seule requête pour peindre tout le dashboard. */
  router.get('/dashboard', asyncRoute(async (_req, res) => {
    const [account, positions, trades, equityCurve] = await Promise.all([
      broker.getAccount(),
      broker.getPositions(),
      broker.getTrades(25),
      broker.getEquityCurve(500),
    ]);
    res.json({
      account,
      positions,
      trades,
      equityCurve,
      journal: journal.entries(25),
      cycles: journal.cycles(10),
      status: { ...engine.status, risk: risk.state, capacity: await keyPool.capacity() },
      serverTime: new Date().toISOString(),
    });
  }));

  /** Aperçu des données brutes d'un actif (debug / transparence). */
  router.get('/market/:symbol', asyncRoute(async (req, res) => {
    const snapshot = await getMarketSnapshot(req.params.symbol.toUpperCase());
    res.json({
      symbol: snapshot.symbol,
      currency: snapshot.currency,
      exchange: snapshot.exchange,
      marketState: snapshot.marketState,
      indicators: snapshot.indicators,
      recentCandles: snapshot.recentCandles,
    });
  }));

  router.get('/news/:symbol', asyncRoute(async (req, res) => {
    res.json(await getNews(req.params.symbol.toUpperCase()));
  }));

  // ── Écriture (protégée) ──────────────────────────────────────────────────

  /** Reconstitue le prompt exact envoyé au LLM, sans consommer de quota. */
  router.get('/prompt/:symbol', requireAdmin, asyncRoute(async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const snapshot = await getMarketSnapshot(symbol);
    const fxRate = await getFxRate(snapshot.currency);
    const [news, account, position] = await Promise.all([
      getNews(symbol),
      broker.getAccount(),
      broker.getPosition(symbol),
    ]);
    const circuitBreaker = await risk.checkCircuitBreaker(account);
    const budget = risk.computeBudget({ account, position, price: snapshot.indicators.price, fxRate, circuitBreaker });

    res.type('text/plain').send(
      buildUserPrompt({ snapshot, news, account, position, budget, constraints: config.risk }),
    );
  }));

  router.post('/cycle', requireAdmin, asyncRoute(async (_req, res) => {
    res.json(await engine.runCycle({ trigger: 'manual' }));
  }));

  // ── Pool de clés LLM ─────────────────────────────────────────────────────
  // Ces routes manipulent des secrets : elles sont réservées à l'admin, et la
  // liste ne renvoie que des clés masquées, jamais le matériel complet.

  router.get('/llm/keys', requireAdmin, asyncRoute(async (_req, res) => {
    res.json({ keys: await keyPool.list(), capacity: await keyPool.capacity() });
  }));

  router.post('/llm/keys', requireAdmin, asyncRoute(async (req, res) => {
    const { key, label, validate = true } = req.body || {};
    if (!key) return res.status(400).json({ error: 'champ `key` requis' });

    // On teste la clé AVANT de l'enregistrer : une clé morte dans le pool ne
    // ferait que gaspiller une tentative à chaque cycle.
    let probe = null;
    if (validate) {
      probe = await keyPool.probe(String(key).trim());
      if (probe.ok === false) {
        return res.status(400).json({ error: probe.message, probe });
      }
    }

    try {
      const added = await keyPool.add(key, label);
      // Une clé déjà à sec est ajoutée mais marquée immédiatement : elle
      // resservira demain, sans polluer les cycles d'aujourd'hui.
      if (probe?.state === 'quota_atteint') {
        await keyPool.markExhausted(added.id, 'quota déjà atteint à l\'ajout');
      }
      return res.status(201).json({
        added,
        probe,
        keys: await keyPool.list(),
        capacity: await keyPool.capacity(),
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }));

  /** Re-teste les clés auprès de Google (ne consomme pas de quota de génération). */
  router.post('/llm/keys/check', requireAdmin, asyncRoute(async (_req, res) => {
    const results = await keyPool.checkAll();
    res.json({ results, keys: await keyPool.list(), capacity: await keyPool.capacity() });
  }));

  router.delete('/llm/keys/:id', requireAdmin, asyncRoute(async (req, res) => {
    try {
      await keyPool.remove(req.params.id);
      return res.json({ ok: true, keys: await keyPool.list(), capacity: await keyPool.capacity() });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }));

  router.post('/pause', requireAdmin, (_req, res) => {
    res.json({ paused: engine.setPaused(true) });
  });

  router.post('/resume', requireAdmin, (_req, res) => {
    res.json({ paused: engine.setPaused(false) });
  });

  router.post('/scheduler/:action', requireAdmin, (req, res) => {
    const { action } = req.params;
    if (action === 'stop') scheduler?.stop();
    else if (action === 'start') scheduler?.start();
    else return res.status(400).json({ error: 'action attendue : start | stop' });
    return res.json({ ok: true, action });
  });

  /** Réinitialise le portefeuille papier ET le journal. Irréversible. */
  router.post('/reset', requireAdmin, asyncRoute(async (_req, res) => {
    if (broker.isLive) {
      return res.status(400).json({ error: 'Reset interdit sur un broker réel.' });
    }
    if (typeof broker.reset !== 'function') {
      return res.status(400).json({ error: 'Ce broker ne supporte pas la réinitialisation.' });
    }
    await journal.reset();
    const account = await broker.reset();
    return res.json({ ok: true, account });
  }));

  return router;
}
