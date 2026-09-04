/**
 * Index de cartes embarqué.
 *
 * Le fichier `card-index.json` est produit au build par `scripts/build-index.mjs`
 * à partir de YGOPRODeck : 14 523 cartes et 44 499 tirages réduits à l'essentiel,
 * soit environ 440 Ko une fois servis gzippés. Le télécharger une fois rend toute
 * l'identification locale — donc instantanée, tolérante à l'erreur, et utilisable
 * sans réseau.
 *
 * S'il manque (développement sans avoir lancé le script, build sans réseau),
 * l'application n'est pas bloquée : elle retombe sur l'interrogation directe de
 * l'API, moins tolérante mais fonctionnelle.
 */

import { buildSearchIndex } from './match.js';

const BASE = import.meta.env?.BASE_URL ?? '/';
const IMAGES = 'https://images.ygoprodeck.com/images';
const API = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';

let indexPromise = null;
const detailCache = new Map();

/** Charge et prépare l'index. Un échec n'est pas mémorisé : on pourra réessayer. */
export function loadCardIndex() {
  indexPromise ??= fetch(`${BASE}card-index.json`, { headers: { Accept: 'application/json' } })
    .then((response) => {
      if (!response.ok) throw new Error(`index absent (${response.status})`);
      return response.json();
    })
    .then((raw) => {
      if (!Array.isArray(raw?.cards)) throw new Error('index illisible');
      return buildSearchIndex(raw);
    })
    .catch((error) => {
      indexPromise = null;
      throw error;
    });

  return indexPromise;
}

/**
 * Met une entrée d'index sous la forme attendue par l'interface.
 *
 * Les visuels ne sont pas stockés : leur URL se déduit du passcode, qui *est*
 * l'identifiant YGOPRODeck. Autant d'octets épargnés dans l'index.
 */
export function cardFromIndex(entry, printings) {
  return {
    id: entry.id,
    name: entry.name,
    image: `${IMAGES}/cards/${entry.id}.jpg`,
    images: [
      {
        id: entry.id,
        full: `${IMAGES}/cards/${entry.id}.jpg`,
        small: `${IMAGES}/cards_small/${entry.id}.jpg`,
        cropped: `${IMAGES}/cards_cropped/${entry.id}.jpg`,
      },
    ],
    printings: printings ?? entry.printings,
    rarities: distinct(printings ?? entry.printings),
    printingCount: entry.printings.length,
    referencePrices: null,
  };
}

function distinct(printings) {
  const seen = [];
  for (const printing of printings) {
    if (!seen.some((known) => known.rarity === printing.rarity)) seen.push(printing);
  }
  return seen;
}

/**
 * Complète une carte avec ce que l'index ne porte pas : texte, statistiques,
 * illustrations alternatives, prix de référence.
 *
 * Volontairement séparé de l'identification : la carte s'affiche immédiatement
 * avec ce que l'index sait, et se précise quand la réponse arrive. Un échec
 * réseau ne prive donc de rien d'essentiel.
 */
export async function enrichCard(card, signal) {
  if (detailCache.has(card.id)) return { ...card, ...detailCache.get(card.id) };

  const response = await fetch(`${API}?id=${card.id}`, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`détails indisponibles (${response.status})`);

  const detail = (await response.json())?.data?.[0];
  if (!detail) throw new Error('carte absente de la base de détails');

  const prices = detail.card_prices?.[0] ?? {};
  const extra = {
    type: detail.type,
    race: detail.race,
    attribute: detail.attribute,
    atk: detail.atk,
    def: detail.def,
    level: detail.level,
    desc: detail.desc,
    images: (detail.card_images ?? []).map((image) => ({
      id: image.id,
      full: image.image_url,
      small: image.image_url_small,
      cropped: image.image_url_cropped,
    })),
    referencePrices: {
      cardmarket: Number.parseFloat(prices.cardmarket_price) || 0,
      tcgplayer: Number.parseFloat(prices.tcgplayer_price) || 0,
      ebay: Number.parseFloat(prices.ebay_price) || 0,
    },
  };

  detailCache.set(card.id, extra);
  return { ...card, ...extra, image: extra.images[0]?.full ?? card.image };
}
