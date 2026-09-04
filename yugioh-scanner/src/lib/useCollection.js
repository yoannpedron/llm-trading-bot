import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  downloadCsv,
  loadCollection,
  makeEntry,
  removeEntry,
  saveCollection,
  totalValue,
  upsertEntry,
  withPrice,
} from './collection.js';
import { fetchPrice } from './price.js';

/** Au-delà, la cote en mémoire est considérée comme périmée. */
const STALE_MS = 10 * 60 * 1000;

/** Requêtes de prix simultanées lors du rafraîchissement de l'historique. */
const CONCURRENCY = 3;

/**
 * Exécute les tâches par petits paquets.
 * Rafraîchir cinquante cartes d'un coup ferait cinquante requêtes parallèles —
 * le navigateur les mettrait en file de toute façon, et le service de prix les
 * verrait comme une rafale. Trois de front suffisent et restent polis.
 */
async function pool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

/**
 * Historique persistant et cotes associées.
 *
 * L'historique est la source de vérité des prix : l'écran de scan lit la cote
 * de l'entrée courante au lieu d'en tenir une copie. Une carte rescannée ou
 * rouverte depuis l'historique affiche donc immédiatement la valeur déjà connue,
 * et le rafraîchissement se voit partout à la fois.
 */
export function useCollection() {
  const [entries, setEntries] = useState(() => loadCollection());
  const [pending, setPending] = useState(() => new Set());
  const [errors, setErrors] = useState(() => new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const bootedRef = useRef(false);
  const abortRef = useRef(null);

  // Miroir synchrone de l'état : les rappels ci-dessous ont besoin de la liste
  // courante *au moment de l'appel*. La passer par la fermeture les recréerait
  // à chaque écriture, et lire dans un `setEntries` ne rend rien à l'appelant
  // puisque la fonction de mise à jour n'est exécutée qu'à la passe de rendu.
  const entriesRef = useRef(entries);

  useEffect(() => {
    entriesRef.current = entries;
    saveCollection(entries);
  }, [entries]);

  const markPending = useCallback((key, active) => {
    setPending((current) => {
      const next = new Set(current);
      if (active) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const loadPrice = useCallback(
    async (entry, signal) => {
      markPending(entry.key, true);
      setErrors((current) => {
        const next = new Map(current);
        next.delete(entry.key);
        return next;
      });

      try {
        const price = await fetchPrice(
          {
            name: entry.name,
            setName: entry.setName,
            rarity: entry.rarity,
            code: entry.setCode,
          },
          signal,
        );
        if (signal?.aborted) return;
        setEntries((current) => withPrice(current, entry.key, price));
      } catch (error) {
        if (error.name === 'AbortError') return;
        setErrors((current) => new Map(current).set(entry.key, error.message));
      } finally {
        if (!signal?.aborted) markPending(entry.key, false);
      }
    },
    [markPending],
  );

  /**
   * Remet à jour toutes les cotes.
   * Appelé au chargement de la page : rouvrir le site suffit à réactualiser
   * l'historique, sans bouton à trouver.
   */
  const refreshAll = useCallback(
    async (list) => {
      const targets = list ?? entriesRef.current;
      if (targets.length === 0) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setRefreshing(true);
      setProgress({ done: 0, total: targets.length });

      await pool(targets, CONCURRENCY, async (entry) => {
        if (controller.signal.aborted) return;
        await loadPrice(entry, controller.signal);
        setProgress((current) => ({ ...current, done: current.done + 1 }));
      });

      if (!controller.signal.aborted) setRefreshing(false);
    },
    [loadPrice],
  );

  /* Au chargement : on relève les cotes de tout ce qui est en mémoire. */
  useEffect(() => {
    if (bootedRef.current) return undefined;
    bootedRef.current = true;

    const stored = loadCollection();
    if (stored.length) refreshAll(stored);

    return () => abortRef.current?.abort();
    // Volontairement sans dépendance : ce passage n'a lieu qu'au premier montage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Enregistre une carte identifiée et relève sa cote si besoin.
   * @returns {string} la clé de l'entrée, à passer à `entryFor`
   */
  const track = useCallback(
    (card, printing) => {
      const entry = makeEntry(card, printing);
      const known = entriesRef.current.find((item) => item.key === entry.key) ?? null;

      setEntries((current) => upsertEntry(current, entry));

      // Une cote relevée il y a moins de dix minutes n'a pas bougé : on affiche
      // celle qu'on a déjà plutôt que de refaire l'aller-retour.
      const fresh = known?.price && Date.now() - (known.pricedAt ?? 0) < STALE_MS;
      if (!fresh) loadPrice(entry);

      return entry.key;
    },
    [loadPrice],
  );

  const remove = useCallback((key) => setEntries((current) => removeEntry(current, key)), []);

  const clear = useCallback(() => setEntries([]), []);

  const exportCsv = useCallback(() => downloadCsv(entriesRef.current), []);

  const entryFor = useCallback(
    (key) => entries.find((entry) => entry.key === key) ?? null,
    [entries],
  );

  const total = useMemo(() => totalValue(entries), [entries]);

  return {
    entries,
    entryFor,
    pending,
    errors,
    refreshing,
    progress,
    refreshAll,
    track,
    remove,
    clear,
    exportCsv,
    total,
  };
}
