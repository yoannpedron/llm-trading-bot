/**
 * Récupération de la cote, côté navigateur.
 *
 * En production sur Netlify, `/api/price` fait l'aller-retour vers Cardmarket.
 * Mais l'application doit aussi tourner sur un hébergement purement statique
 * (GitHub Pages, `vite preview`) où cette fonction n'existe pas. On tente donc
 * l'appel, et à la première absence de réponse exploitable on bascule
 * définitivement sur YGOPRODeck — qui, lui, sert des en-têtes CORS.
 *
 * Ce n'est pas une dégradation silencieuse : `source` remonte jusqu'à
 * l'interface, qui affiche d'où vient le chiffre.
 */

const YGOPRODECK = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';

/** Passe à `false` dès qu'on constate qu'aucune fonction n'est déployée. */
let functionsAvailable = true;

function priceFromCard(card, { setName, rarity, code }) {
  const printings = card.card_sets ?? [];
  const printing =
    printings.find(
      (entry) => (!code || entry.set_code === code) && (!rarity || entry.set_rarity === rarity),
    ) ??
    printings.find((entry) => !setName || entry.set_name === setName) ??
    null;

  return {
    source: 'ygoprodeck',
    currency: 'EUR',
    prices: {
      trend: Number.parseFloat(card.card_prices?.[0]?.cardmarket_price) || null,
      setPriceUsd: Number.parseFloat(printing?.set_price) || null,
    },
    card: { name: card.name, setName, rarity, code },
    searchUrl: `https://www.cardmarket.com/en/YuGiOh/Products/Search?searchString=${encodeURIComponent(card.name)}`,
    note: 'Cote moyenne YGOPRODeck, toutes raretés confondues.',
    fetchedAt: new Date().toISOString(),
  };
}

async function directLookup(query, signal) {
  const response = await fetch(`${YGOPRODECK}?name=${encodeURIComponent(query.name)}`, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`YGOPRODeck a répondu ${response.status}`);

  const card = (await response.json())?.data?.[0];
  if (!card) throw new Error('Carte introuvable dans la base de prix.');
  return priceFromCard(card, query);
}

/**
 * @param {{name: string, setName?: string, rarity?: string, code?: string,
 *   condition?: string}} query
 * @param {AbortSignal} [signal]
 */
export async function fetchPrice(query, signal) {
  if (functionsAvailable) {
    const params = new URLSearchParams({ name: query.name });
    if (query.setName) params.set('set', query.setName);
    if (query.rarity) params.set('rarity', query.rarity);
    if (query.code) params.set('code', query.code);
    if (query.condition) params.set('condition', query.condition);

    try {
      const response = await fetch(`/api/price?${params}`, {
        signal,
        headers: { Accept: 'application/json' },
      });

      // Un hébergeur statique renvoie l'index HTML sur une route inconnue :
      // le type de contenu suffit à conclure qu'il n'y a pas de back-end.
      const isJson = response.headers.get('content-type')?.includes('application/json');
      if (!isJson) {
        functionsAvailable = false;
      } else if (response.ok) {
        return response.json();
      } else if (response.status !== 404) {
        throw new Error(`La fonction de prix a répondu ${response.status}`);
      }
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      functionsAvailable = false;
    }
  }

  return directLookup(query, signal);
}

/** Vrai tant qu'on n'a pas constaté l'absence de back-end. */
export const hasPriceBackend = () => functionsAvailable;
