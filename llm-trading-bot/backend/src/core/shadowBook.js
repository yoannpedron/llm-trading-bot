import crypto from 'node:crypto';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { SqliteStore } from '../storage/SqliteStore.js';
import { calibration } from './calibration.js';

const log = createLogger('shadow');

/**
 * Carnet fantôme — l'instrument de mesure du projet.
 *
 * Le journal enregistre ce que le bot a PENSÉ. Le carnet fantôme rouvre chaque
 * décision quelques jours plus tard pour établir s'il avait RAISON. C'est une
 * jointure différée : elle ne peut structurellement pas être faite au moment de
 * la décision, puisque le futur n'existe pas encore.
 *
 * Trois raisons rendent cet objet central :
 *
 * 1. Il est immunisé contre la contamination mémorielle. Les LLM ont mémorisé
 *    les prix historiques, ce qui invalide tout backtest antérieur à leur date
 *    de coupure. Ici les décisions sont prises en temps réel, avant que le
 *    résultat n'existe : c'est la seule évaluation non biaisée possible.
 *
 * 2. Il score TOUTES les décisions, pas seulement les trades exécutés. Le bot
 *    prend ~30 décisions par jour pour ~0,3 trade. Sans le carnet fantôme, on
 *    jette 99 % de l'information produite.
 *
 * 3. Il sépare la qualité de PRÉDICTION de la qualité d'EXÉCUTION. Le P&L
 *    confond « l'appel était-il juste ? », « la taille était-elle bonne ? » et
 *    « le stop s'est-il déclenché au mauvais moment ? ». Le carnet isole la
 *    première question.
 *
 * Le score retenu est un rendement EXCÉDENTAIRE (actif − indice de référence).
 * Sans cette correction, un bot qui dirait toujours HOLD marquerait des points
 * dans un marché baissier sans posséder la moindre compétence : on mesurerait
 * du bêta de marché, pas de la sélection.
 */

/** Horizons d'évaluation, en jours de bourse. */
const HORIZONS = [1, 3, 7];

/** Symbole servant de référence pour neutraliser le bêta de marché. */
const BENCHMARK = 'SPY';

/**
 * Version de la RÈGLE DE DÉCISION en vigueur.
 *
 * ── Pourquoi ce champ existe ──────────────────────────────────────────────
 * Le SPRT teste UNE stratégie. Il n'a aucun moyen de savoir que la règle a
 * changé en cours de route : il additionne les scores et rend un verdict.
 *
 * Le cas s'est présenté pour de bon. Le carnet contenait 171 décisions, dont
 * 110 prises par l'ancienne règle — le modèle choisissait lui-même l'action —
 * et 61 par la nouvelle, où le seuil décide à partir d'une répartition de
 * probabilités. Deux tiers du verdict auraient porté sur un bot remplacé le
 * jour même, et ces 110 décisions n'ont aucune prévision à confronter à la
 * calibration.
 *
 * Le carnet garde tout : jeter des observations réelles serait dommage, et
 * l'ancienne série reste consultable. Mais la mesure ne consomme par défaut que
 * la version courante. Le prix à payer est visible et honnête — le compteur
 * repart de zéro à chaque changement de règle. C'est le coût réel d'une
 * modification de stratégie, et le masquer coûterait la validité du verdict.
 *
 * À incrémenter dès qu'une modification change les décisions produites : seuils,
 * schéma de sortie, dérivation de l'action. Pas pour un correctif d'affichage.
 */
const RULE_VERSION = 'seuil-sur-prevision-v1';

/** Étiquette des décisions antérieures à l'introduction du champ. */
const LEGACY_RULE = 'action-choisie-par-le-modele';

export class ShadowBook {
  constructor(filename = 'shadow-book.db') {
    this.store = new SqliteStore(config.storage.dir, filename);
    // Le seul état hors base : la date de dernière résolution, purement
    // informative. Elle ne mérite pas une table à elle seule.
    this.lastResolutionAt = null;
    this.loaded = false;
  }

  async init() {
    if (!this.loaded) {
      await this.store.init();
      this.loaded = true;
    }
    return this;
  }

