/**
 * Graphe d'entités du marché — support de l'anonymisation stricte.
 *
 * Le protocole de Glasserman & Lin ne se contente pas de masquer la raison
 * sociale. Il exige d'identifier « l'entreprise cible, mais aussi ses
 * dirigeants, ses filiales et ses produits emblématiques », et de remplacer le
 * tout par des marqueurs génériques. Leur exemple est explicite :
 * « Le PDG de [ENTREPRISE_A] annonce des retards sur le [PRODUIT_B] ».
 *
 * Deux raisons rendent ce niveau de détail indispensable :
 *
 * 1. Un dirigeant identifie son entreprise aussi sûrement que son nom. Masquer
 *    « Tesla » en laissant « Musk » n'anonymise rien.
 *
 * 2. Les entreprises TIERCES permettent la triangulation. Un titre réduit à
 *    « [ENTREPRISE_A] Lifts Dow, But Google, SpaceX Skid » livre le contexte
 *    complet : le modèle reconstitue la cible sans effort.
 *
 * Le rapport préconisait un NER local (spaCy) couplé à un graphe de
 * connaissances. Sur un univers de dix valeurs, un dictionnaire curé est plus
 * fiable qu'un NER probabiliste : pas de faux négatifs sur les entités qui
 * comptent, et aucune dépendance Python à installer.
 *
 * ── Passage à 150 valeurs ────────────────────────────────────────────────
 * Le dictionnaire curé ne tient plus à la main. Deux sources se superposent
 * désormais, et l'ordre compte :
 *
 *   1. UNIVERSE_ENTITIES ci-dessous, écrit à la main, qui fait autorité ;
 *   2. `entities.generated.json`, produit par `npm run entities:build`, qui
 *      complète les symboles absents de (1).
 *
 * Cette superposition crée un risque qu'il faut nommer : une couverture
 * PARTIELLE est pire qu'aucune couverture, parce qu'elle donne l'illusion que
 * la mesure est propre. Un article sur AMD dont on masque « AMD » mais pas
 * « Lisa Su » n'est pas anonymisé — il est seulement plus difficile à lire.
 * Le modèle, lui, identifie la société au premier nom de dirigeant venu.
 *
 * D'où `entityCoverage()` : la couverture est VÉRIFIÉE au démarrage et les
 * symboles non couverts sont signalés, jamais ignorés en silence.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Dictionnaire généré. Absent tant que `npm run entities:build` n'a pas
 * tourné — ce n'est pas une erreur, c'est l'état initial, et la couverture le
 * dira.
 */
const GENERATED = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(path.join(here, 'entities.generated.json'), 'utf8'));
  } catch {
    return {};
  }
})();

/**
 * Entités de notre univers. `names` inclut les variantes orthographiques
 * rencontrées dans la presse financière.
 */
