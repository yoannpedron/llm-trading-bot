import { useCallback, useEffect, useState } from 'react';

import { CLE_STOCKAGE, ecrireRegion, lireRegion } from './region.js';

/**
 * La région préférée, comme état React.
 *
 * Lue une fois au montage, écrite à chaque changement ; l'état vit au niveau
 * de l'application parce que tout ce qui montre ou enregistre un code en
 * dépend : la fiche, la liste des tirages, l'entrée d'inventaire, le journal.
 *
 * Un autre onglet qui change la préférence est suivi par l'événement
 * `storage` : deux onglets ouverts ne doivent pas afficher deux langues.
 *
 * @returns {[string, (code: string) => void]}
 */
export function useRegion() {
  const [region, setRegionState] = useState(() => lireRegion());

  const setRegion = useCallback((code) => {
    setRegionState(ecrireRegion(code));
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const suivre = (evenement) => {
      if (evenement.key === CLE_STOCKAGE) setRegionState(lireRegion());
    };
    window.addEventListener('storage', suivre);
    return () => window.removeEventListener('storage', suivre);
  }, []);

  return [region, setRegion];
}
