import { createLogger } from '../logger.js';
import { sectorOf } from '../data/universe.js';

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
 * @param {number} options.maxParSecteur  plafond par secteur (0 = désactivé)
 * @param {Function} options.secteurDe    résolution du secteur, injectable
 * @param {Date}   options.maintenant   instant de référence pour l'âge des
 *   positions. Vaut l'heure courante en production — c'est bien ce qu'on veut.
 *
 *   ── Pourquoi il faut pouvoir l'injecter ────────────────────────────────
 *   `ageEnSeances` lisait l'horloge système sans détour possible. Rejouer une
 *   année de décisions donnait donc à CHAQUE position un âge calculé depuis
 *   aujourd'hui : une ligne ouverte en juin 2025 paraissait vieille de trois
 *   cents séances, la durée minimale de détention ne se déclenchait jamais, et
 *   la simulation vendait tous les jours.
 *
 *   Le garde-fou le plus important de la stratégie était donc INVÉRIFIABLE
 *   autrement qu'en production. Mesuré : sans lui, 803 achats sur 299 séances
 *   et 136,80 $ contre 143,22 $ pour l'inaction. La règle ne fait pas que
 *   limiter les frais, elle porte le résultat.
 */
export function rankAndSelect(evaluations, {
  maxSelected = 3,
  held = new Set(),
  ageMinimum = 0,
  positions = null,
  maxParSecteur = 0,
  secteurDe = sectorOf,
  abstention = null,
  maintenant = undefined,
  kappa = KAPPA,
} = {}) {
  const ages = positions
    ? new Map(positions
      .map((p) => [p.symbol, maintenant ? ageEnSeances(p.openedAt, maintenant) : ageEnSeances(p.openedAt)])
      .filter(([, a]) => a != null))
    : null;
  const optionsSortie = { ageMinimum, ages, kappa };
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

  // ── La garde de dispersion ne servait à rien, et il a fallu le mesurer ───
  // Elle surveille l'écart-type des notes. Or le défaut réel n'est pas la
  // largeur de la distribution mais le nombre d'actifs COLLÉS sur chaque
  // valeur. Vérifié : trois valeurs distinctes réparties sur 150 actifs — donc
  // cinquante ex æquo au sommet, départagés par l'ordre du fichier de
  // configuration — donnent une dispersion de 0,07, largement au-dessus du
  // seuil de 0,03. La garde ne se déclenchait pas.
  //
  // Quand l'appelant dispose d'un vrai test — le rapport de vraisemblance du
  // classement contre l'hypothèse « le modèle ne différencie rien », calibré
  // par bootstrap — il l'injecte ici et la dispersion n'est plus consultée.
  if (abstention) {
    if (abstention.abstenir) {
      return {
        selected: new Set(),
        sorties: sortiesParRang(ranks, held, scored.length, maxSelected, optionsSortie),
        ranks,
        dispersion,
        reason: abstention.raison ?? 'classement jugé non significatif',
      };
    }
  } else if (dispersion < MIN_DISPERSION) {
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

  // ── Neutralité sectorielle ──────────────────────────────────────────────
  // Prendre les K meilleurs tous secteurs confondus paraît neutre. Ça ne
  // l'est pas : quand un secteur entier surperforme, il rafle tout le haut du
  // classement et le portefeuille devient un pari sur ce secteur, pas une
  // sélection de titres. On croit exploiter une prime transversale, on achète
  // en réalité un facteur macroéconomique qui n'est rémunéré par personne.
  //
  // Le classement absolu est d'ailleurs largement absorbé par sa composante
  // sectorielle : l'essentiel de ce qu'on croit être un choix d'entreprise est
  // un choix d'industrie. Ce qui reste — la comparaison entre pairs du même
  // secteur — est la partie qui porte réellement de l'information.
  //
  // Le plafond ne réordonne rien : il parcourt le classement dans l'ordre et
  // saute simplement les actifs dont le secteur est déjà servi. Le meilleur
  // reste le meilleur.
  const selected = new Set();
  const parSecteur = new Map();
  const ecartesParSecteur = [];

  for (const s of scored) {
    if (selected.size >= maxSelected) break;
    if (s.edge <= median) break; // le tri est décroissant : tout le reste suit

    if (maxParSecteur > 0) {
      const secteur = secteurDe(s.symbol) || 'inconnu';
      const dejaPris = parSecteur.get(secteur) ?? 0;
      if (dejaPris >= maxParSecteur) {
        ecartesParSecteur.push(`${s.symbol} (${secteur})`);
        continue;
      }
      parSecteur.set(secteur, dejaPris + 1);
    }

    selected.add(s.symbol);
  }

  if (ecartesParSecteur.length) {
    log.info(
      `Plafond sectoriel (${maxParSecteur} par secteur) — écartés malgré un bon rang : `
      + ecartesParSecteur.slice(0, 8).join(', ') + (ecartesParSecteur.length > 8 ? '…' : ''),
    );
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
    // Le seuil PUBLIÉ doit être celui qui a servi : il omettait `kappa`, si
    // bien qu'un kappa injecté — en simulation, ou le jour où on le réglera —
    // faisait annoncer « sortie au-delà du rang 19 » quand la règle appliquée
    // sortait au-delà du 27. Le journal décrivait alors une stratégie que le
    // bot ne suivait pas.
    seuilSortie: exitRank({ universe: scored.length, maxSelected, kappa }),
    reason: null,
  };
}

/**
 * Traduit un classement en action à exécuter.
 *
 * ── Pourquoi cette fonction existe séparément ─────────────────────────────
 * Elle vivait dans une méthode privée du moteur, sans test. Le jour où le
 * modèle a cessé de proposer une action pour se contenter d'ORDONNER, le bloc
 * n'a pas suivi : il savait rétrograder un BUY en HOLD mais pas promouvoir un
 * actif sélectionné. La décision synthétisée valant toujours HOLD, plus aucun
 * achat n'était possible. Le bot classait parfaitement, puis ne faisait rien.
 *
 * Rien ne l'a signalé — ni les tests, qui ne couvraient pas le chemin, ni
 * l'exécution, qui n'a pas d'opinion sur ce qu'elle n'exécute pas. Isolée
 * ici, la règle devient vérifiable.
 *
 * ── L'ordre des priorités ────────────────────────────────────────────────
 * La sortie prime sur l'entrée. Un actif à la fois sélectionné et marqué en
 * sortie est une contradiction du classement ; dans le doute on solde, parce
 * qu'une vente à tort coûte un aller-retour quand un achat à tort engage du
 * capital sur un signal qu'on vient de juger caduc.
 */
export function actionEffective({ decision, symbol, selected, sorties, position }) {
  const detenu = position?.quantity > 0;

  if (detenu && sorties?.has(symbol)) {
    return { action: 'SELL', sizePct: 1, raison: 'sortie par classement' };
  }

  if (selected?.has(symbol)) {
    return {
      action: 'BUY',
      // Poids égal : le rang décide de QUI, jamais de COMBIEN.
      sizePct: decision?.sizePct > 0 ? decision.sizePct : 1,
      raison: 'retenu par le classement transversal',
    };
  }

  // Un actif non retenu ne s'achète pas, même si sa prévision est bonne dans
  // l'absolu — c'est toute la différence entre un seuil et un classement.
  if (decision?.action === 'BUY') {
    return { action: 'HOLD', sizePct: 0, raison: 'hors des retenus' };
  }

  return { action: decision?.action ?? 'HOLD', sizePct: decision?.sizePct ?? 0, raison: null };
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
function sortiesParRang(ranks, held, universe, maxSelected, { ageMinimum = 0, ages = null, kappa = KAPPA } = {}) {
  const seuil = exitRank({ universe, maxSelected, kappa });
  const sorties = new Set();
  const retenuesParAge = new Map();
  const ageInconnu = [];

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
    // ── Une date d'ouverture perdue désarme la règle, en silence ──────────
    // La condition exige `age != null` : sans date, la durée minimale ne
    // s'applique pas et la position peut être soldée dès le premier cycle.
    // C'est le bon choix — figer une ligne qu'on ne sait pas dater serait pire
    // qu'une rotation de trop — mais il ne doit pas passer inaperçu, car c'est
    // exactement ce qui arrive après une perte d'état ou une position ouverte
    // hors du bot. Le garde-fou le plus important de la stratégie s'éteignait
    // sans une ligne de journal.
    const age = ages?.get(symbol);
    if (ageMinimum > 0 && age == null) ageInconnu.push(symbol);
    if (ageMinimum > 0 && age != null && age < ageMinimum) {
      retenuesParAge.set(symbol, age);
      continue;
    }

    sorties.add(symbol);
  }

  if (ageInconnu.length) {
    log.warn(
      `${ageInconnu.length} position(s) sans date d'ouverture connue : ${ageInconnu.join(', ')} — `
      + `la durée minimale de ${ageMinimum} séances ne les protège pas, elles peuvent être soldées `
      + 'dès ce cycle.',
    );
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
