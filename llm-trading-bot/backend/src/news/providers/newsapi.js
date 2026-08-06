import { getJson } from '../../utils/http.js';
import { config } from '../../config.js';

/**
 * NewsAPI.org — plan Developer gratuit (100 req/jour, articles < 24 h de délai).
 * Utile pour la presse généraliste qui n'apparaît pas dans les flux financiers.
 */
export const newsapiProvider = {
  name: 'newsapi',

  get isConfigured() {
    return Boolean(config.news.newsapiKey);
  },

  async fetchNews({ symbol, companyName, lookbackHours, maxArticles }) {
    const from = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
    const query = companyName ? `"${companyName}" OR ${symbol}` : symbol;

    const qs = new URLSearchParams({
      q: query,
      from,
      language: 'en',
      sortBy: 'publishedAt',
      pageSize: String(Math.min(maxArticles * 2, 50)),
    });

    const data = await getJson(`https://newsapi.org/v2/everything?${qs}`, {
      headers: { 'X-Api-Key': config.news.newsapiKey },
      timeoutMs: 10000,
      retries: 1,
    });

    if (data.status !== 'ok') throw new Error(data.message || 'réponse NewsAPI en erreur');

    return (data.articles || []).map((a) => ({
      title: a.title,
      summary: (a.description || '').slice(0, 400),
      url: a.url,
      source: a.source?.name || 'NewsAPI',
      publishedAt: a.publishedAt || null,
    }));
  },
};
