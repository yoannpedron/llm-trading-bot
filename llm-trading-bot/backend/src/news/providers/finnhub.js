import { getJson } from '../../utils/http.js';
import { config } from '../../config.js';

const day = (d) => d.toISOString().slice(0, 10);

/**
 * Finnhub — actualités société (endpoint gratuit `company-news`, 60 req/min).
 * Meilleure qualité que le RSS : articles typés, datés, dédupliqués par la source.
 */
export const finnhubProvider = {
  name: 'finnhub',

  get isConfigured() {
    return Boolean(config.news.finnhubKey);
  },

  async fetchNews({ symbol, lookbackHours, maxArticles }) {
    const to = new Date();
    const from = new Date(to.getTime() - Math.max(lookbackHours, 24) * 3600_000);

    const qs = new URLSearchParams({
      symbol,
      from: day(from),
      to: day(to),
      token: config.news.finnhubKey,
    });

    const data = await getJson(`https://finnhub.io/api/v1/company-news?${qs}`, { timeoutMs: 10000, retries: 1 });
    if (!Array.isArray(data)) throw new Error('réponse Finnhub inattendue');

    return data.slice(0, maxArticles * 2).map((a) => ({
      title: a.headline,
      summary: (a.summary || '').slice(0, 400),
      url: a.url,
      source: a.source || 'Finnhub',
      publishedAt: a.datetime ? new Date(a.datetime * 1000).toISOString() : null,
    }));
  },
};
