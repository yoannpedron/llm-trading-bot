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
 * Coût d'un aller-retour, en fraction du notionnel.
 *
 * Mesuré sur les ordres réels du bot : 6,25 points de base, spread uniquement
 * (Alpaca ne prend aucune commission). C'est la seule friction qui compte à
 * cette taille de compte — aucun impact de marché sur 35 $ de grande cap.
 */
const COUT_ALLER_RETOUR = 0.000625;

/**
 * Facteur de conversion entre la largeur de bande continue et l'espace des
 * rangs.
 *
 * ── Pourquoi il vaut 1, et pourquoi c'est provisoire ──────────────────────
 * La théorie donne la largeur de bande dans l'espace des SCORES ; il faut la
 * transposer dans celui des RANGS. Le facteur de passage dépend de
 * l'autocorrélation du classement — sa stabilité d'un jour à l'autre — qu'on
 * ne peut mesurer qu'après plusieurs semaines de production.
 *
 * À 1, la bande vaut 13 rangs sur 150 actifs. La sensibilité est réelle et
 * assumée : à 0,5 on sortirait au rang 9, à 2 au rang 29. L'ordre de grandeur
 * — la dizaine, pas 4 et pas 76 — est en revanche solide.
 *
 * À recalibrer sur la FRA mesurée dès que le carnet aura deux semaines.
 */
const KAPPA = 1;

/**
 * Rang au-delà duquel une position détenue est liquidée.
 *
 * ── Le résultat qui fonde cette fonction ──────────────────────────────────
 * Sous coûts proportionnels, la largeur optimale de la zone sans transaction
 * croît comme la RACINE CUBIQUE du coût, non linéairement (Janecek & Shreve
 * 2004 ; Rogers 2004). La démonstration oppose deux termes : la perte
 * d'opportunité d'une position dérivée, quadratique en largeur de bande, et le
 * coût de transaction, inversement proportionnel à cette largeur. Le minimum
 * de leur somme tombe en c^(1/3).
 *
 * L'effet est massif et c'est tout l'intérêt : à 6,25 bps, un raisonnement
 * linéaire donnerait une bande de 0,06 % de la distribution, la racine cubique
 * en donne 8,55 % — cent trente-sept fois plus large.
 *
 * ── Pourquoi ce n'est pas un détail ───────────────────────────────────────
 * La règle précédente ne vendait que sur signal franchement négatif, ce qui
 * correspond à une chute sous la médiane — le rang 76 sur 150. La bande faisait
 * donc 73 rangs, cinq fois trop large. Conséquence : trois positions achetées
 * puis devenues médiocres n'étaient jamais vendues, les trois emplacements
 * restaient occupés, et le classement transversal — la raison d'être de toute
 * la refonte — devenait inerte dès le premier jour.
 */
export function exitRank({ universe, maxSelected = 3, cost = COUT_ALLER_RETOUR, kappa = KAPPA }) {
  const largeur = kappa * universe * Math.cbrt(cost);
  return Math.max(maxSelected + 1, Math.round(maxSelected + largeur));
}

/**
 * Âge d'une position, en séances approximatives.
 *
 * L'approximation par 5/7 est assumée : reconstruire un calendrier boursier
 * complet — jours fériés compris — pour départager 20 séances de 21 serait un
 * raffinement sans effet. La durée minimale est un garde-fou contre la
 * suractivité, pas une date d'échéance contractuelle.
 */
export function ageEnSeances(openedAt, maintenant = new Date()) {
  if (!openedAt) return null;
  const t = new Date(openedAt).getTime();
  if (Number.isNaN(t)) return null;
  const joursCalendaires = (maintenant.getTime() - t) / 86_400_000;
  return Math.max(0, Math.floor(joursCalendaires * (5 / 7)));
}

/**
 * Classe les évaluations et désigne celles à exécuter.
 *
 * @param {Array} evaluations  objets contenant au moins { symbol, decision }
 * @param {object} options
 * @param {number} options.maxSelected  nombre de positions visées (K)
 * @param {Set<string>} options.held    actifs déjà détenus
 * @param {number} options.ageMinimum   séances minimales avant sortie par rang
 * @param {Array}  options.positions    positions détenues, avec leur `openedAt`
 */
