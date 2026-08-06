import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('storage');

/**
 * Persistance fichier JSON, volontairement simple (zéro dépendance native,
 * déployable sur n'importe quel PaaS). Écriture atomique via fichier temporaire
 * + rename pour ne jamais laisser un état corrompu en cas de coupure.
 *
 * Pour passer à SQLite/Postgres plus tard : ré-implémenter `load`/`save` avec la
 * même signature, le reste du code n'a pas à changer.
 */
export class JsonStore {
  constructor(dir, filename, defaults = {}) {
    this.dir = dir;
    this.file = path.join(dir, filename);
    this.defaults = defaults;
    this.data = structuredClone(defaults);
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const raw = await fs.readFile(this.file, 'utf8');
      this.data = { ...structuredClone(this.defaults), ...JSON.parse(raw) };
      log.info(`État chargé depuis ${this.file}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        log.info(`Aucun état existant, initialisation de ${this.file}`);
        await this.save();
      } else {
        log.error(`Lecture de ${this.file} impossible (${err.message}) — réinitialisation.`);
        await this.backupCorrupted();
        this.data = structuredClone(this.defaults);
        await this.save();
      }
    }
    return this.data;
  }

  async backupCorrupted() {
    try {
      await fs.rename(this.file, `${this.file}.corrupted-${Date.now()}`);
    } catch {
      // le fichier n'existe pas ou est verrouillé : rien à sauvegarder
    }
  }

  /** Sérialise les écritures pour éviter deux `rename` concurrents. */
  save() {
    this.writeQueue = this.writeQueue.then(async () => {
      const tmp = `${this.file}.tmp`;
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      await fs.rename(tmp, this.file);
    }).catch((err) => {
      log.error(`Échec d'écriture de ${this.file} : ${err.message}`);
    });
    return this.writeQueue;
  }

  async update(mutator) {
    mutator(this.data);
    await this.save();
    return this.data;
  }

  async reset() {
    this.data = structuredClone(this.defaults);
    await this.save();
    return this.data;
  }
}
