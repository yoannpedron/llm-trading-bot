import express from 'express';
import cors from 'cors';
import { config, validateConfig } from './config.js';
import { createLogger } from './logger.js';
import { createBroker } from './brokers/index.js';
import { keyPool } from './llm/keyPool.js';
import { RiskManager } from './core/riskManager.js';
import { Journal } from './core/journal.js';
import { TradingEngine } from './core/engine.js';
import { startScheduler } from './core/scheduler.js';
import { createRouter } from './api/routes.js';

const log = createLogger('server');

async function bootstrap() {
  for (const warning of validateConfig()) log.warn(warning);

  const broker = await createBroker();
  const journal = await new Journal().init();

  // Le pool agrège les clés du `.env` et celles ajoutées à chaud. S'il est vide,
  // inutile de tenter des appels voués à l'échec : on part directement en heuristique.
  await keyPool.init();
  if (config.llm.provider === 'gemini' && (await keyPool.capacity()).keys === 0) {
    log.warn('Pool de clés vide → moteur heuristique. Ajoute une clé : npm run keys:add -- <clé>');
    config.llm.provider = 'heuristic';
  }

  const risk = await new RiskManager().init(await broker.getAccount());
  const engine = new TradingEngine({ broker, risk, journal });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  // Private Network Access : Chrome refuse qu'une page publique en HTTPS
  // (le dashboard Netlify) contacte une adresse du réseau local (le back-end en
  // http://localhost) sans cet accord explicite du serveur local. Sans cela, le
  // navigateur renvoie un « Failed to fetch » très peu explicite.
  // À placer AVANT cors(), qui répond lui-même aux requêtes preflight.
  app.use((req, res, next) => {
    if (req.get('Access-Control-Request-Private-Network')) {
      res.set('Access-Control-Allow-Private-Network', 'true');
    }
    next();
  });

  app.use(
    cors({
      origin: config.server.corsOrigins.includes('*') ? true : config.server.corsOrigins,
      methods: ['GET', 'POST', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-Admin-Token'],
    }),
  );

  const scheduler = startScheduler(engine);
  app.use('/api', createRouter({ engine, broker, risk, journal, scheduler }));

  app.get('/', (_req, res) => {
    res.json({
      name: 'llm-trading-bot',
      mode: broker.isLive ? 'LIVE' : 'paper',
      docs: '/api/health, /api/dashboard, /api/journal, /api/positions',
    });
  });

  app.use((_req, res) => res.status(404).json({ error: 'route inconnue' }));

  const server = app.listen(config.server.port, () => {
    const account = broker.getAccount();
    log.info(`API en écoute sur le port ${config.server.port}`);
    log.info(`Univers : ${config.universe.symbols.join(', ')} | LLM : ${config.llm.provider}/${config.llm.model}`);
    Promise.resolve(account).then((a) =>
      log.info(`Capital : ${a.equity} ${a.currency} (initial ${a.initialCapital})`),
    );
  });

  const shutdown = (signal) => {
    log.warn(`${signal} reçu — arrêt propre.`);
    scheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Un rejet non géré ne doit jamais tuer un bot censé tourner 24/7.
  process.on('unhandledRejection', (reason) => log.error(`Rejet non géré : ${reason}`));

  // Une exception EPIPE vient de la sortie standard elle-même : la journaliser
  // reviendrait à réécrire sur le tuyau cassé, ce qui relance l'exception. Le
  // cas s'est produit et a bloqué un cycle entier à 100 % de CPU. Le logger
  // avale désormais ces erreurs, mais on court-circuite aussi ici : une panne
  // d'affichage ne mérite ni trace ni traitement.
  process.on('uncaughtException', (err) => {
    if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') return;
    log.error(`Exception non capturée : ${err.stack || err.message}`);
  });

  return { app, engine, broker };
}

bootstrap().catch((err) => {
  log.error(`Démarrage impossible : ${err.stack || err.message}`);
  process.exit(1);
});
