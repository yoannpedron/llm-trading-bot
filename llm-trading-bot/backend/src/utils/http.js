/**
 * Client HTTP minimal : timeout, retry exponentiel, User-Agent navigateur.
 * Toutes les intégrations externes (marché, news, LLM) passent par ici afin
 * qu'une API indisponible ne bloque jamais le cycle de trading.
 */

const DEFAULT_UA = 'Mozilla/5.0 (compatible; llm-trading-bot/1.0)';

export class HttpError extends Error {
  constructor(status, statusText, body, url) {
    super(`HTTP ${status} ${statusText} — ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function request(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 15000,
  retries = 2,
  retryDelayMs = 600,
  rateLimitDelayMs = 8000,
  // À désactiver quand l'appelant a une meilleure réponse au 429 qu'attendre
  // (par exemple : basculer sur une autre clé d'API).
  retryOnRateLimit = true,
} = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...headers },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new HttpError(res.status, res.statusText, text.slice(0, 500), url);
        // 4xx (hors 408/429) : inutile de réessayer, la requête est invalide.
        if (res.status < 500 && res.status !== 408 && res.status !== 429) throw err;
        if (res.status === 429 && !retryOnRateLimit) throw err;
        // Quota dépassé : on respecte Retry-After si le serveur l'indique,
        // sinon on attend nettement plus longtemps qu'un simple 5xx.
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after'));
          err.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : rateLimitDelayMs * (attempt + 1);
        }
        lastError = err;
      } else {
        return res;
      }
    } catch (err) {
      lastError = err;
      if (err instanceof HttpError && err.status < 500 && err.status !== 408 && err.status !== 429) {
        throw err;
      }
      if (err instanceof HttpError && err.status === 429 && !retryOnRateLimit) throw err;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < retries) {
      await sleep(lastError?.retryAfterMs ?? retryDelayMs * 2 ** attempt);
    }
  }

  throw lastError ?? new Error(`Échec de la requête ${url}`);
}

export async function getJson(url, options = {}) {
  const res = await request(url, options);
  return res.json();
}

export async function postJson(url, payload, options = {}) {
  const res = await request(url, {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function getText(url, options = {}) {
  const res = await request(url, options);
  return res.text();
}