export const UNIVERSE_ENTITIES = {
  NVDA: {
    names: ['NVIDIA Corporation', 'NVIDIA', 'Nvidia'],
    executives: ['Jensen Huang', 'Huang', 'Colette Kress'],
    products: ['Blackwell', 'Hopper', 'GeForce', 'CUDA', 'RTX', 'H100', 'H200', 'GB200', 'DGX'],
    subsidiaries: ['Mellanox', 'Arm Holdings'],
  },
  TSLA: {
    names: ['Tesla, Inc.', 'Tesla'],
    executives: ['Elon Musk', 'Musk', 'Vaibhav Taneja'],
    products: ['Cybertruck', 'Model 3', 'Model Y', 'Model S', 'Model X', 'Optimus', 'Powerwall', 'Megapack', 'Full Self-Driving', 'FSD', 'Autopilot', 'Roadster', 'Semi'],
    subsidiaries: ['SolarCity', 'Gigafactory'],
  },
  AAPL: {
    names: ['Apple Inc.', 'Apple'],
    executives: ['Tim Cook', 'Cook', 'Luca Maestri', 'Kevan Parekh'],
    products: ['iPhone', 'iPad', 'MacBook', 'Apple Watch', 'AirPods', 'Vision Pro', 'App Store', 'iOS', 'macOS', 'Apple Intelligence', 'Siri', 'Mac'],
    subsidiaries: ['Beats', 'Shazam'],
  },
  MSFT: {
    names: ['Microsoft Corporation', 'Microsoft'],
    executives: ['Satya Nadella', 'Nadella', 'Amy Hood'],
    products: ['Azure', 'Windows', 'Office', 'Copilot', 'Xbox', 'Teams', 'Bing', 'Dynamics'],
    subsidiaries: ['LinkedIn', 'GitHub', 'Activision Blizzard', 'Activision', 'Nuance'],
  },
  AMZN: {
    names: ['Amazon.com', 'Amazon'],
    executives: ['Andy Jassy', 'Jassy', 'Jeff Bezos', 'Bezos', 'Brian Olsavsky'],
    products: ['AWS', 'Prime', 'Alexa', 'Kindle', 'Echo', 'Bedrock', 'Trainium'],
    subsidiaries: ['Whole Foods', 'Twitch', 'Zoox', 'MGM', 'Audible'],
  },
  GOOGL: {
    names: ['Alphabet Inc.', 'Alphabet', 'Google'],
    executives: ['Sundar Pichai', 'Pichai', 'Ruth Porat', 'Anat Ashkenazi'],
    products: ['Gemini', 'Search', 'Android', 'Chrome', 'Google Cloud', 'Pixel', 'Workspace', 'TPU'],
    subsidiaries: ['YouTube', 'Waymo', 'DeepMind', 'Verily', 'Fitbit'],
  },
  META: {
    names: ['Meta Platforms', 'Meta'],
    executives: ['Mark Zuckerberg', 'Zuckerberg', 'Susan Li'],
    products: ['Facebook', 'Instagram', 'WhatsApp', 'Threads', 'Quest', 'Llama', 'Ray-Ban Meta'],
    subsidiaries: ['Reality Labs', 'Oculus'],
  },
  AMD: {
    names: ['Advanced Micro Devices', 'AMD'],
    executives: ['Lisa Su', 'Su', 'Jean Hu'],
    products: ['Ryzen', 'EPYC', 'Radeon', 'Instinct', 'MI300', 'MI350', 'Threadripper'],
    subsidiaries: ['Xilinx', 'ZT Systems'],
  },
  NFLX: {
    names: ['Netflix, Inc.', 'Netflix'],
    executives: ['Ted Sarandos', 'Sarandos', 'Greg Peters', 'Spencer Neumann'],
    products: ['Stranger Things', 'Squid Game', 'Wednesday'],
    subsidiaries: [],
  },
  AVGO: {
    names: ['Broadcom Inc.', 'Broadcom'],
    executives: ['Hock Tan', 'Tan', 'Kirsten Spears'],
    products: ['Tomahawk', 'Jericho', 'Trident'],
    subsidiaries: ['VMware', 'CA Technologies', 'Symantec', 'Brocade'],
  },
  SPY: {
    names: ['SPDR S&P 500 ETF', 'SPY'],
    executives: [],
    products: [],
    subsidiaries: [],
  },
};

/**
 * Entreprises tierces fréquentes dans la presse financière.
 *
 * Sans elles, la triangulation reste triviale : un titre où seule la cible est
 * masquée mais où les concurrents restent nommés livre le contexte complet.
 */
