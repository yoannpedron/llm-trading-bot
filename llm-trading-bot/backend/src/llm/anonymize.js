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
 * ── Termes ambigus : masqués en respectant la casse ───────────────────────
 *
 * La censure était insensible à la casse, ce qui est correct pour « Nvidia »
 * ou « NVIDIA » mais catastrophique pour les tickers courts qui sont aussi des
 * mots anglais courants. Vérifié sur un texte réel :
 *
 *   NOW (ServiceNow) → « it will [ENTREPRISE_A] expand »
 *   SO  (Southern)   → « expand, [ENTREPRISE_A] analysts see »
 *   PM  (Philip Morris) → « Shares rose 3% at 4 [ENTREPRISE_A] »
 *
 * Le défaut était invisible sur l'univers de dix valeurs — aucun de leurs
 * tickers n'est un mot anglais — et devient massif à 150, où figurent SO, MO,
 * PM, NOW, CAT, DE, ALL. Il ne s'agissait pas d'un excès de prudence : le
 * modèle recevait des phrases dont les mots de liaison avaient disparu, et
 * c'est sa lecture entière qui était dégradée.
 *
 * La règle : un terme court ou ambigu n'est masqué que s'il apparaît dans la
 * casse EXACTE où on le connaît. « NOW » en majuscules dans une dépêche désigne
 * probablement ServiceNow ; « now » en minuscules est un adverbe. Les termes
 * longs et distinctifs — « Nvidia », « Blackwell » — restent insensibles à la
 * casse, où le risque de collision est nul.
 *
 * Le seuil est fixé à 4 caractères : en dessous, aucun terme n'a assez de
 * spécificité pour qu'une collision soit improbable.
 */
const LONGUEUR_SANS_AMBIGUITE = 5;

/**
 * Mots anglais courants qui sont aussi des raisons sociales ou des tickers.
 * Même longs, ils exigent la correspondance de casse.
 */
const MOTS_COURANTS = new Set([
  'now', 'all', 'key', 'cat', 'see', 'has', 'was', 'one', 'two', 'off', 'out',
  'target', 'discover', 'progressive', 'core', 'prime', 'vision', 'united',
  'general', 'standard', 'national', 'american', 'global', 'first', 'power',
  'energy', 'digital', 'mobile', 'express', 'direct', 'secure', 'smart', 'open',
  'java', 'mint', 'arc', 'gobi', 'hill', 'dram', 'nand', 'live', 'next', 'edge',
]);

/**
 * Un terme doit-il être masqué en respectant la casse ?
 * Exporté pour que le test puisse vérifier la règle elle-même, et pas seulement
 * ses conséquences sur un exemple.
 */
export function requiresExactCase(term) {
  return term.length < LONGUEUR_SANS_AMBIGUITE || MOTS_COURANTS.has(term.toLowerCase());
}

/**
 * ── Collisions que la casse ne peut pas trancher ──────────────────────────
 *
 * « PM », ticker de Philip Morris, et « PM », l'heure, s'écrivent exactement
 * pareil : majuscules dans les deux cas. La règle de casse ne sert à rien ici,
 * et la presse financière écrit constamment « closed at 4 PM ET ».
 *
 * Ce qui les sépare est le CONTEXTE, pas l'orthographe : une heure est précédée
 * d'un chiffre. On refuse donc la censure dans ce seul cas, ce qui laisse
 * intacte la censure du ticker cité normalement (« PM lagged »).
 *
 * La liste est courte et le restera : elle ne doit contenir que des termes dont
 * l'homographe est à la fois fréquent ET reconnaissable à un motif fixe. Tout
 * le reste relève de la règle de casse.
 */
const CONTEXTES_A_EPARGNER = {
  // Heures : « 4 PM », « 9:30 AM », « 16h30 PM ».
  PM: /(?<=\d[\s:h.]*)$/,
  AM: /(?<=\d[\s:h.]*)$/,
};

/** Le terme, à cette position, est-il un homographe à épargner ? */
function estHomographe(term, texteAvant) {
  const motif = CONTEXTES_A_EPARGNER[term];
  return Boolean(motif) && motif.test(texteAvant);
}

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
    // `i` seulement pour les termes assez longs et assez distinctifs pour que
    // la collision soit impossible. Voir requiresExactCase.
    const pattern = new RegExp(`\\b${escapeRegex(term)}\\b`, requiresExactCase(term) ? 'g' : 'gi');
    out = out.replace(pattern, (match, offset, whole) => {
      if (estHomographe(term, whole.slice(0, offset))) return match;
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
