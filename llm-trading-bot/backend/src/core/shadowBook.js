import crypto from 'node:crypto';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { SqliteStore } from '../storage/SqliteStore.js';
import { calibration } from './calibration.js';
import { rankIC, rankCalibrationError, ecartApparie } from './rankMetrics.js';

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

/**
 * Horizons d'évaluation, en jours de bourse.
 *
 * 21 séances est devenu l'horizon de DÉCISION — celui sur lequel le bot
 * détient réellement. Les deux autres restent mesurés, et pas par nostalgie :
 * comparer le score à 1, 5 et 21 séances est ce qui permettra d'estimer la
 * vitesse de décroissance du signal, donc de recalibrer l'horizon sur des
 * données au lieu d'une conviction. Si le pouvoir prédictif s'effondre entre
 * 5 et 21, c'est qu'on détient trop longtemps ; s'il tient, c'est qu'on
 * pourrait détenir davantage encore.
 */
const HORIZONS = [1, 5, 21];

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
 *
 * ── v2 : passage au classement transversal ────────────────────────────────
 * Trois changements simultanés, chacun suffisant à lui seul pour invalider la
 * comparaison avec la série v1 :
 *
 *   • la décision d'acheter ne dépend plus d'un seuil appliqué à un actif isolé
 *     mais du RANG de cet actif parmi tous ceux du cycle ;
 *   • la taille de position ne dépend plus de la conviction annoncée — poids
 *     égal sur les retenus ;
 *   • le bot s'abstient entièrement quand la dispersion transversale est trop
 *     faible, situation qui n'existait pas en v1.
 *
 * S'y ajoute une contamination indépendante : des trades passés à la main ont
 * modifié les positions détenues, donc le contexte `hadPosition` d'une partie
 * des décisions v1. Ces décisions ne décrivent plus ce que le bot aurait fait.
 *
 * Le compteur repart de zéro. C'est le coût réel du changement de stratégie ;
 * le masquer coûterait la validité du verdict. La série v1 reste en base et
 * consultable — rien n'est effacé.
 *
 * ── v3 : la sortie devient relative, comme l'entrée ───────────────────────
 * La v2 avait rendu l'ENTRÉE relative — être dans les trois meilleurs — en
 * laissant la SORTIE absolue : ne vendre qu'un actif devenu franchement
 * mauvais, ce qui correspond à une chute sous la médiane, soit le rang 76 sur
 * 150. Les deux moitiés du bot suivaient donc deux philosophies opposées.
 *
 * La conséquence n'était pas théorique : trois positions simplement devenues
 * médiocres n'étaient jamais vendues, les trois emplacements restaient
 * occupés, et le classement transversal devenait inerte dès le premier jour.
 * Le mécanisme central de la v2 s'éteignait tout seul.
 *
 * La sortie suit désormais le rang, avec une bande dérivée de la loi en
 * racine cubique du coût de transaction : 13 rangs à 6,25 bps sur 150 actifs,
 * contre 73 auparavant. La condition absolue est conservée en plus.
 */
