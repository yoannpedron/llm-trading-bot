/**
 * Exécute UN cycle de trading puis s'arrête.
 *
 * Deux usages :
 *  - `npm run cycle` en local pour tester la chaîne complète sans lancer le serveur ;
 *  - déploiement « serverless » : un cron externe (GitHub Actions, cron-job.org,
 *    Cloud Scheduler) appelle ce script à intervalle régulier, ce qui évite de
 *    payer un serveur qui tourne 24/7.
 */
import { validateConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createBroker } from '../brokers/index.js';
import { RiskManager } from '../core/riskManager.js';
import { Journal } from '../core/journal.js';
import { TradingEngine } from '../core/engine.js';

const log = createLogger('runOnce');

const broker = await createBroker();
for (const warning of validateConfig()) log.warn(warning);

const journal = await new Journal().init();
const risk = await new RiskManager().init(await broker.getAccount());
const engine = new TradingEngine({ broker, risk, journal });

const summary = await engine.runCycle({ trigger: 'cli' });
console.log('\n=== RÉSUMÉ DU CYCLE ===');
console.log(JSON.stringify(summary, null, 2));

const account = await broker.getAccount();
console.log('\n=== COMPTE ===');
console.log(JSON.stringify(account, null, 2));

process.exit(0);
