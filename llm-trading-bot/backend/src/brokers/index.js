import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { PaperBrokerAdapter } from './PaperBrokerAdapter.js';
import { AlpacaBrokerAdapter } from './AlpacaBrokerAdapter.js';

const log = createLogger('broker');

/**
 * Fabrique du broker. C'est le SEUL endroit où le choix paper/réel est fait ;
 * le moteur reçoit ensuite un objet conforme à `BrokerAdapter` et ne sait pas
 * lequel il manipule.
 */
export async function createBroker(kind = config.broker.kind) {
  switch (kind) {
    case 'alpaca': {
      log.warn('Broker Alpaca sélectionné — vérifie ALPACA_BASE_URL avant tout ordre.');
      return new AlpacaBrokerAdapter().init();
    }
    case 'paper':
    default:
      return new PaperBrokerAdapter().init();
  }
}

export { PaperBrokerAdapter, AlpacaBrokerAdapter };
