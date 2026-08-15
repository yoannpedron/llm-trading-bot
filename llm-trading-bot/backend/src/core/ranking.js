import { createLogger } from '../logger.js';

const log = createLogger('rank');

/**
 * Sélection transversale : classer les actifs entre eux, puis prendre les K
 * meilleurs à poids égal.
 *
 * ── Pourquoi le seuil absolu a été abandonné ──────────────────────────────
 * Le bot appliquait un seuil fixe à chaque actif jugé isolément : « acheter si
 * l'écart de probabilité dépasse 20 points ». Cette règle suppose que les
 * probabilités du modèle sont comparables d'un actif à l'autre. Elles ne le
 * sont pas, et le mécanisme est documenté :
 *
 *   un actif volatil produit des probabilités polarisées (0,85 / 0,15) parce
 *   que ses mouvements fournissent au modèle des exemples tranchés ; un actif
 *   défensif produit des probabilités tempérées autour de 0,50. Comparer les
 *   deux sur des valeurs brutes sélectionne la VOLATILITÉ, pas la qualité — le
 *   choix de titres se transforme en pari factoriel déguisé, long sur le bêta.
 *
 * La littérature sépare deux propriétés qu'on avait confondues : la validité du
 * NIVEAU (« 60 % veut dire 60 % ») et celle du RANG (« 60 est meilleur que
 * 45 »). Chez les modèles de langage la seconde survit couramment quand la
 * première est massivement fausse. Une sélection qui n'utilise que le rang est
 * donc valide même sous mauvaise calibration ; un seuil absolu ne l'est pas.
 *
 * ── Et pourquoi le poids égal ─────────────────────────────────────────────
 * Même raison. Dimensionner proportionnellement à l'écart de probabilité
 * revient à faire confiance au niveau : le capital maximal serait engagé
 * exactement là où le modèle est le plus exagérément confiant. Un poids de 1/K
 * sur les K retenus ne dépend que de l'ordre.
 */

/**
 * Écart-type transversal minimal en dessous duquel le classement ne repose
 * sur rien.
 *
 * Ce n'est pas une précaution théorique. Observé en production : le modèle a
 * répondu « 40/45/15 » à l'identique sur trois actifs différents du même cycle.
 * L'anonymisation, en retirant les ancres sémantiques, pousse le modèle vers
 * des « jetons refuges » — des valeurs rondes qu'il produit par défaut faute
 * d'ancrage. Trier six réponses identiques revient à trier du bruit, et le
 * premier de la liste gagnerait par pur hasard d'ordonnancement.
 *
 * 3 points d'écart sur 100 : en dessous, on s'abstient.
 */
const MIN_DISPERSION = 0.03;

/**
 * Classe les évaluations et désigne celles à exécuter.
 *
 * @param {Array} evaluations  objets contenant au moins { symbol, decision }
 * @param {object} options
 * @param {number} options.maxSelected  nombre de positions visées (K)
 * @param {Set<string>} options.held    actifs déjà détenus
 */
export function rankAndSelect(evaluations, { maxSelected = 3, held = new Set() } = {}) {
  const scored = evaluations
    .filter((e) => e?.decision?.forecast)
    .map((e) => ({ symbol: e.symbol, edge: e.decision.forecast.edge }));

  if (scored.length < 2) {
    return {
      selected: new Set(),
      ranks: new Map(),
      dispersion: 0,
      reason: 'classement impossible : moins de deux prévisions exploitables',
    };
  }

  // Ordre décroissant : le meilleur écart en premier.
  scored.sort((a, b) => b.edge - a.edge);

  const edges = scored.map((s) => s.edge);
  const mean = edges.reduce((a, b) => a + b, 0) / edges.length;
  const dispersion = Math.sqrt(
    edges.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(edges.length - 1, 1),
  );

  // Rang fractionnaire dans [0, 1] : 1 pour le meilleur. C'est cette valeur —
  // et non la probabilité brute — qui sera confrontée au rendement réalisé.
  const ranks = new Map();
  scored.forEach((s, i) => {
    ranks.set(s.symbol, {
      rank: i + 1,
      total: scored.length,
      fractional: scored.length > 1 ? 1 - i / (scored.length - 1) : 1,
      edge: s.edge,
    });
  });

  if (dispersion < MIN_DISPERSION) {
    log.warn(
      `Dispersion transversale ${(dispersion * 100).toFixed(1)} pts < ${MIN_DISPERSION * 100} : `
      + 'le modèle ne différencie pas les actifs, aucune sélection.',
    );
    return {
      selected: new Set(),
      ranks,
      dispersion,
      reason: `dispersion transversale trop faible (${(dispersion * 100).toFixed(1)} pts) — le classement ne porte aucune information`,
    };
  }

  // Médiane transversale : filtre purement ORDINAL. Exiger « au-dessus de la
  // médiane » est une affirmation de rang, pas de niveau — on ne réintroduit
  // donc pas le seuil absolu par la porte de derrière.
  const sortedEdges = [...edges].sort((a, b) => a - b);
  const median = sortedEdges[Math.floor(sortedEdges.length / 2)];

  const selected = new Set();
  for (const s of scored) {
    if (selected.size >= maxSelected) break;
    if (s.edge <= median) break; // le tri est décroissant : tout le reste suit
    selected.add(s.symbol);
  }

  // Les positions déjà tenues ne comptent pas contre le quota d'ouverture :
  // les conserver ou les solder relève des signaux de vente et du stop, pas de
  // la sélection.
  const opening = [...selected].filter((s) => !held.has(s));

  log.info(
    `Classement sur ${scored.length} actifs (dispersion ${(dispersion * 100).toFixed(1)} pts) — `
    + `retenus : ${[...selected].join(', ') || 'aucun'}`
    + (opening.length ? ` (${opening.length} ouverture(s))` : ''),
  );

  return { selected, ranks, dispersion, median, reason: null };
}

/**
 * Poids égal sur les K retenus.
 *
 * `sizePct` s'exprime en fraction de l'enveloppe autorisée par actif, donc un
 * poids égal correspond à 1 — chaque position retenue vise la même exposition.
 * La diversification naïve 1/N bat régulièrement les optimisations savantes
 * hors échantillon, précisément parce qu'elle ne dépend d'aucun paramètre
 * estimé.
 */
export function equalWeight() {
  return 1;
}

export { MIN_DISPERSION };
