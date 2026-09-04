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


/* ------------------------------------------------------------------ */
/* Vote caractère par caractère                                         */
/* ------------------------------------------------------------------ */

/**
 * Consensus sur les lectures brutes, position par position.
 *
 * POURQUOI. Le vote ci-dessus exige que deux images rendent EXACTEMENT la même
 * chaîne. Or l'OCR se trompe rarement deux fois au même endroit : sur une carte
 * réelle il rend « STOK-FRO40 » puis « STOR-FR040 » puis « 5TOR-FRO40 ». Aucune
 * de ces trois lectures ne se répète, donc aucune n'est confirmée, et la carte
 * n'est jamais identifiée — alors que la bonne réponse est lisible dans les
 * trois : à chaque position, la majorité a raison.
 *
 * COMMENT. On regroupe les lectures de la fenêtre par longueur, on retient la
 * longueur la plus fréquente, et l'on élit chaque caractère à la majorité. Le
 * regroupement par longueur est indispensable : une lecture amputée décalerait
 * toutes les positions suivantes et fabriquerait un consensus pire que ses
 * composantes.
 *
 * CE QUE ÇA NE FAIT PAS. Aucune correction n'est inventée : si trois lectures
 * disent toutes « K » en troisième position, le consensus dit « K ». Le vote
 * ne remplace ni la transposition ni l'appariement approché — il leur donne une
 * chaîne moins bruitée à traiter.
 */
export class CharacterVote {
  /**
   * @param {{windowMs?: number, needed?: number, now?: () => number}} options
   *   `needed` est le nombre minimal de lectures de même longueur sous lequel
   *   on ne se prononce pas : à une seule lecture, il n'y a pas de vote.
   */
  constructor({ windowMs = DEFAULT_WINDOW_MS, needed = 2, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.needed = needed;
    this.now = now;
    /** @type {Array<{texte: string, temps: number}>} */
    this.lectures = [];
  }

  /** Oublie ce qui est sorti de la fenêtre glissante. */
  #elaguer(temps) {
    this.lectures = this.lectures.filter((entree) => temps - entree.temps < this.windowMs);
  }

  /**
   * Enregistre une lecture brute et rend le consensus courant.
   * @param {string} raw texte rendu par l'OCR, déjà débarrassé des espaces
   * @returns {string|null} la chaîne consensuelle, ou `null` faute de quorum
   */
  cast(raw) {
    const texte = String(raw ?? '').trim();
    const temps = this.now();
    this.#elaguer(temps);
    if (texte) this.lectures.push({ texte, temps });
    return this.consensus();
  }

  /**
   * Chaîne élue par les lectures de la fenêtre.
   * @returns {string|null}
   */
  consensus() {
    this.#elaguer(this.now());
    if (this.lectures.length < this.needed) return null;

    // La longueur la plus représentée l'emporte ; à égalité, la plus récente,
    // qui correspond à la mise au point la plus fraîche.
    const parLongueur = new Map();
    for (const { texte } of this.lectures) {
      const groupe = parLongueur.get(texte.length) ?? [];
      groupe.push(texte);
      parLongueur.set(texte.length, groupe);
    }

    let retenu = null;
    for (const groupe of parLongueur.values()) {
      if (retenu === null || groupe.length > retenu.length) retenu = groupe;
    }
    if (!retenu || retenu.length < this.needed) return null;

    let consensus = '';
    for (let position = 0; position < retenu[0].length; position += 1) {
      const compte = new Map();
      for (const texte of retenu) {
        const caractere = texte[position];
        compte.set(caractere, (compte.get(caractere) ?? 0) + 1);
      }
      let meilleur = null;
      for (const [caractere, nombre] of compte) {
        if (meilleur === null || nombre > meilleur[1]) meilleur = [caractere, nombre];
      }
      consensus += meilleur[0];
    }
    return consensus;
  }

  /** Nombre de lectures encore dans la fenêtre. */
  get taille() {
    this.#elaguer(this.now());
    return this.lectures.length;
  }

  reset() {
    this.lectures = [];
  }
}
