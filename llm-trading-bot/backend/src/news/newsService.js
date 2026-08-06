import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { getJson } from '../utils/http.js';
import { finnhubProvider } from './providers/finnhub.js';
import { newsapiProvider } from './providers/newsapi.js';
import { rssProvider } from './providers/rss.js';
import { buildRedactionTerms } from '../llm/anonymize.js';

const log = createLogger('news');

const REGISTRY = {
  finnhub: finnhubProvider,
  newsapi: newsapiProvider,
  rss: rssProvider,
};

const nameCache = new Map();
const newsCache = new Map();
const NEWS_TTL_MS = 10 * 60_000;

/**
 * Résout le nom commercial derrière un ticker (TSLA → Tesla, Inc.).
 * Les requêtes news sur le seul ticker ramènent trop de bruit ; le nom société
 * améliore nettement la pertinence sur NewsAPI et Google News.
 */
async function resolveCompanyName(symbol) {
  if (nameCache.has(symbol)) return nameCache.get(symbol);
  let name = null;
  try {
    const data = await getJson(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=1&newsCount=0`,
      { timeoutMs: 8000, retries: 1 },
    );
    const quote = data?.quotes?.[0];
    name = quote?.longname || quote?.shortname || null;
  } catch (err) {
    log.debug(`Nom société introuvable pour ${symbol} : ${err.message}`);
  }
  nameCache.set(symbol, name);
  return name;
}

const normalizeTitle = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);

/**
 * Ne conserve que les articles qui mentionnent réellement l'entreprise ciblée.
 *
 * Ce filtre n'est pas cosmétique. Mesuré sur NVDA : le flux « headline » de
 * Yahoo Finance ne renvoie que 3 articles pertinents sur 20 — c'est un flux
 * sectoriel qui remonte Astera Labs, Amphenol ou Applied Materials. Comme le
 * classement se fait par date, ce bruit chassait les articles pertinents de
 * Google News (100 % de pertinence) hors de la fenêtre transmise au modèle.
 *
 * Conséquence observée avant correction : le LLM répondait, à juste titre,
 * que « les actualités ne concernent pas directement l'actif analysé ». Le
 * canal fondamental était donc structurellement inopérant.
 */
function isRelevant(article, terms) {
  if (!terms.length) return true; // aucun terme identifiable : on ne filtre pas
  const haystack = `${article.title || ''} ${article.summary || ''}`.toLowerCase();
  return terms.some((term) => haystack.includes(term.toLowerCase()));
}

function dedupeAndRank(articles, lookbackHours, maxArticles, terms = []) {
  const cutoff = Date.now() - lookbackHours * 3600_000;
  const seen = new Set();

  return articles
    .filter((a) => a?.title && a.title.length > 12)
    .filter((a) => isRelevant(a, terms))
    .filter((a) => {
      // Une date absente n'est pas un motif d'exclusion (fréquent en RSS).
      if (!a.publishedAt) return true;
      const ts = Date.parse(a.publishedAt);
      return Number.isNaN(ts) ? true : ts >= cutoff;
    })
    .filter((a) => {
      const key = normalizeTitle(a.title);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (Date.parse(b.publishedAt || 0) || 0) - (Date.parse(a.publishedAt || 0) || 0))
    .slice(0, maxArticles);
}

/**
 * Récupère les actualités d'un actif en essayant les fournisseurs dans l'ordre
 * configuré. Ne lève jamais : en cas d'échec total, retourne une enveloppe vide
 * avec `degraded: true` pour que le prompt le signale explicitement au LLM.
 *
 * @returns {Promise<{symbol, companyName, articles, provider, degraded, errors}>}
 */
export async function getNews(symbol) {
  const cached = newsCache.get(symbol);
  if (cached && Date.now() - cached.at < NEWS_TTL_MS) return cached.value;

  const companyName = await resolveCompanyName(symbol);
  const params = {
    symbol,
    companyName,
    lookbackHours: config.news.lookbackHours,
    maxArticles: config.news.maxArticles,
  };

  // Mêmes termes que ceux servant à l'anonymisation : ce qui identifie
  // l'entreprise est aussi ce qui rend un article pertinent.
  const terms = buildRedactionTerms(symbol, companyName);

  const errors = [];
  const collected = [];
  let usedProvider = null;

  for (const key of config.news.providers) {
    const provider = REGISTRY[key];
    if (!provider) {
      errors.push(`${key} : fournisseur inconnu`);
      continue;
    }
    if (!provider.isConfigured) {
      errors.push(`${key} : non configuré (clé absente)`);
      continue;
    }

    try {
      const articles = await provider.fetchNews(params);
      if (articles?.length) {
        collected.push(...articles);
        usedProvider = usedProvider ? `${usedProvider}+${provider.name}` : provider.name;
        // Un fournisseur riche suffit : on s'arrête dès qu'on a la quantité voulue.
        if (dedupeAndRank(collected, params.lookbackHours, params.maxArticles, terms).length >= params.maxArticles) break;
      } else {
        errors.push(`${key} : 0 article`);
      }
    } catch (err) {
      errors.push(`${key} : ${err.message}`);
      log.warn(`Fournisseur ${key} en échec sur ${symbol} : ${err.message}`);
    }
  }

  const articles = dedupeAndRank(collected, params.lookbackHours, params.maxArticles, terms);
  const value = {
    symbol,
    companyName,
    articles,
    provider: usedProvider,
    degraded: articles.length === 0,
    errors,
    collectedCount: collected.length,
    relevantCount: articles.length,
    fetchedAt: new Date().toISOString(),
  };

  if (value.degraded) {
    log.warn(`Aucune actualité pour ${symbol} — le LLM décidera sur la seule technique.`, errors);
  } else {
    const dropped = collected.length - articles.length;
    log.info(
      `${articles.length} articles pertinents pour ${symbol} via ${usedProvider}` +
        (dropped > 0 ? ` (${dropped} écartés comme hors-sujet)` : ''),
    );
  }

  newsCache.set(symbol, { at: Date.now(), value });
  return value;
}
