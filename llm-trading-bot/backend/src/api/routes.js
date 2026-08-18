import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { getRecentLogs } from '../logger.js';
import { getMarketSnapshot, getMarketClock, getCandleSeries } from '../data/marketData.js';
import { spreadLog } from '../data/spreadLog.js';
import { executionQuality } from '../data/executionQuality.js';
import { calendarPhase } from '../data/calendar.js';
import { shadowBook } from '../core/shadowBook.js';
import { runSprt } from '../core/sprt.js';
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

  // ── Deux défauts sur la porte d'entrée, trouvés par l'audit ─────────────
  //
  // 1. `token !== config.server.adminToken` compare caractère par caractère et
  //    s'arrête au premier écart. Le temps de réponse fuit donc la longueur du
  //    préfixe correct. C'est ténu à travers un réseau, mais la parade coûte
  //    une ligne.
  //
  // 2. Rien ne limitait les tentatives. Mesuré sur le serveur en production :
  //    cinq jetons faux d'affilée, cinq 401 rendus en 100 ms chacun, sans le
  //    moindre ralentissement. Un jeton court se devine à ce rythme.
  //
  // Le compteur vit en mémoire : un redémarrage le remet à zéro, ce qui est
  // acceptable — un attaquant ne redémarre pas le service, et l'opérateur qui
  // se trompe de jeton n'a qu'à relancer.
  const FENETRE_MS = 15 * 60 * 1000;
  const TENTATIVES_MAX = 10;
  const echecs = new Map();

  /** Comparaison à temps constant, qui ne trahit pas non plus la longueur. */
  const memeJeton = (fourni, attendu) => {
    if (typeof fourni !== 'string' || typeof attendu !== 'string') return false;
    const a = Buffer.from(fourni, 'utf8');
    const b = Buffer.from(attendu, 'utf8');
    if (a.length !== b.length) {
      timingSafeEqual(b, b);   // même travail, pour ne pas répondre plus vite
      return false;
    }
    return timingSafeEqual(a, b);
  };

  const requireAdmin = (req, res, next) => {
    // ── En-tête seulement, jamais l'URL ────────────────────────────────────
    // Un `?token=…` en repli paraissait commode. Une URL traverse les journaux
    // d'accès du serveur, l'historique du navigateur et l'en-tête `Referer`
    // envoyé aux tiers ; un en-tête ne va nulle part. Le dashboard n'a jamais
    // utilisé que l'en-tête : ce repli n'ouvrait un risque sans rendre aucun
    // service.
    const token = req.get('X-Admin-Token');
    if (!config.server.adminToken) {
      return res.status(503).json({ error: 'ADMIN_TOKEN non configuré : routes d\'écriture désactivées.' });
    }
    // ── Le jeton est vérifié AVANT le compteur, et c'est le point clé ─────
    // Compter d'abord verrouillait aussi le jeton VALIDE : dix essais ratés
    // depuis un poste, et l'opérateur ne pouvait plus rien faire pendant un
    // quart d'heure — vérifié en production, je m'en suis exclu moi-même en
    // testant la limitation.
    //
    // Vérifier d'abord ne rend rien à un attaquant : celui qui devine le jeton
    // entrait de toute façon. Ce que la limitation doit ralentir, c'est la
    // RECHERCHE, et elle le fait toujours — dix mauvais essais et les suivants
    // ne sont plus traités.
    const origine = req.ip ?? 'inconnue';
    const maintenant = Date.now();
    const compteur = echecs.get(origine);
    const recent = compteur && maintenant - compteur.depuis < FENETRE_MS ? compteur : null;

    if (memeJeton(token, config.server.adminToken)) {
      // Un succès efface l'ardoise : l'opérateur qui s'est trompé une fois ne
      // traîne pas son compteur derrière lui.
      echecs.delete(origine);
      return next();
    }

    echecs.set(origine, { n: (recent?.n ?? 0) + 1, depuis: recent?.depuis ?? maintenant });

    if (recent && recent.n >= TENTATIVES_MAX) {
      const reste = Math.ceil((FENETRE_MS - (maintenant - recent.depuis)) / 60000);
      return res.status(429).json({
        error: `Trop de jetons invalides. Réessayez dans ${reste} minute(s).`,
      });
    }
    return res.status(401).json({ error: 'Jeton administrateur invalide.' });
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

  /**
   * Coût de transaction mesuré. C'est la réponse empirique à la question que
   * les rapports de recherche laissaient ouverte d'un facteur 8.
   */
  router.get('/spreads', asyncRoute(async (_req, res) => {
    res.json(await spreadLog.summary());
  }));

  /**
   * Carnet fantôme : qualité de PRÉDICTION du modèle, isolée de la qualité
   * d'exécution. Segmenté par action, confiance, disponibilité des actualités
   * et phase calendaire, pour savoir ce qui sert réellement à quelque chose.
   */
  router.get('/shadow', asyncRoute(async (req, res) => {
    const horizon = intParam(req.query.horizon, 21, 21);
    res.json(await shadowBook.stats({ horizon }));
  }));

  /**
   * Verdict séquentiel : le bot a-t-il un avantage, faut-il l'arrêter, ou
   * manque-t-il encore des données ? C'est l'instrument de décision du projet.
   */
  router.get('/sprt', asyncRoute(async (req, res) => {
    const horizon = intParam(req.query.horizon, 21, 21);
    res.json(await runSprt(shadowBook, { horizon }));
  }));

  router.get('/calendar', (_req, res) => {
    res.json(calendarPhase());
  });

  /**
   * Qualité d'exécution : le prix obtenu vs la cotation au moment de la
   * soumission. Répond empiriquement à la question qu'aucun rapport public ne
   * peut trancher pour NOS ordres fractionnaires.
   */
  router.get('/execution', asyncRoute(async (_req, res) => {
    res.json(await executionQuality.summary());
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

  /**
   * Diagnostic complet, en texte brut, prêt à être copié dans une conversation.
   *
   * Le format n'est pas du JSON : quand on cherche à comprendre pourquoi le bot
   * n'a rien fait depuis trois jours, on veut lire l'état, pas le parser. Tout
   * ce qui permet de répondre à « est-il vivant, et que fait-il ? » est réuni
   * ici en un seul appel.
   *
   * Aucune donnée sensible n'y figure : les clés sont masquées et le jeton
   * admin n'apparaît jamais.
   */
  router.get('/diagnostic', asyncRoute(async (_req, res) => {
    const [account, positions, capacity, sprtVerdict, shadowStats, spreadStats, execStats] = await Promise.all([
      broker.getAccount().catch((e) => ({ error: e.message })),
      broker.getPositions().catch(() => []),
      keyPool.capacity().catch((e) => ({ error: e.message })),
      runSprt(shadowBook, { horizon: 21 }).catch((e) => ({ error: e.message })),
      shadowBook.stats({ horizon: 21 }).catch((e) => ({ error: e.message })),
      spreadLog.summary().catch((e) => ({ error: e.message })),
      executionQuality.summary().catch((e) => ({ error: e.message })),
    ]);

    const status = engine.status;
    const phase = calendarPhase();
    const logs = getRecentLogs(60);
    const errors = logs.filter((l) => l.level === 'error');
    const warnings = logs.filter((l) => l.level === 'warn');

    const lines = [
      '════════ DIAGNOSTIC LLM TRADING BOT ════════',
      `Généré le          : ${new Date().toISOString()}`,
      `Uptime serveur     : ${Math.round(process.uptime() / 60)} min`,
      '',
      '── MOTEUR ──',
      `Statut             : ${status.isRunning ? 'cycle en cours' : status.paused ? 'EN PAUSE' : 'en veille'}`,
      `Cycles exécutés    : ${status.cycleCount}`,
      `Dernier cycle      : ${status.lastCycleAt ?? 'jamais'}`,
      `Planification      : ${status.cron} (${config.schedule.timezone})`,
      `Horaires marché    : ${config.schedule.onlyMarketHours ? 'respectés' : 'IGNORÉS (mode test)'}`,
      `Univers            : ${status.symbols.join(', ')}`,
      `Phase calendaire   : ${phase.label} / ${phase.phase}`,
      '',
      '── COMPTE ──',
      `Broker             : ${status.broker}${status.isLive ? ' ⚠️ RÉEL' : ' (paper)'}`,
      account.error
        ? `ERREUR             : ${account.error}`
        : `Équity             : ${account.equity} ${account.currency} (initial ${account.initialCapital})`,
      account.error ? '' : `Liquidités         : ${account.cash} | P&L ${account.totalPnl} (${account.totalPnlPct} %)`,
      `Positions          : ${positions.length ? positions.map((p) => `${p.symbol} ${p.quantity}@${p.avgPrice} (${p.unrealizedPnlPct} %)`).join(', ') : 'aucune'}`,
      '',
      '── QUOTA IA ──',
      capacity.error
        ? `ERREUR             : ${capacity.error}`
        : `Clés               : ${capacity.keys} (${capacity.keysExhausted} épuisée(s))`,
      capacity.error ? '' : `Consommé           : ${capacity.used}/${capacity.totalPerDay} — ${capacity.cyclesPerDay} cycles/jour possibles`,
      capacity.error ? '' : `Modèle             : ${status.llmProvider}/${status.model}`,
      '',
      '── VERDICT STATISTIQUE ──',
      `Statut SPRT        : ${sprtVerdict.status ?? 'indisponible'}`,
      `Raison             : ${sprtVerdict.reason ?? '—'}`,
      `Observations       : ${sprtVerdict.n ?? 0} au total, dont ${sprtVerdict.nWarmup ?? 0} pour calibrer l'échelle`,
      `Preuves accumulées : ${sprtVerdict.nEff ?? 0} | LLR ${sprtVerdict.llr ?? '—'} | bornes [${sprtVerdict.bounds?.lower ?? '?'} ; ${sprtVerdict.bounds?.upper ?? '?'}]`,
      sprtVerdict.achievedNote ? `Garantie atteinte  : ${sprtVerdict.achievedNote}` : '',
      `Carnet fantôme     : ${shadowStats.samples ?? 0} décisions résolues, ${shadowStats.pendingResolution ?? 0} en attente`,
      shadowStats.overall
        ? `Taux de réussite   : ${(shadowStats.overall.hitRate * 100).toFixed(1)} % | rendement excédentaire moyen ${shadowStats.overall.meanExcessPct} %`
        : 'Taux de réussite   : pas encore mesurable',
      '',
      '── CALIBRATION DES PRÉVISIONS ──',
      shadowStats.calibration?.brier != null
        ? `Brier ${shadowStats.calibration.brier} | ECE ${shadowStats.calibration.ece} | habileté ${shadowStats.calibration.scoreHabilete}`
        : `Indisponible       : ${shadowStats.calibration?.note ?? 'aucune prévision résolue'}`,
      // Pente d'abord : le biais moyen s'annule sur une surconfiance symétrique
      // et laisserait croire l'échelle saine.
      shadowStats.calibration?.penteDeCalibration != null
        ? `Pente d'échelle    : ${shadowStats.calibration.penteDeCalibration} `
          + `(< 1 = écarts exagérés, > 1 = trop timides) | biais moyen `
          + `${shadowStats.calibration.biaisMoyen > 0 ? '+' : ''}${shadowStats.calibration.biaisMoyen}`
        : '',
      shadowStats.calibration?.verdict ? `Verdict            : ${shadowStats.calibration.verdict}` : '',
      ...(shadowStats.calibration?.bins ?? []).map(
        (b) => `  tranche ${b.range}   : annoncé ${b.annonce} → réalisé ${b.realise} (n=${b.n}, écart ${b.ecart > 0 ? '+' : ''}${b.ecart})`,
      ),
      '',
      '── BIAIS D\'INACTION DU MODÈLE ──',
      shadowStats.advisory
        ? `Divergences        : ${(shadowStats.advisory.tauxDeConflit * 100).toFixed(0)} % des ${shadowStats.advisory.n} décisions`
        : 'Divergences        : pas encore mesurable',
      shadowStats.advisory
        ? `Il freinait        : ${shadowStats.advisory.freinePar.n} fois (score moyen des actions prises malgré son avis : ${shadowStats.advisory.freinePar.scoreMoyenPct ?? '—'} %)`
        : '',
      shadowStats.advisory
        ? `Il poussait        : ${shadowStats.advisory.retenuPar.n} fois (score moyen : ${shadowStats.advisory.retenuPar.scoreMoyenPct ?? '—'} %)`
        : '',
      shadowStats.advisory?.note ? `Lecture            : ${shadowStats.advisory.note}` : '',
      '',
      '── COÛTS MESURÉS ──',
      spreadStats.overall
        ? `Spread médian      : ${spreadStats.overall.medianOfMedians} bps sur ${spreadStats.overall.symbolsMeasured} actifs (${spreadStats.overall.totalSamples} mesures)`
        : 'Spread médian      : aucune mesure en séance',
      execStats.measurable
        ? `Exécution          : ${execStats.vsExpectedSide.medianBps} bps médian — ${execStats.interpretation}`
        : `Exécution          : ${execStats.note ?? 'aucun fill mesurable'}`,
      '',
      `── ERREURS RÉCENTES (${errors.length}) ──`,
      ...(errors.length ? errors.slice(-10).map((l) => `${l.ts} [${l.scope}] ${l.message}`) : ['aucune']),
      '',
      `── AVERTISSEMENTS RÉCENTS (${warnings.length}) ──`,
      ...(warnings.length ? warnings.slice(-10).map((l) => `${l.ts} [${l.scope}] ${l.message}`) : ['aucun']),
      '',
      '── 25 DERNIÈRES LIGNES DE LOG ──',
      ...logs.slice(-25).map((l) => `${l.ts} ${l.level.toUpperCase().padEnd(5)} ${l.scope.padEnd(10)} ${l.message}`),
      '',
      '════════ FIN DU DIAGNOSTIC ════════',
    ];

    res.type('text/plain; charset=utf-8').send(lines.filter((l) => l !== '').join('\n'));
  }));

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

  /**
   * Agrégat : une seule requête pour peindre tout le dashboard.
   *
   * Les mesures (SPRT, carnet fantôme, coûts) y sont incluses parce qu'elles
   * sont devenues le cœur du projet : le P&L d'un compte de 100 $ n'apprend
   * rien, le verdict statistique si.
   *
   * Chaque bloc de mesure est isolé : si l'un échoue, le dashboard s'affiche
   * quand même. Un tableau de bord qui plante parce qu'une statistique manque
   * serait un mauvais outil de diagnostic.
   */
  router.get('/dashboard', asyncRoute(async (_req, res) => {
    const safe = (promise, fallback = null) => promise.then((v) => v).catch((err) => ({ error: err.message, ...fallback }));

    const [account, positions, trades, equityCurve, capacity, sprt, shadow, spreads, execution, clock] = await Promise.all([
      broker.getAccount(),
      broker.getPositions(),
      broker.getTrades(25),
      broker.getEquityCurve(500),
      safe(keyPool.capacity()),
      safe(runSprt(shadowBook, { horizon: 21 })),
      safe(shadowBook.stats({ horizon: 21 })),
      safe(spreadLog.summary()),
      safe(executionQuality.summary()),
      safe(getMarketClock(), { is_open: null }),
    ]);

    res.json({
      account,
      positions,
      trades,
      equityCurve,
      journal: journal.entries(25),
      cycles: journal.cycles(10),
      // L'état du marché est la première chose à vérifier quand « il ne se
      // passe rien » : hors séance, le bot n'analyse pas, par économie de quota.
      status: {
        ...engine.status,
        risk: risk.state,
        capacity,
        marketOpen: clock?.is_open ?? null,
        nextMarketOpen: clock?.next_open ?? null,
        nextMarketClose: clock?.next_close ?? null,
      },
      measurement: { sprt, shadow, spreads, execution },
      calendar: calendarPhase(),
      serverTime: new Date().toISOString(),
    });
  }));

  /** Aperçu des données brutes d'un actif (debug / transparence). */
  /**
   * Bougies d'un actif, sur la fenêtre demandée.
   *
   * Chaque fenêtre a son pas de temps : tracer un an en bougies 5 minutes
   * enverrait ~20 000 points pour un graphique large de 700 pixels, et tracer
   * une journée en bougies journalières donnerait un seul point. Les paires
   * ci-dessous visent 60 à 250 points, ce qui remplit le tracé sans le noyer.
   */
  const FENETRES = {
    '1d': { interval: '5m', range: '1d' },
    '1w': { interval: '30m', range: '5d' },
    '1m': { interval: '1d', range: '1mo' },
    '6m': { interval: '1d', range: '6mo' },
    '1y': { interval: '1d', range: '1y' },
  };

  router.get('/market/:symbol', asyncRoute(async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const fenetre = FENETRES[String(req.query.range || '').toLowerCase()];

    // Une fenêtre demandée = graphique. On sert alors la série brute, sans
    // indicateurs : ils ne sont pas affichés, et ce sont eux qui imposaient un
    // minimum de 30 bougies incompatible avec une vue à un jour.
    if (fenetre) {
      res.json(await getCandleSeries(symbol, fenetre));
      return;
    }

    const snapshot = await getMarketSnapshot(symbol);
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
    const fxRate = 1; // compte et actifs en USD
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

  // Réponse immédiate : un cycle sur 150 actifs dure une vingtaine de minutes
  // en séance, bien au-delà de ce que tolère un navigateur ou un proxy. Le
  // client suit ensuite `status.progress`. 202 = « accepté, pas terminé ».
  router.post('/cycle', requireAdmin, asyncRoute(async (_req, res) => {
    const started = engine.startCycle({ trigger: 'manual' });
    res.status(started.started ? 202 : 409).json(started);
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