export function rankAndSelect(evaluations, {
  maxSelected = 3,
  held = new Set(),
  ageMinimum = 0,
  positions = null,
} = {}) {
  const ages = positions
    ? new Map(positions.map((p) => [p.symbol, ageEnSeances(p.openedAt)]).filter(([, a]) => a != null))
    : null;
  const optionsSortie = { ageMinimum, ages };
  const scored = evaluations
    .filter((e) => e?.decision?.forecast)
    .map((e) => ({ symbol: e.symbol, edge: e.decision.forecast.edge }));

  if (scored.length < 2) {
    return {
      selected: new Set(),
      sorties: new Set(),
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
    // Aucune SÉLECTION, mais les sorties restent calculées : un classement
    // sans dispersion n'autorise pas à acheter, il n'oblige pas à conserver.
    // Confondre les deux ferait du bot un acheteur qui ne vend jamais.
    return {
      selected: new Set(),
      sorties: sortiesParRang(ranks, held, scored.length, maxSelected, optionsSortie),
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

  return {
    selected,
    sorties: sortiesParRang(ranks, held, scored.length, maxSelected, optionsSortie),
    ranks,
    dispersion,
    median,
    seuilSortie: exitRank({ universe: scored.length, maxSelected }),
    reason: null,
  };
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


/**
 * Positions détenues tombées hors de la bande de tolérance.
 *
 * La règle d'entrée est RELATIVE — être dans les meilleurs — et la règle de
 * sortie doit l'être aussi. Une sortie absolue (« vendre quand l'actif devient
 * franchement mauvais ») appartient à une stratégie de seuil, pas à une
 * stratégie de classement : les deux moitiés du bot suivraient deux
 * philosophies opposées, et c'est exactement ce qui figeait le portefeuille.
 *
 * Un actif absent du classement du jour n'est PAS vendu : il n'a pas été
 * évalué (marché fermé sur ce titre, cotation manquante), ce qui n'est pas une
 * information sur sa qualité. Vendre sur une absence de données serait la pire
 * des raisons d'agir.
 */
function sortiesParRang(ranks, held, universe, maxSelected, { ageMinimum = 0, ages = null } = {}) {
  const seuil = exitRank({ universe, maxSelected });
  const sorties = new Set();
  const retenuesParAge = new Map();

  for (const symbol of held) {
    const info = ranks.get(symbol);
    if (!info) continue;
    if (info.rank <= seuil) continue;

    // ── La durée minimale de détention prime sur le rang ──────────────────
    // Sans elle, la rotation n'est bornée par rien : une position ouverte le
    // matin peut être soldée l'après-midi parce que trois actifs l'ont
    // dépassée d'un rang. À trois cycles par jour, cela produisait 84
    // rotations annuelles, soit 5,25 % de frais garantis.
    //
    // Le signal qu'on exploite met 2 à 6 semaines à se dissiper. Sortir avant
    // qu'il ait produit revient à payer l'aller-retour complet pour une
    // fraction du mouvement. On laisse donc la position vivre, même quand son
    // rang décroche — le rang décroche constamment sur du bruit transversal.
    const age = ages?.get(symbol);
    if (ageMinimum > 0 && age != null && age < ageMinimum) {
      retenuesParAge.set(symbol, age);
      continue;
    }

    sorties.add(symbol);
  }

  if (retenuesParAge.size) {
    log.info(
      `${retenuesParAge.size} position(s) conservée(s) malgré un rang décroché, `
      + `durée minimale de ${ageMinimum} séances non atteinte : `
      + [...retenuesParAge.entries()].map(([s, a]) => `${s} (${a} j)`).join(', '),
    );
  }

  if (sorties.size) {
    log.info(
      `Sortie par classement (seuil : rang ${seuil} sur ${universe}) — `
      + [...sorties].map((s) => `${s} au rang ${ranks.get(s).rank}`).join(', '),
    );
  }
  return sorties;
}
