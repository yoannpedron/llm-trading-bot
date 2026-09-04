/**
 * Client YGOPRODeck.
 *
 * L'API n'expose aucune recherche par code d'extension : `cardinfo.php` ne
 * connaît que le nom de carte (`name`, `fname`) ou le nom complet d'une série
 * (`cardset`). On reconstruit donc le chemin en deux temps :
 *
 *   préfixe du code  ->  nom(s) de série  (via `cardsets.php`)
 *   nom de série     ->  cartes de la série, filtrées sur le code exact
 *
 * `cardsets.php` (~175 Ko) et chaque série (~300 Ko) ne sont téléchargés qu'une
 * fois par session : quand on dépouille un classeur, toutes les cartes après la
 * première tombent dans le cache mémoire et s'affichent instantanément.
 *
 * Quand le titre a été lu proprement, on tente d'abord `fname` : la réponse est
 * vingt fois plus légère. Attention, `fname` est une recherche par sous-chaîne
 * et non floue -- un titre mal OCRisé renvoie une 400 -- d'où le repli.
 */

import { setCodeMatchKey, titleSimilarity } from './parse.js';

const API = 'https://db.ygoprodeck.com/api/v7';

/** Caches de session, indexés par requête. */
const setIndexCache = { promise: null };
const setCardsCache = new Map();
const searchCache = new Map();

async function getJson(url, signal) {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (response.status === 400) return null; // « aucune carte ne correspond »
  if (!response.ok) throw new Error(`YGOPRODeck a répondu ${response.status}`);
  return response.json();
}

/** Index préfixe -> séries, construit une seule fois. */
function loadSetIndex(signal) {
  setIndexCache.promise ??= getJson(`${API}/cardsets.php`, signal)
    .then((sets) => {
      const index = new Map();
      for (const entry of sets ?? []) {
        const prefix = String(entry.set_code ?? '').toUpperCase();
        if (!prefix) continue;
        if (!index.has(prefix)) index.set(prefix, []);
        index.get(prefix).push(entry);
      }
      return index;
    })
    // Une coupure réseau ne doit pas condamner le cache pour toute la session.
    .catch((error) => {
      setIndexCache.promise = null;
      throw error;
    });

  return setIndexCache.promise;
}

function loadSetCards(setName, signal) {
  if (!setCardsCache.has(setName)) {
    setCardsCache.set(
      setName,
      getJson(`${API}/cardinfo.php?cardset=${encodeURIComponent(setName)}`, signal)
        .then((payload) => payload?.data ?? [])
        .catch((error) => {
          setCardsCache.delete(setName);
          throw error;
        }),
    );
  }
  return setCardsCache.get(setName);
}

function searchByName(fragment, signal) {
  const key = fragment.toLowerCase();
  if (!searchCache.has(key)) {
    searchCache.set(
      key,
      getJson(`${API}/cardinfo.php?fname=${encodeURIComponent(fragment)}`, signal)
        .then((payload) => payload?.data ?? [])
        .catch((error) => {
          searchCache.delete(key);
          throw error;
        }),
    );
  }
  return searchCache.get(key);
}

/** Met une carte de l'API sous la forme attendue par l'interface. */
function shapeCard(card, matchKey) {
  const printings = (card.card_sets ?? [])
    .filter((entry) => !matchKey || setCodeMatchKey(entry.set_code) === matchKey)
    .map((entry) => ({
      setName: entry.set_name,
      setCode: entry.set_code,
      rarity: entry.set_rarity,
      rarityCode: entry.set_rarity_code,
      setPrice: Number.parseFloat(entry.set_price) || 0,
    }));

  // Deux tirages peuvent partager code et rareté (rééditions) : on ne garde
  // qu'une entrée par rareté, c'est le seul axe que l'utilisateur doit trancher.
  const rarities = [];
  for (const printing of printings) {
    if (!rarities.some((known) => known.rarity === printing.rarity)) rarities.push(printing);
  }

  const images = (card.card_images ?? []).map((image) => ({
    id: image.id,
    full: image.image_url,
    small: image.image_url_small,
    cropped: image.image_url_cropped,
  }));

  const prices = card.card_prices?.[0] ?? {};

  return {
    id: card.id,
    name: card.name,
    type: card.type,
    race: card.race,
    attribute: card.attribute,
    atk: card.atk,
    def: card.def,
    level: card.level,
    desc: card.desc,
    images,
    image: images[0]?.full ?? null,
    referencePrices: {
      cardmarket: Number.parseFloat(prices.cardmarket_price) || 0,
      tcgplayer: Number.parseFloat(prices.tcgplayer_price) || 0,
      ebay: Number.parseFloat(prices.ebay_price) || 0,
    },
    printings,
    rarities,
    printingCount: (card.card_sets ?? []).length,
  };
}

const hasMatch = (card, matchKey) =>
  (card.card_sets ?? []).some((entry) => setCodeMatchKey(entry.set_code) === matchKey);

/**
 * Identifie une carte à partir de ce que l'OCR a pu lire.
 *
 * @param {{setCode?: {matchKey: string, prefix: string, code: string}, title?: string}} reading
 * @param {AbortSignal} [signal]
 * @returns {Promise<{card: object, via: 'title'|'set'|'title-only'} | null>}
 */
export async function identifyCard({ setCode, title }, signal) {
  // 1. Titre exploitable : la recherche par nom est de loin la plus légère.
  if (title && title.length >= 3) {
    const results = await searchByName(title, signal).catch(() => []);

    if (setCode) {
      const match = results.find((card) => hasMatch(card, setCode.matchKey));
      if (match) return { card: shapeCard(match, setCode.matchKey), via: 'title' };
    } else if (results.length) {
      // Sans code, on ne peut trancher que sur la ressemblance du nom.
      const best = results
        .map((card) => ({ card, score: titleSimilarity(title, card.name) }))
        .sort((a, b) => b.score - a.score)[0];
      if (best.score >= 0.72) return { card: shapeCard(best.card, null), via: 'title-only' };
    }
  }

  if (!setCode) return null;

  // 2. Chemin déterministe : le préfixe désigne la ou les séries à charger.
  const index = await loadSetIndex(signal);
  const sets = index.get(setCode.prefix) ?? [];
  if (sets.length === 0) return null;

  const batches = await Promise.all(
    sets.map((entry) => loadSetCards(entry.set_name, signal).catch(() => [])),
  );

  for (const cards of batches) {
    const match = cards.find((card) => hasMatch(card, setCode.matchKey));
    if (match) return { card: shapeCard(match, setCode.matchKey), via: 'set' };
  }

  return null;
}

/** Séries portant ce préfixe — utile pour expliquer un échec à l'utilisateur. */
export async function setsForPrefix(prefix, signal) {
  const index = await loadSetIndex(signal);
  return index.get(String(prefix).toUpperCase()) ?? [];
}
