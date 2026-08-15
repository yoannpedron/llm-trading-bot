import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from '../logger.js';

const log = createLogger('sqlite');

/**
 * Stockage du carnet fantôme.
 *
 * ── Pourquoi ce fichier existe ────────────────────────────────────────────
 * Le carnet vivait dans un JSON réécrit INTÉGRALEMENT à chaque décision
 * (`JSON.stringify` de tout le tableau, puis remplacement du fichier). Tant
 * qu'on suivait 10 actifs — 30 décisions par jour — c'était invisible.
 *
 * En passant à 150 actifs, cette écriture devient quadratique : 450 décisions
 * par jour, chacune réécrivant un fichier qui atteint ~29 Mo au bout d'un an,
 * soit de l'ordre du gigaoctet d'écritures par cycle sur une VM à 1 Go de RAM.
 *
 * Deux conséquences plus graves encore que la lenteur :
 *
 *   • le plafond de 50 000 entrées était atteint en ~4 mois, après quoi les
 *     plus anciennes étaient SUPPRIMÉES EN SILENCE — la mesure se vidait par
 *     le fond sans que rien ne l'indique ;
 *   • `JSON.parse` d'un fichier de 29 Mo réclame ~150 Mo de mémoire vive au
 *     démarrage, sur une machine qui en a 1024.
 *
 * SQLite règle les trois : écriture incrémentale, lecture par requête plutôt
 * qu'en bloc, et aucune limite pratique de volume.
 *
 * ── Le module est natif ───────────────────────────────────────────────────
 * `node:sqlite` est fourni avec Node : aucune dépendance ajoutée, aucune
 * compilation native sur la VM. Il réclame `--experimental-sqlite` sur Node 22
 * (le drapeau est accepté sans effet sur Node 24, donc la même ligne de
 * commande fonctionne partout).
 */

/** Colonnes de la table, dans l'ordre d'insertion. */
const COLUMNS = [
  'id', 't', 'day', 'symbol', 'action', 'confidence', 'price',
  'executed', 'hadPosition', 'newsAvailable', 'newsCount', 'calendarPhase',
  'model', 'source', 'ruleVersion',
  'pUp', 'pUpGivenMove', 'edge',
  'advisedAction', 'advisoryConflict', 'voided',
  'rank', 'rankTotal', 'rankFractional', 'selected',
  'baselines',
  'outcomes', 'resolved',
];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS decisions (
    id             TEXT PRIMARY KEY,
    t              TEXT NOT NULL,
    -- Partie date de l'horodatage, dupliquée pour que le dégroupage
    -- « une observation par actif et par jour » soit un simple GROUP BY
    -- indexé au lieu d'un découpage de chaîne sur chaque ligne.
    day            TEXT NOT NULL,
    symbol         TEXT NOT NULL,
    action         TEXT NOT NULL,
    confidence     REAL,
    price          REAL,
    executed       INTEGER NOT NULL DEFAULT 0,
    hadPosition    INTEGER NOT NULL DEFAULT 0,
    newsAvailable  INTEGER NOT NULL DEFAULT 0,
    newsCount      INTEGER NOT NULL DEFAULT 0,
    calendarPhase  TEXT,
    model          TEXT,
    source         TEXT,
    ruleVersion    TEXT NOT NULL,
    pUp            REAL,
    pUpGivenMove   REAL,
    edge           REAL,
    advisedAction  TEXT,
    advisoryConflict INTEGER NOT NULL DEFAULT 0,
    voided         INTEGER NOT NULL DEFAULT 0,
    -- Rang transversal du jour. Cest cette valeur, et non la probabilite brute,
    -- qui porte linformation exploitable : le niveau des probabilites dun LLM
    -- est frequemment faux la ou leur ordre reste valide.
    rank           INTEGER,
    rankTotal      INTEGER,
    rankFractional REAL,
    selected       INTEGER NOT NULL DEFAULT 0,
    -- Rangs des facteurs de référence pour le MÊME cycle, en JSON.
    -- Une colonne unique plutôt qu'une par facteur : leur nombre évoluera, et
    -- la mesure les parcourt toujours ensemble. Aucune requête ne filtre
    -- dessus, donc rien n'exige de les indexer séparément.
    baselines      TEXT,
    -- Résultats par horizon, en JSON : structure creuse (un horizon peut être
    -- échu et pas les autres) et interrogeable via json_extract.
    outcomes       TEXT,
    resolved       INTEGER NOT NULL DEFAULT 0
  );

  -- La mesure ne lit que la règle courante, jour par jour : c'est l'accès
  -- dominant, il doit être indexé.
  CREATE INDEX IF NOT EXISTS idx_rule_day ON decisions(ruleVersion, day);
  -- La résolution ne balaie que les décisions en attente.
  CREATE INDEX IF NOT EXISTS idx_resolved ON decisions(resolved);