// v4 : horizon porté à 21 séances, sortie par le temps plutôt que par le stop,
// 10 positions au lieu de 3. Le changement est assez profond pour que mélanger
// les décisions d'avant et d'après fausserait toute mesure — d'où la nouvelle
// version de règle, qui les sépare dans le carnet.
const RULE_VERSION = 'classement-transversal-v4';

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
      // ── `confidence` est NULLE depuis que le modèle ordonne ─────────────
      // Il n'annonce plus de probabilité : il produit un ordre. Y écrire 0 par
      // défaut ferait croire à une confiance nulle mesurée, là où il n'y a
      // simplement rien à mesurer. On garde la distinction entre « le modèle
      // a annoncé 0 » et « le modèle n'a rien annoncé ».
      confidence: decision.confidence ?? null,
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
      // Rang transversal du jour. C'est cette valeur — et non la probabilité
      // brute — qui porte l'information exploitable : chez un modèle de
      // langage, le NIVEAU des probabilités est fréquemment faux là où leur
      // ORDRE reste valide. Le Rank IC se calcule dessus.
      rank: decision.rank ?? null,
      rankTotal: decision.rankTotal ?? null,
      rankFractional: decision.rankFractional ?? null,
      selected: Boolean(decision.selected),
      // Rangs des facteurs calculés par formule sur le MÊME instantané de
      // marché. C'est ce qui permettra de répondre à « l'IA bat-elle une simple
      // formule ? » — question que le bot ne posait jamais, alors qu'elle
      // décide si consulter un modèle de langage apporte quoi que ce soit.
      baselines: decision.baselines ?? null,
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
        // Même convention des deux côtés : ouverture de la séance suivante
        // vers la clôture à l'horizon. Toute asymétrie ici se retrouverait
        // intégralement dans l'écart, qui est la grandeur mesurée.
        const assetReturn = forwardReturn(bars, entry.t, horizon);
        const benchReturn = forwardReturn(benchBars, entry.t, horizon);

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
   * ── Deux dégroupages, pas un ──────────────────────────────────────────────
   *
   * 1. PAR JOUR (fait en SQL) : trois cycles quotidiens sur le même actif en
   *    bougies journalières produisent quasiment la même décision. Les compter
   *    trois fois sous-estimerait la variance et validerait à tort.
   *
   * 2. PAR FENÊTRE DE SCORE (fait ici) : c'est celui qui manquait, et il pesait
   *    plus lourd que le premier.
   *
   *    Une décision du lundi est notée sur mardi-mercredi-jeudi ; celle du mardi
   *    sur mercredi-jeudi-vendredi. Elles partagent DEUX jours sur trois. La
   *    série est donc un processus à moyenne mobile MA(h−1), d'autocorrélation
   *    voisine de 2/3 au décalage 1 et 1/3 au décalage 2.
   *
   *    Le SPRT accumule ses preuves en supposant les incréments conditionnel-
   *    lement indépendants. Sous ce recouvrement, l'inflation de variance vaut
   *    1 + 2(2/3 + 1/3) ≈ 3 — soit davantage que la correction transversale
   *    déjà appliquée (≈ 1,32). Le test concluait environ trois fois trop vite.
   *
   *    On espace donc les observations d'au moins `horizon` jours de bourse par
   *    actif. Cela divise le nombre d'observations par trois, sans rien coûter
   *    en information réelle : ces trois observations n'en contenaient qu'une.
   *    C'est de la comptabilité honnête, pas une perte.
   */
  async scoreSeries({ horizon = 3, filter = null, allRules = false, allowOverlap = false } = {}) {
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

    // Jours de bourse observés, par actif : sert de calendrier pour mesurer
    // l'espacement réel entre deux décisions (les week-ends et fériés ne
    // comptent pas, puisqu'aucune décision n'y est prise).
    const daysBySymbol = new Map();
    for (const r of rows) {
      if (!daysBySymbol.has(r.symbol)) daysBySymbol.set(r.symbol, []);
      const list = daysBySymbol.get(r.symbol);
      if (list[list.length - 1] !== r.day) list.push(r.day);
    }
    const lastKeptIndex = new Map();

    for (const entry of rows) {
      const outcome = entry.outcomes?.[key];
      if (!outcome || outcome.score == null) continue;
      if (filter && !filter(entry)) continue;

      if (!allowOverlap) {
        const calendar = daysBySymbol.get(entry.symbol);
        const index = calendar.indexOf(entry.day);
        const previous = lastKeptIndex.get(entry.symbol);
        // Fenêtres qui se chevauchent : on saute.
        if (previous != null && index - previous < horizon) continue;
        lastKeptIndex.set(entry.symbol, index);
      }

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
        rank: entry.rank ?? null,
        rankTotal: entry.rankTotal ?? null,
        rankFractional: entry.rankFractional ?? null,
        selected: Boolean(entry.selected),
        baselines: entry.baselines ?? null,
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
      // ── Le haut du classement fait-il mieux que le bas ? ────────────────
      // Segmentait sur la confiance auto-déclarée, qui n'existe plus depuis
      // que le modèle ordonne. Segmenter quand même sur ce champ aurait
      // rangé toutes les décisions du même côté sans que rien ne le signale.
      //
      // On segmente désormais sur le RANG, ce qui pose une question mieux
      // définie : le premier tiers du classement bat-il le dernier ? C'est le
      // test le plus direct de l'utilité de l'ordre produit.
      byRang: {
        haut: segment('tiers supérieur', all.filter((s) => s.rankFractional >= 0.67)),
        milieu: segment('tiers médian', all.filter((s) => s.rankFractional >= 0.33 && s.rankFractional < 0.67)),
        bas: segment('tiers inférieur', all.filter((s) => s.rankFractional != null && s.rankFractional < 0.33)),
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

      // ── Calibration ACTIF PAR ACTIF ─────────────────────────────────────
      // La calibration globale ci-dessus mélange tous les titres. Or « 60 »
      // sur une valeur volatile et « 60 » sur une défensive ne décrivent pas
      // le même degré de certitude : le modèle produit des probabilités
      // polarisées là où les mouvements sont tranchés, tempérées ailleurs.
      // Agrégés, ces deux régimes se compensent et donnent une calibration
      // globale flatteuse alors qu'AUCUN actif n'est bien calibré.
      calibrationParActif: calibrationBySymbol(all),

      // ── Le classement ordonne-t-il correctement ? ────────────────────────
      // C'est LA question dont dépend la stratégie depuis le passage au rang :
      // le bot n'utilise plus le niveau des probabilités, seulement leur ordre.
      // Mesuré à l'intérieur de chaque journée pour que « tout a monté
      // aujourd'hui » ne se fasse pas passer pour de la sélection de titres.
      rangs: rankSection(all, horizon),

      // ── LA question du projet : l IA bat-elle une formule ? ──────────────
      // Le carnet mesurait si le modèle bat le hasard. Battre le hasard est la
      // barre basse. La vraie question est de savoir si lire les actualités
      // apporte quelque chose qu un calcul gratuit ne donne pas déjà.
      comparaison: comparaisonFacteurs(all, horizon),

      // Sans résolution, aucun classement n est exploitable — et c est une
      // question EN AMONT de toutes les autres.
      resolution: resolutionClassements(all),

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
      rank: e.rank ?? null,
      rankTotal: e.rankTotal ?? null,
      rankFractional: e.rankFractional ?? null,
      baselines: e.baselines ?? null,
      selected: e.selected ?? false,
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
/**
 * Calibration par actif.
 *
 * Le seuil de 30 observations n'est pas décoratif : en dessous, la fréquence
 * réalisée d'un actif est dominée par sa propre variance et on lirait du bruit
 * comme un biais. Les actifs sous le seuil sont COMPTÉS et déclarés, pas
 * silencieusement omis — sinon on croirait avoir mesuré tout l'univers.
 */
function calibrationBySymbol(all, { minPerSymbol = 30 } = {}) {
  const bySymbol = new Map();
  for (const s of all) {
    if (s.pUpGivenMove == null || s.excessReturn == null) continue;
    if (!bySymbol.has(s.symbol)) bySymbol.set(s.symbol, []);
    bySymbol.get(s.symbol).push({ p: s.pUpGivenMove, y: s.excessReturn > 0 ? 1 : 0 });
  }

  const mesures = [];
  let insuffisants = 0;
  for (const [symbol, pairs] of bySymbol) {
    if (pairs.length < minPerSymbol) {
      insuffisants += 1;
      continue;
    }
    const c = calibration(pairs);
    mesures.push({
      symbol,
      n: c.n,
      brier: c.brier ?? null,
      ece: c.ece ?? null,
      pente: c.penteDeCalibration ?? null,
      biais: c.biaisMoyen ?? null,
    });
  }

  mesures.sort((a, b) => (b.ece ?? 0) - (a.ece ?? 0));

  // Dispersion des pentes entre actifs : c'est le nombre qui tranche la
  // question « peut-on comparer un 60 à un autre 60 ? ». Si les pentes varient
  // fortement d'un actif à l'autre, les probabilités ne sont pas comparables
  // entre actifs, et un seuil absolu commun à tous n'a aucun sens — ce qui est
  // exactement l'argument du passage au classement transversal.
  const pentes = mesures.map((m) => m.pente).filter((p) => Number.isFinite(p));
  let dispersionDesPentes = null;
  if (pentes.length >= 3) {
    const moy = pentes.reduce((a, b) => a + b, 0) / pentes.length;
    dispersionDesPentes = Math.sqrt(
      pentes.reduce((a, b) => a + (b - moy) ** 2, 0) / (pentes.length - 1),
    );
  }

  return {
    actifsMesures: mesures.length,
    actifsInsuffisants: insuffisants,
    seuil: minPerSymbol,
    dispersionDesPentes: round(dispersionDesPentes, 3),
    verdict: verdictParActif(mesures.length, dispersionDesPentes),
    parActif: mesures,
  };
}

function verdictParActif(n, dispersion) {
  if (n < 3) return `Seulement ${n} actif(s) au-delà du seuil — pas encore de comparaison possible entre actifs.`;
  if (dispersion == null) return `${n} actifs mesurés, pentes non calculables.`;
  if (dispersion > 0.4) {
    return `Les probabilités NE SONT PAS COMPARABLES entre actifs (dispersion des pentes ${dispersion.toFixed(2)}). `
      + 'Un « 60 » ne veut pas dire la même chose selon le titre : un seuil absolu commun sélectionnerait '
      + 'la volatilité plutôt que la qualité. Le classement transversal est justifié par les données.';
  }
  return `Pentes homogènes entre actifs (dispersion ${dispersion.toFixed(2)}) : les probabilités sont `
    + 'grossièrement comparables d\'un titre à l\'autre.';
}

/**
 * Section « rangs » : Rank IC et RCE, calculés à partir de l'écart de
 * probabilité et du rendement EXCÉDENTAIRE.
 *
 * Deux choix qui méritent d'être justifiés :
 *
 *   • On repart de `edge` plutôt que du rang enregistré au moment de la
 *     décision. Le rang enregistré portait sur TOUS les actifs du cycle, alors
 *     que la série mesurée en a écarté certains (dégroupage). Reclasser à
 *     l'intérieur de l'échantillon effectivement mesuré évite de confronter un
 *     rang sur 150 à une réalisation observée sur 12. Le rang enregistré reste
 *     en base : il sert de trace d'audit de ce que le bot a réellement fait.
 *
 *   • La cible est le rendement excédentaire, pas le score de l'action. Le
 *     score est retourné pour un SELL et pour un HOLD sans position ; il
 *     mesure la justesse de la DÉCISION. Ici on mesure la justesse de la
 *     PRÉVISION, qui est toujours orientée « surperformance ».
 */
function rankSection(all, horizon) {
  const rows = all
    .filter((s) => Number.isFinite(s.edge) && Number.isFinite(s.excessReturn))
    .map((s) => ({
      day: s.t.slice(0, 10),
      symbol: s.symbol,
      predicted: s.edge,
      realized: s.excessReturn,
    }));

  const ic = rankIC(rows, { horizon });

  // Rang fractionnaire recalculé dans chaque journée, sur les seuls actifs
  // retenus ce jour-là.
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(r);
  }
  const pairs = [];
  for (const group of byDay.values()) {
    if (group.length < 3) continue;
    const sorted = [...group].sort((a, b) => b.predicted - a.predicted);
    sorted.forEach((g, i) => {
      pairs.push({ rank: 1 - i / (sorted.length - 1), realized: g.realized });
    });
  }

  return {
    rankIC: ic,
    rce: rankCalibrationError(pairs),
    // Ce que le bot a effectivement retenu, par opposition à tout ce qu'il a
    // jugé. L'écart entre les deux mesure la valeur ajoutée de la sélection
    // elle-même — et non celle du modèle.
    retenus: (() => {
      const sel = all.filter((s) => s.selected && Number.isFinite(s.excessReturn));
      const reste = all.filter((s) => !s.selected && Number.isFinite(s.excessReturn));
      const moy = (xs) => (xs.length ? xs.reduce((a, s) => a + s.excessReturn, 0) / xs.length : null);
      return {
        n: sel.length,
        excesMoyenRetenusPct: round(moy(sel) == null ? null : moy(sel) * 100, 3),
        excesMoyenEcartesPct: round(moy(reste) == null ? null : moy(reste) * 100, 3),
      };
    })(),
  };
}

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
 * Rendement entre l'ouverture de la barre qui suit la décision et la clôture
 * située `horizon` séances plus tard.
 *
 * ── Pourquoi la barre SUIVANTE ───────────────────────────────────────────
 * Décider sur la clôture du jour puis mesurer depuis ce même jour
 * introduirait un biais d'anticipation.
 *
 * ── Pourquoi la MÊME convention pour l'actif et pour l'indice ────────────
 * Cette fonction acceptait un `decisionPrice` optionnel. L'actif était donc
 * mesuré depuis son prix au moment de la décision — vers 13 h 30 à New York —
 * tandis que l'indice, appelé sans ce paramètre, partait de l'ouverture du
 * LENDEMAIN. L'actif encaissait ainsi une demi-séance et une nuit de plus que
 * sa référence.
 *
 * Ce n'était pas un biais d'anticipation : le prix de décision est connu à
 * l'instant de la décision. C'était pire pour l'usage qu'on en fait — une
 * asymétrie SYSTÉMATIQUE entre les deux termes d'une différence. Et elle
 * penchait toujours du même côté : mesuré sur trois ans, la nuit porte 26,3 %
 * de rendement contre 1,2 % pour la séance. Offrir une nuit de plus à l'actif
 * qu'à l'indice gonflait l'écart d'environ 0,035 % par décision, toujours vers
 * le haut.
 *
 * L'enjeu n'est pas l'ampleur, c'est le SENS. Ce carnet est l'instrument censé
 * dire, dans quelques mois, si la stratégie vaut quelque chose. Un instrument
 * qui la flatte systématiquement confirmerait n'importe quoi.
 *
 * Le prix de décision reste enregistré et publié — il documente l'exécution.
 * Il ne sert simplement plus de base au calcul du rendement.
 */
function forwardReturn(bars, decisionIso, horizon) {
  const decisionTime = Date.parse(decisionIso);
  const index = bars.findIndex((b) => Date.parse(b.time) > decisionTime);
  if (index === -1) return null;

  const targetIndex = index + horizon - 1;
  if (targetIndex >= bars.length) return null; // horizon pas encore échu

  const from = bars[index].open;
  const to = bars[targetIndex].close;
  if (!(from > 0) || !(to > 0)) return null;

  return (to - from) / from;
}

const round = (v, d) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

export const shadowBook = new ShadowBook();
export { HORIZONS, BENCHMARK, RULE_VERSION, LEGACY_RULE };

/**
 * ── LA COMPARAISON QUI MANQUAIT ──────────────────────────────────────────
 *
 * Le carnet mesurait si le modèle bat le HASARD. Il ne mesurait jamais s'il bat
 * une FORMULE. Or battre le hasard est la barre basse : si le modèle obtient un
 * rang de 0,03 quand un simple retour à la moyenne en fait 0,04, il coûte
 * 450 appels par jour, vingt minutes par cycle et une surface de panne
 * considérable — pour faire moins bien que trois lignes de calcul.
 *
 * Les deux classements sont notés sur EXACTEMENT les mêmes rendements, aux
 * mêmes échéances, à partir du même instantané de marché. La seule différence
 * entre eux est que le modèle a vu les actualités en plus. C'est donc bien la
 * valeur ajoutée de la lecture d'actualités qu'on isole ici, et rien d'autre.
 */
function comparaisonFacteurs(all, horizon) {
  const base = (predicteur) => all
    .filter((s) => Number.isFinite(predicteur(s)) && Number.isFinite(s.excessReturn))
    .map((s) => ({
      day: s.t.slice(0, 10),
      symbol: s.symbol,
      predicted: predicteur(s),
      realized: s.excessReturn,
    }));

  const sources = {
    modele: { label: 'Modèle de langage', rows: base((s) => s.edge) },
  };

  // Les facteurs sont enregistrés en rang, pas en score : on utilise le rang
  // fractionnaire, qui est déjà l'information exploitée par la stratégie.
  const noms = new Set();
  for (const s of all) for (const n of Object.keys(s.baselines ?? {})) noms.add(n);

  for (const nom of noms) {
    sources[nom] = {
      label: nom,
      rows: base((s) => s.baselines?.[nom]?.fractionnaire),
    };
  }

  const resultats = {};
  const icBruts = {};
  for (const [nom, src] of Object.entries(sources)) {
    if (src.rows.length < 20) {
      resultats[nom] = { label: src.label, n: src.rows.length, note: 'pas assez de décisions' };
      continue;
    }
    const ic = rankIC(src.rows, { horizon });
    icBruts[nom] = ic;
    resultats[nom] = {
      label: src.label,
      n: src.rows.length,
      icMoyen: ic.icMoyen ?? null,
      tStat: ic.tStat ?? null,
      significatif: ic.significatif ?? false,
      jours: ic.jours ?? 0,
    };
  }

  // ── Le verdict ────────────────────────────────────────────────────────
  // On compare le modèle au MEILLEUR facteur, pas à leur moyenne : la question
  // n'est pas « bat-il un facteur quelconque » mais « apporte-t-il quelque
  // chose qu'aucune formule ne donne déjà ».
  const modele = resultats.modele;
  const facteurs = Object.entries(resultats)
    .filter(([nom, r]) => nom !== 'modele' && Number.isFinite(r.icMoyen));

  let verdict = 'Pas encore assez de décisions échues pour comparer.';
  let meilleurFacteur = null;

  // ── La comparaison est APPARIÉE, et ce n'est pas un raffinement ────────
  // Comparer deux IC moyens calculés séparément revient à jeter l'information
  // que les deux prédicteurs ont classé le MÊME univers le MÊME jour. Or
  // l'essentiel de la variance d'un IC quotidien vient du marché de ce jour-là,
  // et cette composante commune s'annule exactement dans la différence.
  //
  // Mesuré par simulation, à corrélation 0,89 entre les deux classements — la
  // valeur effectivement observée entre le modèle et le facteur momentum :
  //
  //     question absolue  (le modèle a-t-il un avantage ?)  : 24 mois
  //     question appariée (bat-il la formule ?)             :  6 mois
  //
  // Quatre fois plus vite, pour la question qui décide réellement de
  // l'architecture.
  let apparie = null;

  if (Number.isFinite(modele?.icMoyen) && facteurs.length) {
    meilleurFacteur = facteurs.reduce((a, b) => (b[1].icMoyen > a[1].icMoyen ? b : a));
    apparie = ecartApparie(icBruts.modele, icBruts[meilleurFacteur[0]], {
      label: `modèle − ${meilleurFacteur[1].label}`,
    });

    const attente = apparie.joursEstimesPourTrancher != null && apparie.jours > 0
      ? ` Au rythme observé, il faudrait environ ${apparie.joursEstimesPourTrancher} jours de mesure pour trancher (${apparie.jours} écoulés).`
      : '';

    if (!apparie.significatif) {
      verdict = `Le modèle et la formule « ${meilleurFacteur[1].label} » ne sont pas distinguables `
        + `sur ${apparie.jours ?? 0} jour(s) communs.${attente} `
        + 'À égalité, l\'avantage revient à la formule : gratuite, instantanée, reproductible.';
    } else if (apparie.tStat > 0) {
      verdict = `Le modèle DEVANCE « ${meilleurFacteur[1].label} » de `
        + `${(apparie.ecartMoyen * 100).toFixed(1)} points de corrélation par jour (t = ${apparie.tStat}). `
        + 'La lecture des actualités apporte quelque chose qu\'aucune formule ne capte.';
    } else {
      verdict = `La formule « ${meilleurFacteur[1].label} » DEVANCE le modèle de `
        + `${(-apparie.ecartMoyen * 100).toFixed(1)} points par jour (t = ${apparie.tStat}). `
        + 'Consulter un modèle de langage coûte cher pour faire moins bien qu\'un calcul gratuit.';
    }
  }

  return {
    parSource: resultats,
    meilleurFacteur: meilleurFacteur ? meilleurFacteur[0] : null,
    // Le test qui tranchera en premier. Les IC individuels restent publiés,
    // mais c'est celui-ci qu'il faut lire.
    apparie,
    verdict,
  };
}

/**
 * ── RÉSOLUTION DES CLASSEMENTS ───────────────────────────────────────────
 *
 * Combien de valeurs DISTINCTES chaque classement produit-il ?
 *
 * Mesuré en production : le modèle n'a donné que trois valeurs — 35, 40, 45 —
 * sur vingt réponses. Un facteur numérique en produit autant qu'il y a
 * d'actifs. Sans résolution, les rangs 4 à 100 sont massivement ex æquo et le
 * tri départage au hasard : aucune règle de sortie, aucun calibrage de bande
 * n'y remédie. C'est une question EN AMONT de toutes les autres.
 */
function resolutionClassements(all) {
  const distinctes = (valeurs) => new Set(valeurs.map((v) => v.toFixed(6))).size;

  const edges = all.map((s) => s.edge).filter(Number.isFinite);
  const out = {
    modele: edges.length
      ? { n: edges.length, distinctes: distinctes(edges), part: distinctes(edges) / edges.length }
      : null,
    facteurs: {},
  };

  const noms = new Set();
  for (const s of all) for (const n of Object.keys(s.baselines ?? {})) noms.add(n);
  for (const nom of noms) {
    const v = all.map((s) => s.baselines?.[nom]?.score).filter(Number.isFinite);
    if (v.length) out.facteurs[nom] = { n: v.length, distinctes: distinctes(v), part: distinctes(v) / v.length };
  }

  return out;
}
