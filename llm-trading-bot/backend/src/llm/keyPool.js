import crypto from 'node:crypto';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { JsonStore } from '../storage/JsonStore.js';
import { request, HttpError } from '../utils/http.js';

const log = createLogger('keypool');

/**
 * Pool de clés Gemini avec rotation et comptage de quota par clé.
 *
 * Le palier gratuit de Gemini est plafonné **par projet** (20 requêtes/jour pour
 * gemini-2.5-flash). Posséder plusieurs comptes gratuits multiplie donc la
 * capacité : 5 clés = 100 requêtes/jour. Ce module :
 *
 *   - agrège les clés venant de `.env` et celles ajoutées à chaud (API/CLI) ;
 *   - sélectionne à chaque appel la clé la moins utilisée encore disponible ;
 *   - marque une clé « épuisée » dès le premier HTTP 429 et bascule sur la
 *     suivante sans perdre le cycle en cours ;
 *   - remet les compteurs à zéro au changement de jour **heure du Pacifique**,
 *     puisque c'est le fuseau sur lequel Google réinitialise ses quotas.
 *
 * Les clés ajoutées à chaud sont écrites dans `data/llm-keys.json` (dossier
 * ignoré par git). Celles définies dans `.env` ne sont jamais persistées : le
 * fichier d'environnement reste leur source de vérité.
 */

/** Date au format YYYY-MM-DD dans le fuseau où Google réinitialise les quotas. */
const quotaDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());

const idOf = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);

const mask = (key) => (key.length <= 12 ? '••••' : `${key.slice(0, 6)}…${key.slice(-4)}`);

class KeyPool {
  constructor() {
    this.store = new JsonStore(config.storage.dir, 'llm-keys.json', {
      day: quotaDay(),
      keys: [],
    });
    this.envKeys = [];
    this.loaded = false;
  }

  async init() {
    await this.store.load();

    // Les clés de l'environnement sont reconstruites à chaque démarrage : si tu
    // en retires une du .env, elle disparaît vraiment du pool.
    this.envKeys = config.llm.apiKeys.map((key, index) => ({
      id: idOf(key),
      key,
      label: `env #${index + 1}`,
      source: 'env',
    }));

    this.loaded = true;
    await this.#rollDay();

    const capacity = await this.capacity();
    log.info(
      `${capacity.keys} clé(s) — capacité ${capacity.totalPerDay} appels/jour ` +
        `(${capacity.perKeyLimit}/clé), ${capacity.remaining} restant(s) aujourd'hui`,
    );
    return this;
  }

