import { getText } from '../../utils/http.js';

/**
 * Fournisseur d'actualités de dernier recours : flux RSS publics, sans clé API.
 * - Yahoo Finance headlines : très ciblé sur le ticker.
 * - Google News : agrège Reuters, Bloomberg, CNBC, FT… sur une requête libre.
 * C'est le filet de sécurité qui garantit que le LLM a toujours du contexte
 * fondamental, même si NewsAPI et Finnhub sont hors quota.
 */

const stripCdata = (s) => s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');

const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

const stripTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(stripCdata(m[1].trim())) : '';
}

/** Parseur RSS minimal — suffisant pour des flux <item> standards. */
export function parseRss(xml, sourceLabel) {
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  return items.map((block) => {
    const published = tag(block, 'pubDate');
    return {
      title: stripTags(tag(block, 'title')),
      summary: stripTags(tag(block, 'description')).slice(0, 400),
      url: tag(block, 'link'),
      source: stripTags(tag(block, 'source')) || sourceLabel,
      publishedAt: published ? new Date(published).toISOString() : null,
    };
  });
}

export const rssProvider = {
  name: 'rss',
  isConfigured: true,

  async fetchNews({ symbol, companyName, maxArticles }) {
    const query = encodeURIComponent(`${companyName || symbol} stock`);
    const feeds = [
      {
        url: `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`,
        label: 'Yahoo Finance',
      },
      {
        url: `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`,
        label: 'Google News',
      },
    ];

    const settled = await Promise.allSettled(
      feeds.map(async (feed) => parseRss(await getText(feed.url, { timeoutMs: 10000, retries: 1 }), feed.label)),
    );

    const articles = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (!articles.length) throw new Error('aucun flux RSS exploitable');
    return articles.slice(0, maxArticles * 2);
  },
};
