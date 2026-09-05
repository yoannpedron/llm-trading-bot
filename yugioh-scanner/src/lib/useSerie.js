/**
 * La préférence « mode série », en React : lue au démarrage, écrite à
 * chaque changement. Voir `serie.js`.
 */
import { useCallback, useState } from 'react';

import { ecrireSerie, lireSerie } from './serie.js';

export function useSerie() {
  const [serie, setSerieEtat] = useState(() => lireSerie());
  const setSerie = useCallback((valeur) => {
    setSerieEtat((courant) => {
      const suivant = typeof valeur === 'function' ? valeur(courant) : Boolean(valeur);
      ecrireSerie(suivant);
      return suivant;
    });
  }, []);
  return [serie, setSerie];
}