  async #ensureLoaded() {
    if (!this.loaded) await this.init();
    else await this.#rollDay();
  }

  async #rollDay() {
    const today = quotaDay();
    if (this.store.data.day !== today) {
      this.store.data.day = today;
      for (const entry of this.store.data.keys) {
        entry.calls = 0;
        entry.exhaustedAt = null;
        entry.exhaustReason = null;
      }
      this.#usage.clear();
      await this.store.save();
      log.info('Changement de jour (fuseau Pacifique) — quotas des clés remis à zéro.');
    }
  }

  /** Compteurs des clés `.env`, en mémoire + miroir persisté pour survivre au redémarrage. */
  #usage = new Map();

  #stateOf(entry) {
    if (entry.source === 'store') {
      const stored = this.store.data.keys.find((k) => k.id === entry.id);
      return stored ?? { calls: 0, exhaustedAt: null };
    }
    if (!this.#usage.has(entry.id)) {
      const persisted = this.store.data.keys.find((k) => k.id === entry.id && k.source === 'env-usage');
      this.#usage.set(entry.id, persisted ?? { id: entry.id, source: 'env-usage', calls: 0, exhaustedAt: null });
      if (!persisted) this.store.data.keys.push(this.#usage.get(entry.id));
    }
    return this.#usage.get(entry.id);
  }

  /** Toutes les clés utilisables, dédoublonnées (une même clé dans .env et en base ne compte qu'une fois). */
  #allKeys() {
    const seen = new Set();
    const out = [];
    for (const entry of [...this.envKeys, ...this.store.data.keys.filter((k) => k.source === 'store')]) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
    return out;
  }

  /**
   * Réserve une clé pour un appel. Retourne `null` si toutes sont épuisées.
   * Stratégie : la clé la moins utilisée d'abord, pour lisser la consommation
   * plutôt que de vider les clés une par une.
   */
  async acquire() {
    await this.#ensureLoaded();
    const limit = config.llm.callsPerKeyPerDay;

    const available = this.#allKeys()
      .map((entry) => ({ entry, state: this.#stateOf(entry) }))
      .filter(({ state }) => !state.exhaustedAt && (limit <= 0 || state.calls < limit))
      .sort((a, b) => a.state.calls - b.state.calls);

    if (!available.length) return null;

    const { entry } = available[0];
    return { id: entry.id, key: entry.key, label: entry.label, masked: mask(entry.key) };
  }

  async recordUse(id) {
    await this.#ensureLoaded();
    const entry = this.#allKeys().find((k) => k.id === id);
    if (!entry) return;
    const state = this.#stateOf(entry);
    state.calls += 1;
    state.lastUsedAt = new Date().toISOString();
    await this.store.save();
  }

  /** Marque une clé comme épuisée jusqu'au prochain reset (typiquement sur un 429). */
  async markExhausted(id, reason = 'quota atteint') {
    await this.#ensureLoaded();
    const entry = this.#allKeys().find((k) => k.id === id);
    if (!entry) return;
    const state = this.#stateOf(entry);
    state.exhaustedAt = new Date().toISOString();
    state.exhaustReason = reason;
    await this.store.save();
    log.warn(`Clé ${mask(entry.key)} (${entry.label}) épuisée : ${reason}`);
  }

  /**
   * Teste une clé auprès de Google sans consommer de quota de génération.
   * `GET /models` valide que la clé existe, est activée et que l'API est
   * joignable — ce qui permet de distinguer trois cas très différents pour
   * l'utilisateur : clé invalide, quota atteint, ou réseau bloqué.
   */
  async probe(key) {
    try {
      await request(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, {
        timeoutMs: 12000,
        retries: 0,
        retryOnRateLimit: false,
      });
      return { ok: true, state: 'valide', message: 'Clé valide et active.' };
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 429) {
          return { ok: true, state: 'quota_atteint', message: 'Clé valide mais quota déjà atteint aujourd\'hui.' };
        }
        if (err.status === 400) {
          return { ok: false, state: 'invalide', message: 'Clé refusée par Google (format invalide).' };
        }
        if (err.status === 403) {
          return { ok: false, state: 'refusee', message: 'Clé refusée : révoquée, ou API Generative Language non activée sur ce projet.' };
        }
        return { ok: false, state: 'erreur', message: `Google a répondu HTTP ${err.status}.` };
      }
      // Ni 4xx ni 5xx : DNS, pare-feu ou coupure réseau.
      return {
        ok: null,
        state: 'injoignable',
        message: `API Gemini injoignable (${err.cause?.code || err.message}). Vérifie ton DNS ou ton pare-feu — la clé n'a pas pu être testée.`,
      };
    }
  }

  /** Re-teste une clé déjà dans le pool et met à jour son état d'épuisement. */
  async check(id) {
    await this.#ensureLoaded();
    const entry = this.#allKeys().find((k) => k.id === id);
    if (!entry) throw new Error('clé introuvable');

    const result = await this.probe(entry.key);
    const state = this.#stateOf(entry);

    if (result.state === 'quota_atteint') {
      state.exhaustedAt = state.exhaustedAt ?? new Date().toISOString();
      state.exhaustReason = 'quota atteint (vérification manuelle)';
    } else if (result.ok === true) {
      // La clé répond de nouveau : on lève un éventuel marquage prématuré.
      state.exhaustedAt = null;
      state.exhaustReason = null;
    } else if (result.ok === false) {
      state.exhaustedAt = new Date().toISOString();
      state.exhaustReason = result.message;
    }

    await this.store.save();
    return { id, masked: mask(entry.key), label: entry.label, ...result };
  }

  /** Re-teste toutes les clés du pool, en parallèle. */
  async checkAll() {
    await this.#ensureLoaded();
    const keys = this.#allKeys();
    const results = await Promise.all(keys.map((entry) => this.check(entry.id).catch((err) => ({
      id: entry.id,
      masked: mask(entry.key),
      ok: false,
      state: 'erreur',
      message: err.message,
    }))));
    return results;
  }

  /**
   * Recalibre le plafond journalier à partir du corps d'une erreur 429.
   *
   * Google ne renvoie AUCUN en-tête de quota quand l'appel réussit : le seul
   * moment où l'API révèle la limite réelle, c'est dans le `QuotaFailure` du
   * 429. On l'exploite pour corriger une valeur configurée à tort — un palier
   * gratuit qui change, ou une clé sur un projet au quota différent.
   *
   * @returns {number|null} la limite détectée, ou null si illisible
   */
  calibrateFrom429(body) {
    if (!body) return null;
    try {
      const payload = typeof body === 'string' ? JSON.parse(body) : body;
      const violation = (payload?.error?.details || [])
        .flatMap((d) => d.violations || [])
        .find((v) => v.quotaValue != null);

      const detected = Number(violation?.quotaValue);
      if (!Number.isFinite(detected) || detected <= 0) return null;

      if (detected !== config.llm.callsPerKeyPerDay) {
        log.warn(
          `Quota réel annoncé par Google : ${detected}/jour/clé ` +
            `(configuré : ${config.llm.callsPerKeyPerDay}). Recalibrage automatique.`,
        );
        config.llm.callsPerKeyPerDay = detected;
      }
      return detected;
    } catch {
      return null;
    }
  }

  async add(key, label = null) {
    await this.#ensureLoaded();
    const trimmed = String(key || '').trim();
    if (trimmed.length < 20) throw new Error('clé trop courte pour être valide');

    const id = idOf(trimmed);
    if (this.#allKeys().some((k) => k.id === id)) throw new Error('cette clé est déjà dans le pool');

    const entry = {
      id,
      key: trimmed,
      label: label || `clé ${this.#allKeys().length + 1}`,
      source: 'store',
      calls: 0,
      exhaustedAt: null,
      addedAt: new Date().toISOString(),
    };
    this.store.data.keys.push(entry);
    await this.store.save();
    log.info(`Clé ${mask(trimmed)} ajoutée au pool (${entry.label}).`);
    return { id: entry.id, label: entry.label, masked: mask(trimmed) };
  }

  async remove(id) {
    await this.#ensureLoaded();
    const before = this.store.data.keys.length;
    this.store.data.keys = this.store.data.keys.filter((k) => !(k.id === id && k.source === 'store'));
    if (this.store.data.keys.length === before) {
      if (this.envKeys.some((k) => k.id === id)) {
        throw new Error('cette clé vient de GEMINI_API_KEYS : retire-la du fichier .env');
      }
      throw new Error('clé introuvable');
    }
    await this.store.save();
    log.info(`Clé ${id} retirée du pool.`);
    return true;
  }

  /** Liste masquée — ne renvoie JAMAIS le matériel de clé. */
  async list() {
    await this.#ensureLoaded();
    const limit = config.llm.callsPerKeyPerDay;
    return this.#allKeys().map((entry) => {
      const state = this.#stateOf(entry);
      return {
        id: entry.id,
        label: entry.label,
        masked: mask(entry.key),
        source: entry.source,
        calls: state.calls ?? 0,
        remaining: limit > 0 ? Math.max(0, limit - (state.calls ?? 0)) : null,
        exhausted: Boolean(state.exhaustedAt),
        exhaustedAt: state.exhaustedAt ?? null,
        lastUsedAt: state.lastUsedAt ?? null,
      };
    });
  }

  /**
   * Capacité du pool et ce qu'elle permet concrètement, en cycles par jour.
   * C'est ce calcul qui doit guider le réglage de CRON_SCHEDULE.
   */
  async capacity() {
    await this.#ensureLoaded();
    const keys = this.#allKeys();
    const perKeyLimit = config.llm.callsPerKeyPerDay;

    const used = keys.reduce((sum, entry) => sum + (this.#stateOf(entry).calls ?? 0), 0);
    const exhausted = keys.filter((entry) => this.#stateOf(entry).exhaustedAt).length;

    const totalPerDay = perKeyLimit > 0 ? keys.length * perKeyLimit : Infinity;
    const remaining = Number.isFinite(totalPerDay) ? Math.max(0, totalPerDay - used) : Infinity;

    const callsPerCycle = config.universe.symbols.length;
    const cyclesPerDay = Number.isFinite(totalPerDay) && callsPerCycle > 0
      ? Math.floor(totalPerDay / callsPerCycle)
      : Infinity;

    return {
      keys: keys.length,
      keysExhausted: exhausted,
      perKeyLimit,
      totalPerDay,
      used,
      remaining,
      callsPerCycle,
      cyclesPerDay,
      recommendedCron: recommendCron(cyclesPerDay),
      resetsAt: `minuit heure du Pacifique (jour de quota courant : ${this.store.data.day})`,
    };
  }
}

/**
 * Traduit un nombre de cycles quotidiens en expression cron réaliste.
 * On reste sur des intervalles ronds : un cron « toutes les 3,7 heures » n'a
 * aucun intérêt et rend le journal illisible.
 */
export function recommendCron(cyclesPerDay) {
  if (!Number.isFinite(cyclesPerDay)) return '*/15 * * * *';
  if (cyclesPerDay < 1) return 'aucun cycle possible — ajoute des clés';
  if (cyclesPerDay >= 96) return '*/15 * * * *';
  if (cyclesPerDay >= 48) return '*/30 * * * *';
  if (cyclesPerDay >= 24) return '0 * * * *';
  if (cyclesPerDay >= 12) return '0 */2 * * *';
  if (cyclesPerDay >= 8) return '0 */3 * * *';
  if (cyclesPerDay >= 6) return '0 */4 * * *';
  if (cyclesPerDay >= 4) return '0 */6 * * *';
  if (cyclesPerDay >= 2) return '0 */12 * * *';
  return '0 9 * * *';
}

export const keyPool = new KeyPool();
