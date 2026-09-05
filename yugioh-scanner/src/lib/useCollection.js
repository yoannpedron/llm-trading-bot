import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  downloadCsv,
  loadCollection,
  makeEntry,
  removeEntry,
  retirerUn,
  saveCollection,
  totalValue,
  upsertEntry,
  withCondition,
  withPrice,
  withTirage,
} from './collection.js';
import { DEFAULT_CONDITION } from './condition.js';
import { fetchPrice, hasPriceBackend } from './price.js';

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
export function useCollection({ persist = true, refreshOnLoad = true } = {}) {
  const [entries, setEntries] = useState(() => loadCollection());
  const [pending, setPending] = useState(() => new Set());
  const [errors, setErrors] = useState(() => new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  /**
   * L'inventaire est-il réellement conservé ?
   *
   * `saveCollection` rend `false` quand le stockage refuse — quota dépassé,
   * navigation privée, cookies bloqués — et cette valeur était jetée. L'écran
   * affirmait alors que « rien ne quitte cet appareil » et que l'inventaire y
   * est conservé, pendant que chaque rechargement le vidait. Une donnée perdue
   * en silence est le pire des défauts : l'utilisateur ne l'apprend qu'après.
   */
  const [persiste, setPersiste] = useState(true);

  const bootedRef = useRef(false);
  const abortRef = useRef(null);

  // Miroir synchrone de l'état : les rappels ci-dessous ont besoin de la liste
  // courante *au moment de l'appel*. La passer par la fermeture les recréerait
  // à chaque écriture, et lire dans un `setEntries` ne rend rien à l'appelant
  // puisque la fonction de mise à jour n'est exécutée qu'à la passe de rendu.
  const entriesRef = useRef(entries);

  useEffect(() => {
    entriesRef.current = entries;
    // Historique désactivé dans les réglages : la session reste utilisable,
    // mais rien n'est écrit sur l'appareil.
    if (persist) setPersiste(saveCollection(entries));
  }, [entries, persist]);

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
            // Le passcode est la clé primaire de la base, identique dans
            // toutes les langues. Le nom stocké est le nom FRANÇAIS, que le
            // paramètre `name` de YGOPRODeck n'indexe pas : la requête
            // partait en 400 et aucune carte n'obtenait jamais de cote sur
            // l'hébergement statique. Le nom ne reste qu'en repêchage, pour
            // une entrée ancienne dépourvue d'identifiant.
            cardId: entry.cardId,
            name: entry.name,
            language: 'fr',
            setName: entry.setName,
            rarity: entry.rarity,
            code: entry.setCode,
            condition: entry.condition,
          },
          signal,
        );
        if (signal?.aborted) return;
        setEntries((current) => withPrice(current, entry.key, price));
      } catch (error) {
        if (error.name === 'AbortError') return;
        setErrors((current) => new Map(current).set(entry.key, error.message));
      } finally {
        // Toujours libéré, y compris sur annulation : sinon la clé reste dans
        // l'ensemble et la cellule de cote affiche indéfiniment des points de
        // suspension, sur une ligne qui n'attend plus rien.
        markPending(entry.key, false);
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
    async (list, { force = false } = {}) => {
      const candidats = list ?? entriesRef.current;
      // Une cote relevée il y a moins de dix minutes vaut encore. Le seuil
      // existait déjà mais n'était consulté qu'à l'enregistrement d'une carte :
      // rouvrir la page deux fois de suite refaisait la totalité des requêtes,
      // pour rien, et sur un réseau mobile. Le bouton « Actualiser » force,
      // parce que c'est précisément ce qu'on lui demande.
      const targets = force
        ? candidats
        : candidats.filter((entry) => Date.now() - (entry.pricedAt ?? 0) >= STALE_MS);
      if (targets.length === 0) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setRefreshing(true);
      setProgress({ done: 0, total: targets.length });

      let faits = 0;
      await pool(targets, CONCURRENCY, async (entry) => {
        if (controller.signal.aborted) return;
        await loadPrice(entry, controller.signal);
        // Le compteur appartient à CE relevé : incrémenter l'état global
        // laissait les tâches encore en vol d'un relevé abandonné gonfler le
        // compteur du suivant, jusqu'à dépasser son total.
        faits += 1;
        if (!controller.signal.aborted) setProgress({ done: faits, total: targets.length });
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
    // Sans `force` : seules les cotes périmées repartent en requête.
    if (refreshOnLoad && stored.length) refreshAll(stored);

    return () => abortRef.current?.abort();
    // Volontairement sans dépendance : ce passage n'a lieu qu'au premier montage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Enregistre une carte identifiée et relève sa cote si besoin.
   * @returns {string} la clé de l'entrée, à passer à `entryFor`
   */
  const track = useCallback(
    (card, printing, condition = DEFAULT_CONDITION, { tirageAPreciser = false } = {}) => {
      const entry = makeEntry(card, printing, { condition, tirageAPreciser });
      const known = entriesRef.current.find((item) => item.key === entry.key) ?? null;

      setEntries((current) => upsertEntry(current, entry));

      // Une cote relevée il y a moins de dix minutes vaut encore — sauf si
      // l'état a changé, auquel cas le filtre Cardmarket n'est plus le même.
      const fresh =
        known?.price &&
        known.condition === condition &&
        Date.now() - (known.pricedAt ?? 0) < STALE_MS;
      if (!fresh) loadPrice(entry);

      return entry.key;
    },
    [loadPrice],
  );

  /**
   * Change l'état d'une entrée et relève la cote correspondante.
   *
   * Sans effet si l'état est déjà celui-là : l'écran de scan rejoue ce rappel
   * chaque fois qu'une carte est sélectionnée, et une requête de prix par
   * rendu n'apporterait rien.
   */
  const setCondition = useCallback(
    (key, condition) => {
      const entry = entriesRef.current.find((item) => item.key === key);
      if (!entry || entry.condition === condition) return;

      setEntries((current) => withCondition(current, key, condition));

      // Seul le backend sait filtrer Cardmarket par état ; sans lui, la
      // réponse serait identique et son échec viendrait peindre un message
      // d'erreur sur une ligne dont l'estimation par coefficient est
      // pourtant juste. On ne relance donc que si la requête peut apprendre
      // quelque chose.
      if (hasPriceBackend()) loadPrice({ ...entry, condition });
    },
    [loadPrice],
  );

  /** Oublie tout ce qu'on savait d'une clé : cote en cours, erreur passée. */
  const oublier = useCallback((cle) => {
    setPending((courant) => {
      if (!courant.has(cle)) return courant;
      const suivant = new Set(courant);
      suivant.delete(cle);
      return suivant;
    });
    setErrors((courant) => {
      if (!courant.has(cle)) return courant;
      const suivant = new Map(courant);
      suivant.delete(cle);
      return suivant;
    });
  }, []);

  /** Remplace le tirage d'une entrée et relève la cote du nouveau. */
  const remplacerTirage = useCallback(
    (key, printing) => {
      oublier(key);
      setEntries((current) => {
        const suivantes = withTirage(current, key, printing);
        const nouvelle = suivantes.find((entry) => entry.cardId === current.find((e) => e.key === key)?.cardId && entry.setCode === printing?.setCode && entry.rarity === printing?.rarity);
        if (nouvelle) loadPrice(nouvelle);
        return suivantes;
      });
    },
    [oublier, loadPrice],
  );

  /** Retire un exemplaire (annulation d'un ajout en série). */
  const retirerUnExemplaire = useCallback(
    (key) => {
      setEntries((current) => {
        const suivantes = retirerUn(current, key);
        if (!suivantes.some((entry) => entry.key === key)) oublier(key);
        return suivantes;
      });
    },
    [oublier],
  );

  const remove = useCallback(
    (key) => {
      // Sans cet oubli, la clé restait dans `pending` et dans `errors` : une
      // carte retirée puis rescannée réapparaissait avec l'erreur de son
      // ancienne vie, ou bloquée sur « en cours ».
      oublier(key);
      setEntries((current) => removeEntry(current, key));
    },
    [oublier],
  );

  const clear = useCallback(() => {
    // Le relevé en cours n'a plus d'objet : on l'interrompt au lieu de le
    // laisser écrire dans un inventaire vidé.
    abortRef.current?.abort();
    setRefreshing(false);
    setProgress({ done: 0, total: 0 });
    setPending(new Set());
    setErrors(new Map());
    setEntries([]);
  }, []);

  /**
   * Exporte ce qu'on lui donne, et l'inventaire entier par défaut.
   * Le bouton voisine avec un champ de filtre et un « total filtré » :
   * exporter autre chose que ce que l'utilisateur a sous les yeux serait un
   * piège.
   */
  const exportCsv = useCallback((liste) => downloadCsv(liste ?? entriesRef.current), []);

  const entryFor = useCallback(
    (key) => entries.find((entry) => entry.key === key) ?? null,
    [entries],
  );

  const total = useMemo(() => totalValue(entries), [entries]);

  return {
    remplacerTirage,
    retirerUnExemplaire,
    entries,
    entryFor,
    pending,
    errors,
    refreshing,
    progress,
    refreshAll,
    persiste,
    track,
    setCondition,
    remove,
    clear,
    exportCsv,
    total,
  };
}
