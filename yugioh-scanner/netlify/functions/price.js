/**
 * GET /api/price — cote d'une carte Yu-Gi-Oh!.
 *
 * Le navigateur ne peut pas interroger Cardmarket lui-même : le site ne renvoie
 * aucun en-tête CORS, et sa fiche produit est du HTML, pas une API. Cette
 * fonction fait donc l'aller-retour côté serveur, puis retombe sur les prix de
 * référence YGOPRODeck si Cardmarket ne répond pas.
 *
 * Le repli n'est pas un cas d'école : Cardmarket protège ses pages et interdit
 * la collecte automatisée dans ses conditions d'utilisation. Depuis les adresses
 * IP mutualisées d'un hébergeur, la requête est refusée la plupart du temps.
 * L'application reste donc utilisable en toutes circonstances, et le champ
 * `source` de la réponse dit toujours d'où vient le chiffre affiché.
 *
 * Paramètres : `name` (requis), `set`, `rarity`, `code`, `condition`.
 */

import {
  buildProductUrls,
  hasUsablePrices,
  parsePriceTable,
} from './_lib/cardmarket.js';

const YGOPRODECK = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';

/** Échelle d'état de Cardmarket, du meilleur au pire. Doit rester alignée sur
 *  `src/lib/condition.js`, qui la présente côté interface. */
const CONDITION_IDS = { MT: 1, NM: 2, EX: 3, GD: 4, LP: 5, PL: 6, PO: 7 };

/** Collecte activable/désactivable sans redéployer le front. */
const SCRAPE_ENABLED = process.env.CARDMARKET_SCRAPE !== 'false';

/** Au-delà, on n'attend plus : mieux vaut un prix de repli qu'une page qui rame. */
const CARDMARKET_TIMEOUT_MS = Number(process.env.CARDMARKET_TIMEOUT_MS ?? 4000);

/** Durée de vie du cache mémoire. Les cotes bougent au jour, pas à la minute. */
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map();

function readCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key, value) {
  // Une instance de fonction peut vivre longtemps : on borne le cache.
  if (cache.size > 500) cache.clear();
  cache.set(key, { at: Date.now(), value });
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Le CDN Netlify peut resservir la même cote pendant 10 minutes.
      'Cache-Control': 'public, max-age=0, s-maxage=600',
      'Access-Control-Allow-Origin': '*',
    },
  });

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CARDMARKET_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Tente de lire la fiche Cardmarket. Renvoie `null` dès que ça coince. */
async function fromCardmarket({ name, setName, rarity, conditionId }) {
  if (!SCRAPE_ENABLED || !setName) return null;

  for (const url of buildProductUrls({ name, setName, rarity, conditionId })) {
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          // Sans en-tête crédible, la page renvoie une redirection technique.
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept-Language': 'en-GB,en;q=0.9,fr;q=0.8',
          Accept: 'text/html,application/xhtml+xml',
        },
      });

      if (!response.ok) continue;

      const prices = parsePriceTable(await response.text());
      if (hasUsablePrices(prices)) {
        return {
          source: 'cardmarket',
          currency: 'EUR',
          prices,
          productUrl: url,
          // Dit à l'interface que le « à partir de » est déjà celui de l'état
          // demandé : elle l'affiche tel quel au lieu d'estimer.
          conditionApplied: Boolean(conditionId),
        };
      }
    } catch {
      // Délai dépassé, blocage, DNS : on passe à l'URL suivante puis au repli.
    }
  }

  return null;
}

/**
 * Repli : les prix de référence YGOPRODeck.
 * `cardmarket_price` est une moyenne toutes raretés confondues ; `set_price`
 * est propre au tirage. On renvoie les deux et on le dit.
 */
