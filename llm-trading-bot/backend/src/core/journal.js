import crypto from 'node:crypto';
import { JsonStore } from '../storage/JsonStore.js';
import { config } from '../config.js';

/**
 * Journal de bord de l'IA : trace chaque décision (exécutée OU non) avec le
 * raisonnement, les données qui l'ont motivée et le verdict du gestionnaire de
 * risque. C'est la pièce maîtresse du dashboard et le seul moyen d'auditer
 * a posteriori pourquoi le bot a fait ce qu'il a fait.
 */
export class Journal {
  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
    this.store = new JsonStore(config.storage.dir, 'journal.json', {
      entries: [],
      cycles: [],
      lastCycleAt: null,
    });
  }

  async init() {
    await this.store.load();
    return this;
  }

  async record(entry) {
    const full = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.store.data.entries.unshift(full);
    if (this.store.data.entries.length > this.maxEntries) {
      this.store.data.entries.length = this.maxEntries;
    }
    await this.store.save();
    return full;
  }

  async recordCycle(summary) {
    const full = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...summary };
    this.store.data.cycles.unshift(full);
    if (this.store.data.cycles.length > 200) this.store.data.cycles.length = 200;
    this.store.data.lastCycleAt = full.timestamp;
    await this.store.save();
    return full;
  }

  entries(limit = 50, symbol = null) {
    const all = this.store.data.entries;
    const filtered = symbol ? all.filter((e) => e.symbol === symbol) : all;
    return filtered.slice(0, limit);
  }

  cycles(limit = 20) {
    return this.store.data.cycles.slice(0, limit);
  }

  get lastCycleAt() {
    return this.store.data.lastCycleAt;
  }

  async reset() {
    await this.store.reset();
  }
}