export const THIRD_PARTY_ENTITIES = [
  'OpenAI', 'Anthropic', 'SpaceX', 'xAI', 'Intel', 'Qualcomm', 'Micron',
  'Texas Instruments', 'Applied Materials', 'Lam Research', 'KLA', 'ASML',
  'TSMC', 'Taiwan Semiconductor', 'Samsung', 'SK Hynix', 'Western Digital',
  'Sandisk', 'Seagate', 'Marvell', 'Astera Labs', 'Amphenol', 'Arista',
  'Super Micro', 'Supermicro', 'Dell', 'HP', 'Hewlett Packard', 'IBM',
  'Oracle', 'Salesforce', 'Adobe', 'Palantir', 'Snowflake', 'CrowdStrike',
  'ServiceNow', 'Uber', 'Lyft', 'Airbnb', 'Coinbase', 'Robinhood',
  'Rivian', 'Lucid', 'Ford', 'General Motors', 'GM', 'Toyota', 'Volkswagen',
  'BYD', 'NIO', 'Xpeng', 'Li Auto', 'Stellantis',
  'Walmart', 'Target', 'Costco', 'Home Depot',
  'JPMorgan', 'Goldman Sachs', 'Morgan Stanley', 'Bank of America', 'Citigroup',
  'Berkshire Hathaway', 'Berkshire', 'Warren Buffett', 'Buffett',
  'Disney', 'Comcast', 'Warner Bros', 'Paramount', 'Roku', 'Spotify',
  'Boeing', 'Lockheed', 'Raytheon', 'Palo Alto Networks',
  'Pfizer', 'Moderna', 'Eli Lilly', 'Novo Nordisk', 'Johnson & Johnson',
  'Exxon', 'Chevron', 'Shell', 'BP',
  'Jim Cramer', 'Cathie Wood', 'Jerome Powell', 'Powell',
];

const VIDE = { names: [], executives: [], products: [], subsidiaries: [] };

/**
 * Toutes les entités connues d'un symbole, à plat.
 * Le dictionnaire écrit à la main l'emporte sur le généré.
 */
export function entitiesFor(symbol) {
  return UNIVERSE_ENTITIES[symbol] ?? GENERATED[symbol] ?? VIDE;
}

/**
 * État de la couverture d'anonymisation sur un univers.
 *
 * Le critère de « couvert » n'est pas « existe dans le dictionnaire » mais
 * « possède un nom ET des dirigeants ET des produits ». Un symbole réduit à sa
 * raison sociale est déjà traité par `buildRedactionTerms`, qui ajoute le
 * ticker et le nom de société : l'entrée n'apporterait rien. Ce qui fait la
 * différence entre MASQUER et ANONYMISER, ce sont précisément les dirigeants
 * et les produits — les deux voies de réidentification les plus directes.
 */
export function entityCoverage(symbols) {
  const couverts = [];
  const partiels = [];
  const absents = [];

  for (const s of symbols) {
    const e = UNIVERSE_ENTITIES[s] ?? GENERATED[s];
    if (!e) { absents.push(s); continue; }
    const complet = (e.names?.length ?? 0) > 0
      && (e.executives?.length ?? 0) > 0
      && (e.products?.length ?? 0) > 0;
    (complet ? couverts : partiels).push(s);
  }

  const total = symbols.length || 1;
  return {
    total: symbols.length,
    couverts: couverts.length,
    partiels,
    absents,
    part: couverts.length / total,
    manuels: Object.keys(UNIVERSE_ENTITIES).length,
    generes: Object.keys(GENERATED).length,
  };
}

/** Personnalités publiques tierces, distinguées des sociétés pour la lisibilité. */
const THIRD_PARTY_PEOPLE = new Set([
  'Jim Cramer', 'Cathie Wood', 'Jerome Powell', 'Powell', 'Warren Buffett', 'Buffett',
]);

/**
 * Entités appartenant à d'autres acteurs que la cible.
 *
 * Sociétés et personnes sont séparées : produire « [AUTRE_SOCIETE] CEO
 * [AUTRE_SOCIETE] » rendrait la phrase incompréhensible, alors que
 * « [AUTRE_SOCIETE] CEO [AUTRE_DIRIGEANT] » conserve la structure sémantique
 * tout en supprimant l'identité. On veut masquer, pas mutiler.
 */
export function competitorEntities(targetSymbol) {
  const companies = [];
  const people = [];

  for (const [symbol, e] of Object.entries(UNIVERSE_ENTITIES)) {
    if (symbol === targetSymbol) continue;
    companies.push(...e.names, ...e.subsidiaries);
    people.push(...e.executives);
  }

  for (const entity of THIRD_PARTY_ENTITIES) {
    (THIRD_PARTY_PEOPLE.has(entity) ? people : companies).push(entity);
  }

  return { companies, people };
}
