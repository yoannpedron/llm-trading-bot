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

/**
 * Nombre exploitable, ou `null`.
 *
 * `Number.parseFloat(x) || null` était employé partout : l'opérateur `||`
 * traite `0` comme une absence, et une carte réellement cotée à zéro — le cas
 * ordinaire des communes de vieilles séries — était présentée comme « cote
 * inconnue ». Ce n'est pas la même information.
 */
const nombre = (valeur) => {
  const converti = Number.parseFloat(valeur);
  return Number.isFinite(converti) ? converti : null;
};

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
      trend: nombre(card.card_prices?.[0]?.cardmarket_price),
      setPriceUsd: nombre(printing?.set_price),
    },
    card: { name: card.name, setName, rarity, code },
    searchUrl: `https://www.cardmarket.com/en/YuGiOh/Products/Search?searchString=${encodeURIComponent(card.name)}`,
    // Cette réserve n'est pas une formalité : YGOPRODeck ne publie qu'un prix
    // Cardmarket au niveau de la CARTE, toutes séries et toutes raretés
    // confondues. Une Secret Rare et une Commune du même nom y valent le même
    // chiffre. Seule une vraie interrogation Cardmarket, par le backend,
    // distingue les tirages — l'interface doit donc afficher cette mention.
    note: 'Moyenne YGOPRODeck, toutes séries et raretés confondues.',
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Interrogation directe de YGOPRODeck.
 *
 * **On cherche par passcode, jamais par nom.** Le passcode est la clé primaire
 * de la base : huit chiffres, identiques dans toutes les langues. Le nom, lui,
 * n'est indexé qu'en anglais par le paramètre `name`.
 *
 * Or l'inventaire ne stocke que le nom FRANÇAIS, puisque c'est celui qu'on
 * affiche. La requête partait donc avec « Dragon Blanc aux Yeux Bleus » sur un
 * index anglais : réponse 400, exception, aucune cote. Et comme `/api/price`
 * n'existe pas sur un hébergement statique, c'était le seul chemin — **aucune
 * carte n'obtenait jamais de prix sur le site déployé**, sans autre signe
 * qu'un tiret à la place du montant. Vérifié contre l'API :
 *
 *     ?name=Dragon Blanc aux Yeux Bleus   → 400
 *     ?name=Blue-Eyes White Dragon        → 200
 *     ?id=89631139                        → 200, avec les prix
 *
 * Le nom ne sert plus que de repêchage pour une entrée ancienne dépourvue
 * d'identifiant, et il part alors avec la langue déclarée.
 */
async function directLookup(query, signal) {
  const parametres = new URLSearchParams();
  if (Number.isFinite(Number(query.cardId)) && Number(query.cardId) > 0) {
    parametres.set('id', String(Number(query.cardId)));
  } else if (query.name) {
    parametres.set('name', query.name);
    // Sans identifiant, le nom stocké est celui qu'on affiche : français.
    if (query.language && query.language !== 'en') parametres.set('language', query.language);
  } else {
    throw new Error('Ni identifiant ni nom : impossible d’interroger la base de prix.');
  }

  const response = await fetch(`${YGOPRODECK}?${parametres}`, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`YGOPRODeck a répondu ${response.status}`);

  const card = (await response.json())?.data?.[0];
  if (!card) throw new Error('Carte introuvable dans la base de prix.');
  return priceFromCard(card, query);
}

/**
 * @param {{cardId?: number, name?: string, language?: string, setName?: string,
 *   rarity?: string, code?: string, condition?: string}} query
 * @param {AbortSignal} [signal]
 */
export async function fetchPrice(query, signal) {
  if (functionsAvailable) {
    const params = new URLSearchParams({ name: query.name ?? '' });
    // Le passcode d'abord : la fonction s'en sert pour son repli YGOPRODeck,
    // qui ne saurait rien faire du nom français.
    if (query.cardId) params.set('id', String(query.cardId));
    if (query.language) params.set('language', query.language);
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
