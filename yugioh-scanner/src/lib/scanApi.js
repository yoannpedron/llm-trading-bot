/**
 * Point d'entrée unique de la résolution, quel que soit l'hébergement.
 *
 * Avec `VITE_API_BASE`, tout passe par le backend Python : SQLite, variantes
 * régionales générées, `rapidfuzz`. Sans lui — c'est le cas sur GitHub Pages,
 * qui ne sert que des fichiers — la même logique s'exécute dans le navigateur
 * sur l'index embarqué. Les deux chemins rendent la même forme de réponse, et
 * `source` dit lequel a répondu.
 *
 * La différence tient à la régionalisation : le backend *engendre* les variantes
 * (`RA03-EN001` → `RA03-FR001`), le client *retire* la région avant de comparer.
 * Résultat identique, index six fois plus petit côté navigateur.
 */

import { loadCardIndex } from './cardIndex.js';
import { resolveSetCode } from './match.js';
import { extractSetCode } from './parse.js';
import { subtitleFr, attributeFr, raceFr, typeFr } from './frenchLabels.js';

const API = (import.meta.env?.VITE_API_BASE ?? '').replace(/\/$/, '');
const YGOPRODECK = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';

export const usingBackend = () => Boolean(API);

/**
 * Réponse du backend Python, remise à la forme du client.
 *
 * @param {string} raw la lecture envoyée, pour retrouver la région inscrite
 *   sur la carte : le backend ne la renvoie pas, et l'affichage en a besoin
 *   pour ne pas mettre en français un code lu « EN ».
 */
function fromBackend(payload, raw) {
  if (payload.status === 'no_code' || payload.status === 'no_match') return payload;

  const rarities = (payload.rarities ?? []).map((entry) => ({
    rarity: entry.rarity,
    rarityCode: entry.rarity_code,
    setName: entry.set_name,
    setCode: entry.set_code,
    priceEur: entry.price_eur,
    setPriceUsd: entry.set_price_usd,
  }));

  return {
    status: payload.status,
    source: 'backend',
    read: payload.read,
    code: payload.code,
    matchedCode: payload.matched_code,
    regionLue: extractSetCode(raw)?.region ?? '',
    method: payload.method,
    confidence: payload.confidence,
    regional: Boolean(payload.synthetic),
    card: payload.card,
    rarities,
    printings: rarities,
  };
}

/**
 * Résout une lecture OCR.
 * @param {string} raw texte brut lu dans le viseur
 */
export async function scanCode(raw, signal) {
  if (API) {
    const response = await fetch(`${API}/api/scan`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ raw }),
    });
    if (!response.ok) throw new Error(`L’API a répondu ${response.status}`);
    return fromBackend(await response.json(), raw);
  }

  const index = await loadCardIndex();
  const resolved = resolveSetCode(index, raw);
  if (resolved.status !== 'matched') return { ...resolved, source: 'local' };

  return {
    ...resolved,
    source: 'local',
    // Une seule rareté : rien à demander. Plusieurs : la caméra ne voit pas
    // l'holographie, c'est à l'utilisateur de trancher.
    status: resolved.rarities.length > 1 ? 'needs_user_selection' : 'resolved',
  };
}

/** Fiche détaillée, textes traduits, image officielle. */
export async function cardDetail(cardId, { language = 'fr' } = {}, signal) {
  if (API) {
    const response = await fetch(`${API}/api/card/${cardId}?language=${language}`, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Fiche indisponible (${response.status})`);
    return response.json();
  }

  const params = new URLSearchParams({ id: String(cardId) });
  // `language=en` n'est pas une valeur acceptée : l'anglais est le défaut.
  if (language && language !== 'en') params.set('language', language);

  const response = await fetch(`${YGOPRODECK}?${params}`, {
    signal,
    headers: { Accept: 'application/json' },
  });

  // La base traduite ne contient pas toutes les cartes : on retombe sur
  // l'anglais plutôt que de n'afficher qu'un cadre vide.
  if (response.status === 400 && language !== 'en') {
    return cardDetail(cardId, { language: 'en' }, signal);
  }
  if (!response.ok) throw new Error(`Fiche indisponible (${response.status})`);

  const card = (await response.json())?.data?.[0];
  if (!card) throw new Error('Carte introuvable');

  const prices = card.card_prices?.[0] ?? {};
  const image = card.card_images?.[0] ?? {};

  return {
    id: card.id,
    name: card.name,
    type: typeFr(card.type),
    race: raceFr(card.race),
    attribute: attributeFr(card.attribute),
    subtitle: subtitleFr(card),
    atk: card.atk,
    def: card.def,
    level: card.level,
    linkval: card.linkval,
    desc: card.desc,
    image: image.image_url,
    image_small: image.image_url_small,
    prices: {
      cardmarket_eur: Number.parseFloat(prices.cardmarket_price) || null,
      tcgplayer_usd: Number.parseFloat(prices.tcgplayer_price) || null,
    },
  };
}