`;

/**
 * Instances ouvertes, pour pouvoir toutes les refermer d'un coup.
 *
 * Windows verrouille un fichier tant qu'un descripteur reste ouvert : sans
 * fermeture explicite, la suppression du dossier temporaire en fin de test
 * échoue avec EBUSY. Sous Linux la suppression passerait, mais le descripteur
 * resterait ouvert malgré tout — autant être propre sur les deux.
 */
const OPEN_STORES = new Set();

export class SqliteStore {
  constructor(dir, filename) {
    this.dir = dir;
    this.file = path.join(dir, filename);
    this.db = null;
  }

  /** Referme toutes les bases ouvertes. Utilisé en fin de test. */
  static closeAll() {
    for (const store of [...OPEN_STORES]) store.close();
  }

  async init() {
    if (this.db) return this;

    fs.mkdirSync(this.dir, { recursive: true });
    this.db = new DatabaseSync(this.file);

    // WAL : les lectures ne bloquent plus l'écriture. Le bot écrit pendant
    // qu'une requête du dashboard peut lire — sans ce mode, l'API se
    // heurterait à des « database is locked » en plein cycle.
    this.db.exec('PRAGMA journal_mode = WAL');
    // NORMAL suffit ici : en cas de coupure brutale on peut perdre la dernière
    // transaction, pas la base. FULL coûterait un fsync par décision pour
    // protéger une information qui sera de toute façon reproduite au cycle
    // suivant.
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);

    OPEN_STORES.add(this);
    log.info(`Carnet fantôme : ${this.file} (${this.count()} décision(s))`);
    return this;
  }

  #assertReady() {
    if (!this.db) throw new Error('SqliteStore non initialisé — appeler init() d\'abord.');
  }

  /** Insère une décision. Idempotent sur l'identifiant. */
  insert(entry) {
    this.#assertReady();
    const placeholders = COLUMNS.map(() => '?').join(', ');
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO decisions (${COLUMNS.join(', ')}) VALUES (${placeholders})`,
    );
    stmt.run(...COLUMNS.map((c) => toSql(entry[c], c)));
    return entry;
  }

  /** Insertion en lot dans une seule transaction. */
  insertMany(entries) {
    this.#assertReady();
    this.db.exec('BEGIN');
    try {
      for (const e of entries) this.insert(e);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return entries.length;
  }

  /** Décisions dont l'horizon n'est pas encore échu. */
  pending() {
    this.#assertReady();
    return this.db.prepare('SELECT * FROM decisions WHERE resolved = 0 ORDER BY t').all().map(fromSql);
  }

  pendingCount() {
    this.#assertReady();
    return this.db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE resolved = 0').get().n;
  }

  count() {
    this.#assertReady();
    return this.db.prepare('SELECT COUNT(*) AS n FROM decisions').get().n;
  }

  /** Met à jour les résultats d'une décision après résolution. */
  updateOutcomes(id, outcomes, resolved) {
    this.#assertReady();
    this.db
      .prepare('UPDATE decisions SET outcomes = ?, resolved = ? WHERE id = ?')
      .run(JSON.stringify(outcomes), resolved ? 1 : 0, id);
  }

  updateManyOutcomes(rows) {
    this.#assertReady();
    this.db.exec('BEGIN');
    try {
      for (const r of rows) this.updateOutcomes(r.id, r.outcomes, r.resolved);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Série scorée pour un horizon donné, déjà dégroupée.
   *
   * Le « une seule observation par actif et par jour » est fait ICI, en SQL :
   * trois cycles quotidiens sur le même actif en bougies journalières
   * produisent quasiment la même décision, et les compter trois fois
   * sous-estimerait la variance — donc validerait à tort.
   *
   * `MIN(t)` retient la PREMIÈRE décision du jour, celle prise avec le moins
   * d'information intrajournalière : c'est la plus conservatrice.
   */
  scoredSeries({ horizon, ruleVersion = null }) {
    this.#assertReady();
    const key = `$.d${horizon}`;
    const rows = this.db.prepare(`
      SELECT d.* FROM decisions d
      JOIN (
        SELECT symbol, day, MIN(t) AS firstT
        FROM decisions
        WHERE json_extract(outcomes, '${key}.score') IS NOT NULL
          ${ruleVersion ? 'AND ruleVersion = ?' : ''}
        GROUP BY symbol, day
      ) f ON d.symbol = f.symbol AND d.day = f.day AND d.t = f.firstT
      ORDER BY d.t
    `).all(...(ruleVersion ? [ruleVersion] : []));
    return rows.map(fromSql);
  }

  /** Répartition des décisions par version de règle. */
  countByRule() {
    this.#assertReady();
    return Object.fromEntries(
      this.db
        .prepare('SELECT ruleVersion, COUNT(*) AS n FROM decisions GROUP BY ruleVersion')
        .all()
        .map((r) => [r.ruleVersion, r.n]),
    );
  }

  /** Vide la table — réservé aux tests et à une remise à zéro explicite. */
  clear() {
    this.#assertReady();
    this.db.exec('DELETE FROM decisions');
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    OPEN_STORES.delete(this);
  }
}

/** SQLite ne connaît ni booléen ni objet : on convertit à l'entrée. */
function toSql(value, column) {
  if (column === 'outcomes' || column === 'baselines') return value == null ? null : JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

/** Et on reconstitue les types JavaScript à la sortie. */
function fromSql(row) {
  return {
    ...row,
    executed: Boolean(row.executed),
    hadPosition: Boolean(row.hadPosition),
    newsAvailable: Boolean(row.newsAvailable),
    advisoryConflict: Boolean(row.advisoryConflict),
    voided: Boolean(row.voided),
    resolved: Boolean(row.resolved),
    selected: Boolean(row.selected),
    outcomes: row.outcomes ? JSON.parse(row.outcomes) : null,
    baselines: row.baselines ? JSON.parse(row.baselines) : null,
  };
}
