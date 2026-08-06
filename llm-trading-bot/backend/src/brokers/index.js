import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { PaperBrokerAdapter } from './PaperBrokerAdapter.js';
import { AlpacaBrokerAdapter } from './AlpacaBrokerAdapter.js';

const log = createLogger('broker');

/**
 * Fabrique du broker. C'est le SEUL endroit où le choix est fait ; le moteur
 * reçoit ensuite un objet conforme à `BrokerAdapter` et ignore lequel il pilote.
 *
 * - `alpaca` : compte paper réel chez Alpaca. Les fills se font au NBBO du
 *   moment, avec le vrai spread. Bien plus fidèle qu'une simulation maison,
 *   et sans risque puisque l'argent est fictif.
 * - `paper`  : simulateur interne, utile hors ligne ou sans compte broker.
 */
export async function createBroker(kind = config.broker.kind) {
  switch (kind) {
    case 'alpaca': {
      const broker = await new AlpacaBrokerAdapter().init();
      if (broker.isLive) {
        log.error('⚠️  BROKER EN MODE RÉEL — les ordres engagent de l\'argent véritable.');
      }
      return broker;
    }
    case 'paper':
    default:
      log.info('Simulateur interne sélectionné (aucun compte broker contacté).');
      return new PaperBrokerAdapter().init();
  }
}

export { PaperBrokerAdapter, AlpacaBrokerAdapter };
