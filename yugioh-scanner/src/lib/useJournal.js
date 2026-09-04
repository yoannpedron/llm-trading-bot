import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  ajouter,
  bilan,
  charger,
  enregistrer,
  entreeIdentifiee,
  entreeRefusee,
  marquerEnregistree,
} from './journal.js';

/**
 * Journal des lectures, persistant.
 *
 * Volontairement séparé de `useCollection` : les deux n'ont ni la même durée de
 * vie, ni la même clé de stockage, ni le même sens. Vider l'inventaire ne doit
 * pas effacer la trace de ce qu'on a scanné, et inversement.
 */
export function useJournal({ persist = true } = {}) {
  const [entrees, setEntrees] = useState(() => charger());
  const [persiste, setPersiste] = useState(true);

  useEffect(() => {
    if (persist) setPersiste(enregistrer(entrees));
  }, [entrees, persist]);

  const consignerIdentification = useCallback((fiche) => {
    if (!fiche?.identifiant) return;
    setEntrees((courant) => ajouter(courant, entreeIdentifiee(fiche)));
  }, []);

  const consignerRefus = useCallback((saisie, statut) => {
    setEntrees((courant) => ajouter(courant, entreeRefusee(saisie, statut)));
  }, []);

  const consignerEnregistrement = useCallback((cardId) => {
    setEntrees((courant) => marquerEnregistree(courant, cardId));
  }, []);

  const vider = useCallback(() => setEntrees([]), []);

  const compte = useMemo(() => bilan(entrees), [entrees]);

  return {
    entrees,
    compte,
    persiste,
    consignerIdentification,
    consignerRefus,
    consignerEnregistrement,
    vider,
  };
}