  /**
   * Enregistre une décision au moment où elle est prise.
   * Aucun score n'est calculé ici — seulement le contexte nécessaire à
   * l'évaluation ultérieure.
   */
  async record(decision) {
    await this.init();

    const t = new Date().toISOString();
    const entry = {
      id: crypto.randomUUID(),
      t,
      // Dupliqué pour indexer le dégroupage par jour côté SQL.
      day: t.slice(0, 10),
      symbol: decision.symbol,
      action: decision.action,
      confidence: decision.confidence ?? 0,
      price: decision.price,
      // Contexte pour segmenter l'analyse a posteriori : est-ce que les
      // actualités servent ? le calendrier ? la confiance est-elle calibrée ?
      executed: Boolean(decision.executed),
      hadPosition: Boolean(decision.hadPosition),
      newsAvailable: Boolean(decision.newsAvailable),
      newsCount: decision.newsCount ?? 0,
      calendarPhase: decision.calendarPhase ?? null,
      model: decision.model ?? null,
      source: decision.source ?? 'llm',
      // Règle qui a produit cette décision. Sans elle, un changement de
      // stratégie contaminerait silencieusement le verdict.
      ruleVersion: RULE_VERSION,
      // ── Prévision annoncée, distincte de l'action retenue ────────────────
      // `pUpGivenMove` est la probabilité de surperformance conditionnelle à un
      // mouvement discernable. Elle se confronte directement au SIGNE du
      // rendement excédentaire, sans passer par l'action : c'est ce qui permet
      // de juger la prévision même quand un garde-fou a bloqué l'exécution.
      pUp: decision.forecast?.pUp ?? null,
      pUpGivenMove: decision.forecast?.pUpGivenMove ?? null,
      edge: decision.forecast?.edge ?? null,
      // Ce que le modèle recommandait, et s'il divergeait du seuil : la
      // matière première pour chiffrer son biais d'inaction.
      advisedAction: decision.advisedAction ?? null,
      advisoryConflict: Boolean(decision.advisoryConflict),
      voided: Boolean(decision.voided),
      // Renseigné plus tard par resolve()
      outcomes: null,
      resolved: false,
    };

    // Insertion incrémentale : plus de réécriture du fichier entier, et donc
    // plus de plafond arbitraire à 50 000 entrées qui supprimait les plus
    // anciennes en silence — c'est-à-dire qui vidait la mesure par le fond.
    this.store.insert(entry);
    return entry;
  }

  /**
   * Traduit une décision en rendement signé : « qu'aurait rapporté ce pari
   * directionnel ? ». C'est cette série qui alimente le test séquentiel.
   *
   * @returns {number|null} rendement signé, ou null si non scorable
   */
  static score(action, hadPosition, excessReturn) {
    switch (action) {
      // Pari haussier explicite.
      case 'BUY':
        return excessReturn;

      // Pari baissier : sortir avant une baisse est une bonne prédiction.
      case 'SELL':
        return -excessReturn;

      case 'HOLD':
        // Avec position : « ça continue » — on reste long, on assume la suite.
        // Sans position : « il n'y a rien à prendre » — s'abstenir avant une
        // hausse est une erreur, s'abstenir avant une baisse est correct.
        return hadPosition ? excessReturn : -excessReturn;

      default:
        return null;
    }
  }

