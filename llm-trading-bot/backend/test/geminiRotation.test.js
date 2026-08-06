import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Trois clés, quota d'un appel chacune : de quoi observer la rotation.
const TMP_DIR = path.join(os.tmpdir(), `bot-rotation-${Date.now()}`);
process.env.DATA_DIR = TMP_DIR;
process.env.GEMINI_API_KEYS = 'cle-rotation-alpha-000000,cle-rotation-beta-1111111,cle-rotation-gamma-222222';
process.env.GEMINI_API_KEY = '';
process.env.LLM_CALLS_PER_KEY_PER_DAY = '5';
process.env.SYMBOLS = 'TSLA';

const { keyPool } = await import('../src/llm/keyPool.js');
const { geminiProvider } = await import('../src/llm/providers/gemini.js');

const realFetch = globalThis.fetch;

/** Réponse Gemini valide minimale. */
const okResponse = (text = '{"action":"HOLD"}') =>
  new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { totalTokenCount: 42 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

const errorResponse = (status) =>
  new Response(JSON.stringify({ error: { message: `simulé ${status}` } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Extrait la clé de l'URL appelée, pour savoir laquelle a servi. */
const keyFromUrl = (url) => new URL(url).searchParams.get('key');

after(async () => {
  globalThis.fetch = realFetch;
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

describe('rotation des clés Gemini', () => {
  before(async () => {
    await keyPool.init();
  });

  beforeEach(() => {
    globalThis.fetch = realFetch;
  });

  test('bascule sur la clé suivante quand la première renvoie 429', async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(keyFromUrl(url));
      // La première clé essayée est à sec, la suivante répond.
      return calls.length === 1 ? errorResponse(429) : okResponse();
    };

    const result = await geminiProvider.decide('prompt de test');

    assert.equal(calls.length, 2, 'deux clés doivent avoir été essayées');
    assert.notEqual(calls[0], calls[1], 'la seconde tentative doit utiliser une autre clé');
    assert.equal(result.raw, '{"action":"HOLD"}');

    const exhausted = (await keyPool.list()).filter((k) => k.exhausted);
    assert.equal(exhausted.length, 1, 'seule la clé en 429 est marquée épuisée');
  });

  test('une clé invalide (403) est écartée sans consommer les autres quotas', async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(keyFromUrl(url));
      return calls.length === 1 ? errorResponse(403) : okResponse();
    };

    await geminiProvider.decide('prompt de test');
    assert.equal(calls.length, 2);

    const exhausted = (await keyPool.list()).filter((k) => k.exhausted);
    assert.equal(exhausted.length, 2, 'la clé 429 précédente + la clé 403');
  });

  test('lève une erreur explicite quand toutes les clés sont épuisées', async () => {
    globalThis.fetch = async () => errorResponse(429);

    await assert.rejects(
      () => geminiProvider.decide('prompt de test'),
      /épuisées|utilisable/,
      'le message doit indiquer que le pool est à sec',
    );

    assert.equal(await keyPool.acquire(), null);
  });

  test('une erreur réseau ne brûle pas les autres clés', async () => {
    // Nouveau pool propre pour ce scénario.
    await keyPool.add('cle-reseau-test-3333333333', 'reseau');
    const before = (await keyPool.list()).filter((k) => k.exhausted).length;

    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };

    await assert.rejects(() => geminiProvider.decide('prompt de test'), /fetch failed/);

    const after = (await keyPool.list()).filter((k) => k.exhausted).length;
    assert.equal(after, before, 'aucune clé supplémentaire ne doit être marquée épuisée');
  });
});
