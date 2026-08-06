import cron from 'node-cron';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('scheduler');

/**
 * Boucle temporelle du bot. `node-cron` déclenche `engine.runCycle()` selon
 * CRON_SCHEDULE. Le moteur possède son propre verrou anti-réentrance : un cycle
 * long ne provoque jamais deux exécutions concurrentes.
 */
export function startScheduler(engine) {
  if (!cron.validate(config.schedule.cron)) {
    throw new Error(`CRON_SCHEDULE invalide : « ${config.schedule.cron} »`);
  }

  const task = cron.schedule(
    config.schedule.cron,
    () => {
      engine.runCycle({ trigger: 'cron' }).catch((err) => log.error(`Cycle planifié en échec : ${err.message}`));
    },
    { scheduled: true, timezone: config.schedule.timezone },
  );

  log.info(`Planificateur actif : « ${config.schedule.cron} » (${config.schedule.timezone})`);

  if (config.schedule.runOnStart) {
    // Léger différé : laisse le serveur HTTP répondre au health check du PaaS
    // avant de lancer un cycle potentiellement long.
    setTimeout(() => {
      engine.runCycle({ trigger: 'startup' }).catch((err) => log.error(`Cycle initial en échec : ${err.message}`));
    }, 3000);
  }

  return {
    stop: () => {
      task.stop();
      log.warn('Planificateur arrêté.');
    },
    start: () => {
      task.start();
      log.info('Planificateur redémarré.');
    },
  };
}