  /**
   * Rouvre les décisions dont l'horizon est échu et calcule leur score.
   *
   * @param {(symbol: string) => Promise<Array>} getBars  fournisseur de bougies
   */
  async resolve(getBars) {
    await this.init();

    const pending = this.store.pending();
    if (!pending.length) return { resolved: 0, pending: 0 };

    // Une seule série par symbole, réutilisée pour toutes ses décisions.
    const symbols = [...new Set([...pending.map((e) => e.symbol), BENCHMARK])];
    const series = {};

    for (const symbol of symbols) {
      try {
        series[symbol] = await getBars(symbol);
      } catch (err) {
        log.warn(`Bougies ${symbol} indisponibles pour la résolution : ${err.message}`);
      }
    }

    const benchBars = series[BENCHMARK];
    if (!benchBars?.length) {
      log.warn(`Référence ${BENCHMARK} indisponible — résolution reportée.`);
      return { resolved: 0, pending: pending.length };
    }

    let resolved = 0;
    // Les mises à jour sont accumulées puis écrites en UNE transaction : à
    // 150 actifs, résoudre décision par décision ferait autant de commits.
    const updates = [];

    for (const entry of pending) {
      const bars = series[entry.symbol];
      if (!bars?.length) continue;

      const outcomes = {};
      let complete = true;

      for (const horizon of HORIZONS) {
        const assetReturn = forwardReturn(bars, entry.t, entry.price, horizon);
        const benchReturn = forwardReturn(benchBars, entry.t, null, horizon);

        // Horizon pas encore échu : on réessaiera au prochain cycle.
        if (assetReturn == null || benchReturn == null) {
          complete = false;
          continue;
        }

        const excess = assetReturn - benchReturn;
        outcomes[`d${horizon}`] = {
          assetReturn: round(assetReturn, 6),
          benchReturn: round(benchReturn, 6),
          excessReturn: round(excess, 6),
          score: round(ShadowBook.score(entry.action, entry.hadPosition, excess), 6),
        };
      }

      if (Object.keys(outcomes).length) {
        // Une décision n'est close que lorsque le plus long horizon est échu.
        updates.push({ id: entry.id, outcomes, resolved: complete });
        if (complete) resolved += 1;
      }
    }

    if (updates.length) this.store.updateManyOutcomes(updates);
    this.lastResolutionAt = new Date().toISOString();

    if (resolved) log.info(`${resolved} décision(s) résolue(s) — ${this.store.pendingCount()} en attente`);
    return { resolved, pending: this.store.pendingCount() };
  }

  /**
   * Série de scores prête pour le test séquentiel.
   *
   * **Dégroupage des corrélations** : trois cycles quotidiens sur le même actif
   * en bougies journalières produisent quasiment la même décision. Les compter
   * trois fois sous-estimerait la variance et validerait à tort. On ne retient
   * donc qu'une observation par symbole et par jour.
   */
  async scoreSeries({ horizon = 3, filter = null, allRules = false } = {}) {
    await this.init();
    const key = `d${horizon}`;
    const out = [];

    // Le dégroupage par actif et par jour est fait en SQL (GROUP BY indexé) :
    // à 150 actifs sur un an, trier 110 000 entrées en mémoire à chaque appel
    // du dashboard serait absurde.
    const rows = this.store.scoredSeries({
      horizon,
      ruleVersion: allRules ? null : RULE_VERSION,
    });

    for (const entry of rows) {
      const outcome = entry.outcomes?.[key];
      if (!outcome || outcome.score == null) continue;
      if (filter && !filter(entry)) continue;

      out.push({
        t: entry.t,
        symbol: entry.symbol,
        action: entry.action,
        confidence: entry.confidence,
        newsAvailable: entry.newsAvailable,
        calendarPhase: entry.calendarPhase,
        score: outcome.score,
        excessReturn: outcome.excessReturn,
        pUp: entry.pUp ?? null,
        pUpGivenMove: entry.pUpGivenMove ?? null,
        edge: entry.edge ?? null,
        advisedAction: entry.advisedAction ?? null,
        advisoryConflict: Boolean(entry.advisoryConflict),
        voided: Boolean(entry.voided),
      });
    }

    return out;
  }

