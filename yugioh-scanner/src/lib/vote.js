/**
 * Accumulation des lectures sur plusieurs images.
 *
 * Une seule image ne suffit pas à trancher quand la correspondance est
 * approchée : un reflet, un doigt qui bouge, et l'OCR rend un code voisin de
 * celui qui est imprimé. Mais deux images successives ne se trompent presque
 * jamais *de la même façon* — le bruit change, la carte non.
 *
 * On compte donc les lectures dans une fenêtre glissante et on n'accepte qu'à
 * partir de deux occurrences. Une correspondance exacte ou régionale, elle,
 * n'a rien à confirmer : le code lu existe tel quel dans la base.
 *
 * La fenêtre est ce qui empêche une lecture isolée d'il y a trente secondes de
 * se combiner avec une autre pour former une fausse confirmation.
 */

export const DEFAULT_NEEDED = 2;
export const DEFAULT_WINDOW_MS = 4000;

export class ReadingVote {
  constructor({
    needed = DEFAULT_NEEDED,
    windowMs = DEFAULT_WINDOW_MS,
    now = () => Date.now(),
  } = {}) {
    this.needed = needed;
    this.windowMs = windowMs;
    this.now = now;
    /** @type {Map<string, number[]>} code -> horodatages */
    this.seen = new Map();
  }

  /**
   * Enregistre une lecture et dit si elle emporte la décision.
   *
   * @param {string} code code résolu
   * @param {{certain?: boolean}} options `certain` pour une correspondance
   *   exacte ou régionale, qui est acceptée sans confirmation
   * @returns {{accepted: boolean, count: number}}
   */
  cast(code, { certain = false } = {}) {
    if (!code) return { accepted: false, count: 0 };
    if (certain) return { accepted: true, count: this.needed };

    const time = this.now();
    const kept = (this.seen.get(code) ?? []).filter(
      (stamp) => time - stamp < this.windowMs,
    );
    kept.push(time);
    this.seen.set(code, kept);

    // Les autres codes vieillissent aussi : sans cela, la table enflerait au
    // fil d'une session et garderait des lectures hors fenêtre.
    for (const [other, stamps] of this.seen) {
      if (other === code) continue;
      const fresh = stamps.filter((stamp) => time - stamp < this.windowMs);
      if (fresh.length === 0) this.seen.delete(other);
      else this.seen.set(other, fresh);
    }

    return { accepted: kept.length >= this.needed, count: kept.length };
  }

  /** Nombre de lectures encore valides pour un code. */
  count(code) {
    const time = this.now();
    return (this.seen.get(code) ?? []).filter((stamp) => time - stamp < this.windowMs).length;
  }

  reset() {
    this.seen.clear();
  }
}
