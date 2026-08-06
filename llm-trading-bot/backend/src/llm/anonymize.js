import { entitiesFor, competitorEntities } from './entities.js';

/**
 * Anonymisation stricte, selon le protocole de Glasserman & Lin (2023).
 *
 * ── Le problème ───────────────────────────────────────────────────────────
 * Un LLM « sait » que NVIDIA a été multiplié par dix. Cette connaissance
 * préalable, attachée au NOM, interfère avec l'évaluation d'une nouvelle
 * isolée : le modèle lit une alerte négative avec complaisance parce que sa
 * mémoire de long terme est haussière. C'est « l'effet de distraction », et il
 * est maximal sur les grandes capitalisations — exactement notre univers.
 *
 * Leur résultat contre-intuitif : les stratégies fondées sur des titres
 * ANONYMISÉS surperforment celles utilisant les vrais noms, et affichent un
 * bêta de marché plus faible. Retirer l'identité force le modèle à évaluer le
 * choc idiosyncratique pour ce qu'il est.
 *
 * ── Quatre couches, parce que trois ne suffisent pas ──────────────────────
 * 1. Raison sociale et ticker            → [ENTREPRISE_A]
 * 2. Dirigeants                          → [DIRIGEANT_A]
 * 3. Produits et filiales emblématiques  → [PRODUIT_A] / [FILIALE_A]
 * 4. Entreprises TIERCES                 → [ENTREPRISE_B], [ENTREPRISE_C]…
 *
 * La quatrième couche est celle qu'on oublie, et c'est la plus décisive. Un
 * titre réduit à « [ENTREPRISE_A] Lifts Dow, But Google, SpaceX Skid » livre
 * tout le contexte : la cible se reconstitue sans effort. Masquer la cible
 * sans masquer son voisinage ne produit qu'une illusion d'anonymat.
 *
 * Le traitement est local et se fait en amont de l'appel : il ne coûte aucun
 * token et n'ajoute aucune latence réseau.
 */

/** Termes trop génériques pour être masqués utilement. */
const STOPWORDS = new Set([
  'inc', 'corp', 'corporation', 'company', 'co', 'ltd', 'llc', 'plc', 'sa', 'nv',
  'the', 'and', 'group', 'holdings', 'technologies', 'technology', 'systems',
  'international', 'com', 'class', 'incorporated', 'platforms', 'devices',
]);

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Termes identifiant directement l'entreprise cible.
 * Sert à la fois à l'anonymisation et au filtre de pertinence des actualités :
 * ce qui identifie une entreprise est aussi ce qui rend un article pertinent.
 */
export function buildRedactionTerms(symbol, companyName) {
  const terms = new Set();
  const known = entitiesFor(symbol);

  if (symbol) {
    terms.add(symbol);
    const base = symbol.split(/[.\-]/)[0];
    if (base.length >= 2) terms.add(base);
  }

  for (const name of [companyName, ...known.names]) {
    if (!name) continue;
    terms.add(name);
    for (const word of name.split(/[\s,.]+/)) {
      const clean = word.replace(/[^\p{L}\p{N}]/gu, '');
      if (clean.length >= 3 && !STOPWORDS.has(clean.toLowerCase())) terms.add(clean);
    }
  }

  // Les termes longs d'abord : masquer « Tesla, Inc. » avant « Tesla » évite
  // de laisser un « , Inc. » orphelin derrière le jeton de remplacement.
  return [...terms].sort((a, b) => b.length - a.length);
}

/** Applique une liste de termes avec un jeton donné. */
function applyLayer(text, terms, token) {
  let out = text;
  let count = 0;

  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    if (!term || term.length < 2) continue;
    const pattern = new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi');
    out = out.replace(pattern, () => {
      count += 1;
      return token;
    });
  }
  return { text: out, count };
}

/**
 * Anonymise un texte en quatre couches.
 *
 * @param {string} text
 * @param {object} layers  { target, executives, products, subsidiaries, competitors }
 */
export function redactAll(text, layers) {
  if (!text) return { text: '', redactions: 0, byLayer: {} };

  let out = text;
  const byLayer = {};
  let total = 0;

  // Ordre délibéré : les entités les plus spécifiques d'abord. Masquer
  // « Apple Watch » avant « Apple » évite de produire « [ENTREPRISE_A] Watch »,
  // qui resterait parfaitement identifiable.
  const passes = [
    ['products', layers.products, '[PRODUIT_A]'],
    ['subsidiaries', layers.subsidiaries, '[FILIALE_A]'],
    ['executives', layers.executives, '[DIRIGEANT_A]'],
    ['target', layers.target, '[ENTREPRISE_A]'],
    ['competitorPeople', layers.competitorPeople, '[AUTRE_DIRIGEANT]'],
    ['competitors', layers.competitors, '[AUTRE_SOCIETE]'],
  ];

  for (const [name, terms, token] of passes) {
    if (!terms?.length) continue;
    const r = applyLayer(out, terms, token);
    out = r.text;
    byLayer[name] = r.count;
    total += r.count;
  }

  // Des jetons répétés d'affilée après substitution sont illisibles.
  for (const token of ['[ENTREPRISE_A]', '[AUTRE_SOCIETE]', '[AUTRE_DIRIGEANT]', '[PRODUIT_A]', '[DIRIGEANT_A]', '[FILIALE_A]']) {
    out = out.replace(new RegExp(`(${escapeRegex(token)}[\\s,'’]*){2,}`, 'g'), `${token} `);
  }

  return { text: out.trim(), redactions: total, byLayer };
}

/** Conservé pour compatibilité : masquage simple par liste de termes. */
export function redact(text, terms, token = '[ENTREPRISE_A]') {
  if (!text || !terms.length) return { text: text ?? '', redactions: 0 };
  const r = applyLayer(text, terms, token);
  const cleaned = r.text.replace(new RegExp(`(${escapeRegex(token)}[\\s,]*){2,}`, 'g'), `${token} `);
  return { text: cleaned.trim(), redactions: r.count };
}

/**
 * Anonymise un paquet d'actualités selon le protocole complet.
 *
 * Les URL ne sont jamais transmises au modèle : inutile de les traiter, et
 * elles contiennent presque toujours le nom de l'entreprise en clair.
 */
export function anonymizeNews(news, symbol) {
  if (!news?.articles?.length) return { articles: [], redactions: 0, byLayer: {} };

  const known = entitiesFor(symbol);
  const others = competitorEntities(symbol);
  const layers = {
    target: buildRedactionTerms(symbol, news.companyName),
    executives: known.executives,
    products: known.products,
    subsidiaries: known.subsidiaries,
    competitorPeople: others.people,
    competitors: others.companies,
  };

  let total = 0;
  const byLayer = {};

  const articles = news.articles.map((a) => {
    const title = redactAll(a.title, layers);
    const summary = redactAll(a.summary, layers);
    total += title.redactions + summary.redactions;

    for (const [k, v] of Object.entries({ ...title.byLayer })) byLayer[k] = (byLayer[k] || 0) + v;
    for (const [k, v] of Object.entries({ ...summary.byLayer })) byLayer[k] = (byLayer[k] || 0) + v;

    return {
      ...a,
      title: title.text,
      summary: summary.text,
      // La source (Reuters, Bloomberg…) est conservée : elle informe sur la
      // fiabilité de l'information sans révéler l'identité de l'entreprise.
    };
  });

  return { articles, redactions: total, byLayer, terms: layers.target };
}