  /** Statistiques descriptives, segmentées pour répondre aux questions utiles. */
  async stats({ horizon = 3 } = {}) {
    const all = await this.scoreSeries({ horizon });
    if (!all.length) {
      // Le compteur d'attente doit sortir MÊME ici — c'est justement le cas où
      // il compte. Sans lui, le dashboard affichait « 0 décision mesurée, 0 en
      // attente » alors que vingt décisions attendaient leur résolution : on
      // croyait le carnet vide, donc le bot muet, alors qu'il enregistrait
      // normalement et qu'il fallait juste laisser passer trois séances.
      const pending = this.store.pendingCount();
      return {
        horizon,
        samples: 0,
        pendingResolution: pending,
        recorded: this.store.count(),
        rules: this.#ruleBreakdown(),
        lastResolutionAt: this.lastResolutionAt,
        note: pending
          ? `${pending} décision(s) enregistrée(s), aucune encore échue : le premier score arrive ${horizon} séances après la décision.`
          : 'Aucune décision enregistrée pour le moment.',
      };
    }

    // ── Score et rendement excédentaire ne sont PAS la même chose ──────────
    // Le score est signé selon le pari : pour un SELL, ou un HOLD sans
    // position, il vaut l'OPPOSÉ du rendement excédentaire. Les confondre
    // inverse la lecture — un segment HOLD affichant « excédent +0,53 % »
    // décrivait en réalité des titres ayant SOUS-performé de 0,53 %, que le bot
    // avait donc eu raison de laisser passer. Les deux faits sont intéressants,
    // à condition de ne pas prendre l'un pour l'autre.
    const segment = (label, subset) => {
      if (!subset.length) return null;
      const scores = subset.map((s) => s.score);
      const excesses = subset.map((s) => s.excessReturn).filter((v) => v != null);
      const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      const mean = avg(scores);
      const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(scores.length - 1, 1);
      const sd = Math.sqrt(variance);
      return {
        label,
        n: subset.length,
        // Ce que le pari a rapporté : c'est cette série qui alimente le SPRT.
        meanScorePct: round(mean * 100, 4),
        // Ce que les titres ont réellement fait face à l'indice.
        meanExcessPct: excesses.length ? round(avg(excesses) * 100, 4) : null,
        sdPct: round(sd * 100, 4),
        hitRate: round(scores.filter((s) => s > 0).length / scores.length, 4),
        sharpePerDecision: sd > 0 ? round(mean / sd, 4) : null,
      };
    };

    return {
      horizon,
      samples: all.length,
      overall: segment('toutes décisions', all),
      byAction: {
        BUY: segment('BUY', all.filter((s) => s.action === 'BUY')),
        SELL: segment('SELL', all.filter((s) => s.action === 'SELL')),
        HOLD: segment('HOLD', all.filter((s) => s.action === 'HOLD')),
      },
      // Est-ce que la confiance auto-déclarée veut dire quelque chose ?
      byConfidence: {
        haute: segment('confiance ≥ 0,6', all.filter((s) => s.confidence >= 0.6)),
        basse: segment('confiance < 0,6', all.filter((s) => s.confidence < 0.6)),
      },
      // Les actualités servent-elles à quelque chose ? Si les deux segments se
      // valent, le module news peut être supprimé et le cycle divisé par deux.
      byNews: {
        avecActus: segment('actualités disponibles', all.filter((s) => s.newsAvailable)),
        sansActus: segment('mode dégradé', all.filter((s) => !s.newsAvailable)),
      },
      // Le contexte calendaire change-t-il la donne ?
      byCalendar: {
        preTom: segment('PreTOM', all.filter((s) => s.calendarPhase === 'PRE_TOM')),
        tom: segment('TOM', all.filter((s) => s.calendarPhase === 'TOM')),
        neutre: segment('hors fenêtre', all.filter((s) => s.calendarPhase === 'NEUTRAL')),
      },

      // ── Les fréquences annoncées correspondent-elles aux constatées ? ────
      // On confronte la probabilité de surperformance au SIGNE du rendement
      // excédentaire, et non au score de l'action. La prévision est ainsi jugée
      // même lorsqu'un garde-fou a converti la décision en HOLD : c'est le
      // modèle qu'on mesure ici, pas notre propre machinerie de sécurité.
      calibration: calibration(
        all
          .filter((s) => s.pUpGivenMove != null && s.excessReturn != null)
          .map((s) => ({ p: s.pUpGivenMove, y: s.excessReturn > 0 ? 1 : 0 })),
      ),

      // ── Biais d'inaction, mesuré et non supposé ─────────────────────────
      // Part des décisions où le modèle recommandait autre chose que ce que sa
      // propre répartition impliquait, et dans quel sens. Si les conflits
      // penchent massivement vers un HOLD conseillé sur prévision haussière,
      // le biais du RLHF est établi sur NOS données — et le fait de dériver
      // l'action du seuil plutôt que de la lui demander est justifié.
      advisory: advisorySummary(all),

      pendingResolution: this.store.pendingCount(),
      rules: this.#ruleBreakdown(),
      lastResolutionAt: this.lastResolutionAt,
    };
  }