async function fromYgoprodeck({ name, setName, rarity, code, cardId, language }) {
  // On cherche par PASSCODE, jamais par nom.
  //
  // Le paramètre `name` de YGOPRODeck n'indexe que l'anglais, alors que le
  // client stocke — et envoie — le nom français, celui qu'il affiche. La
  // requête partait donc en 400 et cette fonction ne rendait jamais de prix de
  // repli. Vérifié contre l'API : `?name=Dragon Blanc aux Yeux Bleus` → 400 ;
  // `?id=89631139` → 200 avec les prix. Le passcode est la clé primaire de la
  // base, identique dans toutes les langues.
  //
  // Le nom ne sert plus que de repêchage, avec sa langue déclarée, pour une
  // requête ancienne dépourvue d'identifiant.
  const parametres = new URLSearchParams();
  if (cardId) parametres.set('id', cardId);
  else {
    parametres.set('name', name);
    if (language && language !== 'en') parametres.set('language', language);
  }

  const response = await fetch(`${YGOPRODECK}?${parametres}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return null;

  const card = (await response.json())?.data?.[0];
  if (!card) return null;

  const printings = card.card_sets ?? [];
  const printing =
    printings.find(
      (entry) =>
        (!code || entry.set_code === code) && (!rarity || entry.set_rarity === rarity),
    ) ??
    printings.find((entry) => !setName || entry.set_name === setName) ??
    null;

  const average = Number.parseFloat(card.card_prices?.[0]?.cardmarket_price) || null;
  const setPrice = Number.parseFloat(printing?.set_price) || null;

  return {
    source: 'ygoprodeck',
    currency: 'EUR',
    prices: {
      trend: average,
      // `set_price` est libellé en dollars : on ne le mélange pas à l'euro.
      setPriceUsd: setPrice,
    },
    printing: printing
      ? { setName: printing.set_name, setCode: printing.set_code, rarity: printing.set_rarity }
      : null,
    note:
      'Cardmarket n’a pas répondu : cote moyenne YGOPRODeck, toutes raretés confondues.',
  };
}

export default async (request) => {
  const url = new URL(request.url);
  const name = url.searchParams.get('name')?.trim();
  const setName = url.searchParams.get('set')?.trim() || '';
  const rarity = url.searchParams.get('rarity')?.trim() || '';
  const code = url.searchParams.get('code')?.trim() || '';
  const condition = url.searchParams.get('condition')?.trim().toUpperCase() || '';
  // Une valeur inconnue est ignorée plutôt que transmise telle quelle.
  const conditionId = CONDITION_IDS[condition] ?? null;

  // Le passcode, quand le client le connaît : c'est la clé primaire de la base
  // YGOPRODeck, et la seule qui soit indépendante de la langue. On le valide
  // comme un entier positif plutôt que de le recoller tel quel dans une URL.
  const brut = url.searchParams.get('id')?.trim() ?? '';
  const cardId = /^\d{1,10}$/.test(brut) && Number(brut) > 0 ? brut : null;
  const language = url.searchParams.get('language')?.trim().toLowerCase() || 'fr';

  // Le nom reste exigé : c'est lui qui sert à interroger Cardmarket, qui
  // n'expose pas de recherche par passcode.
  if (!name) {
    return json({ error: 'Paramètre « name » requis.' }, 400);
  }

  const cacheKey = `${cardId ?? name}|${setName}|${rarity}|${code}|${condition}`;
  const cached = readCache(cacheKey);
  if (cached) return json({ ...cached, cached: true });

  const searchUrl = `https://www.cardmarket.com/en/YuGiOh/Products/Search?searchString=${encodeURIComponent(name)}`;

  let result = null;
  try {
    result = await fromCardmarket({ name, setName, rarity, conditionId });
  } catch {
    result = null;
  }

  if (!result) {
    try {
      result = await fromYgoprodeck({ name, setName, rarity, code, cardId, language });
    } catch {
      result = null;
    }
  }

  if (!result) {
    return json(
      {
        error: 'Aucune cote trouvée pour cette carte.',
        card: { name, setName, rarity, code, condition },
        searchUrl,
      },
      404,
    );
  }

  const payload = {
    ...result,
    card: { name, setName, rarity, code, condition },
    searchUrl,
    fetchedAt: new Date().toISOString(),
  };

  writeCache(cacheKey, payload);
  return json(payload);
};