  /**
   * Remplace tout le contenu du carnet. Réservé aux tests et à une remise à
   * zéro explicite — jamais appelé par le moteur.
   *
   * Les champs absents reçoivent une valeur par défaut : les fixtures de test
   * décrivent le cas qu'elles vérifient, pas les vingt colonnes du schéma.
   */
  async replaceAll(entries) {
    await this.init();
    this.store.clear();
    this.store.insertMany(entries.map((e) => ({
      id: e.id ?? crypto.randomUUID(),
      t: e.t,
      day: e.day ?? e.t.slice(0, 10),
      symbol: e.symbol,
      action: e.action,
      confidence: e.confidence ?? 0,
      price: e.price ?? null,
      executed: e.executed ?? false,
      hadPosition: e.hadPosition ?? false,
      newsAvailable: e.newsAvailable ?? false,
      newsCount: e.newsCount ?? 0,
      calendarPhase: e.calendarPhase ?? null,
      model: e.model ?? null,
      source: e.source ?? 'llm',
      ruleVersion: e.ruleVersion ?? LEGACY_RULE,
      pUp: e.pUp ?? null,
      pUpGivenMove: e.pUpGivenMove ?? null,
      edge: e.edge ?? null,
      advisedAction: e.advisedAction ?? null,
      advisoryConflict: e.advisoryConflict ?? false,
      voided: e.voided ?? false,
      outcomes: e.outcomes ?? null,
      resolved: e.resolved ?? false,
    })));
    return entries.length;
  }

  /**
   * Répartition des décisions enregistrées par règle de décision.
   * Rend visible ce que la mesure écarte, au lieu de laisser croire que le
   * carnet entier alimente le verdict.
   */
  #ruleBreakdown() {
    // Agrégation en SQL : un GROUP BY plutôt qu'un parcours de toute la table.
    const counts = this.store.countByRule();
    const current = counts[RULE_VERSION] || 0;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return {
      current: RULE_VERSION,
      counts,
      usable: current,
      excluded: total - current,
      note: total - current > 0
        ? `${total - current} décision(s) écartée(s) de la mesure : produites par une règle antérieure. `
          + 'Le SPRT teste une stratégie, pas leur succession.'
        : null,
    };
  }
}

/** Divergences entre la recommandation du modèle et le seuil appliqué. */
function advisorySummary(all) {
  const withAdvice = all.filter((s) => s.advisedAction);
  if (!withAdvice.length) return null;

  const conflicts = withAdvice.filter((s) => s.advisoryConflict);
  // Le cas qui intéresse : le modèle freine alors que sa prévision pousse.
  const heldBack = conflicts.filter((s) => s.advisedAction === 'HOLD' && s.action !== 'HOLD');
  const pushedOn = conflicts.filter((s) => s.advisedAction !== 'HOLD' && s.action === 'HOLD');

  const meanScore = (subset) => (subset.length
    ? round((subset.reduce((a, s) => a + s.score, 0) / subset.length) * 100, 2)
    : null);

  return {
    n: withAdvice.length,
    tauxDeConflit: round(conflicts.length / withAdvice.length, 4),
    // « Le modèle disait d'attendre, le seuil a dit d'agir. »
    freinePar: {
      n: heldBack.length,
      // Qui avait raison ? Score moyen des décisions prises MALGRÉ son avis.
      scoreMoyenPct: meanScore(heldBack),
    },
    // « Le modèle voulait agir, le seuil a dit d'attendre. »
    retenuPar: {
      n: pushedOn.length,
      scoreMoyenPct: meanScore(pushedOn),
    },
    note: heldBack.length > pushedOn.length * 2 && heldBack.length >= 10
      ? 'Le modèle freine bien plus souvent qu\'il ne pousse : biais d\'inaction cohérent avec le RLHF.'
      : null,
  };
}

/**
 * Rendement entre la barre qui suit la décision et celle située `horizon`
 * jours de bourse plus tard. On part de la barre SUIVANTE, jamais de celle en
 * cours : décider sur la clôture du jour puis mesurer depuis ce même jour
 * introduirait un biais d'anticipation.
 */
function forwardReturn(bars, decisionIso, decisionPrice, horizon) {
  const decisionTime = Date.parse(decisionIso);
  const index = bars.findIndex((b) => Date.parse(b.time) > decisionTime);
  if (index === -1) return null;

  const targetIndex = index + horizon - 1;
  if (targetIndex >= bars.length) return null; // horizon pas encore échu

  const from = decisionPrice ?? bars[index].open;
  const to = bars[targetIndex].close;
  if (!(from > 0) || !(to > 0)) return null;

  return (to - from) / from;
}

const round = (v, d) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

export const shadowBook = new ShadowBook();
export { HORIZONS, BENCHMARK, RULE_VERSION, LEGACY_RULE };
