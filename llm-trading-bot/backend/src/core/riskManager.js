import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { JsonStore } from '../storage/JsonStore.js';

const log = createLogger('risk');

const today = () => new Date().toISOString().slice(0, 10);
const currentMonth = () => new Date().toISOString().slice(0, 7);

/**
 * Gestionnaire de risque — la seule autorité qui décide de la TAILLE des ordres.
 * Le LLM propose une direction et une conviction ; ce module traduit cela en
 * quantité, puis oppose son veto si une limite est franchie.
 *
 * Garde-fous appliqués :
 *  1. Nombre maximum de positions simultanées
 *  2. Exposition maximale par position (% de l'équity)
 *  3. Ordre minimum (évite d'émietter 100 € en micro-lignes rongées par les frais)
 *  4. Stop-loss / take-profit automatiques, indépendants du LLM
 *  5. Coupe-circuit sur perte journalière
 */
export class RiskManager {
  constructor(limits = config.risk) {
    this.limits = limits;
    this.store = new JsonStore(config.storage.dir, 'risk-state.json', {
      month: currentMonth(),
      monthStartEquity: null,
      day: today(),
      circuitBreakerTrippedAt: null,
      blockedTradesThisMonth: 0,
    });
  }

  async init(account) {
    await this.store.load();
    await this.#rollPeriod(account);
    return this;
  }

  async #rollPeriod(account) {
    const s = this.store.data;
    if (s.month !== currentMonth() || s.monthStartEquity == null) {
      s.month = currentMonth();
      s.monthStartEquity = account.equity;
      s.circuitBreakerTrippedAt = null;
      s.blockedTradesThisMonth = 0;
      await this.store.save();
      log.info(`Nouveau mois de trading — équity de référence ${account.equity} ${account.currency}`);
    }
    if (s.day !== today()) {
      s.day = today();
      await this.store.save();
    }
  }

  /**
   * Coupe-circuit MENSUEL.
   *
   * ── Pourquoi mensuel et non journalier ───────────────────────────────────
   * Un seuil journalier de 10 % représente 10 $ sur ce compte. L'ATR journalier
   * d'une valeur comme TSLA atteint 3 à 5 % : sur un portefeuille investi, le
   * simple bruit stochastique d'une séance d'ouverture suffit à déclencher le
   * coupe-circuit. On couperait des stratégies gagnantes au hasard.
   *
   * À l'échelle du mois, une perte de 15 % ne relève plus du bruit : elle
   * signale une dérive du modèle ou un changement de régime que la calibration
   * n'a pas absorbé. C'est à ce niveau que l'arrêt devient informatif.
   *
   * Les ventes restent toujours autorisées : on doit pouvoir se protéger même
   * coupe-circuit déclenché.
   */
  async checkCircuitBreaker(account) {
    await this.#rollPeriod(account);
    const s = this.store.data;
    const reference = s.monthStartEquity || account.equity;
    const drawdown = (reference - account.equity) / reference;
    const limit = this.limits.maxMonthlyLossPct ?? this.limits.maxDailyLossPct ?? 0.15;

    if (drawdown >= limit) {
      if (!s.circuitBreakerTrippedAt) {
        s.circuitBreakerTrippedAt = new Date().toISOString();
        await this.store.save();
        log.error(
          `COUPE-CIRCUIT déclenché : -${(drawdown * 100).toFixed(2)} % sur le mois ` +
            `(limite ${(limit * 100).toFixed(0)} %). Aucun nouvel achat jusqu'au mois prochain.`,
        );
      }
      return { tripped: true, drawdownPct: drawdown * 100, since: s.circuitBreakerTrippedAt, period: 'mois' };
    }
    return { tripped: false, drawdownPct: drawdown * 100, since: null, period: 'mois' };
  }

  /**
   * Budget mobilisable sur un actif, exprimé en devise de compte ET en quantité.
   * Ce calcul est injecté dans le prompt : le LLM connaît ainsi ses limites
   * réelles au lieu de proposer des tailles fantaisistes.
   */
  computeBudget({ account, position, price, fxRate, circuitBreaker, ignorePolicyGates = false }) {
    const priceBase = price * fxRate;
    const maxByEquity = account.equity * this.limits.maxPositionPct;
    const alreadyInvested = position ? position.marketValue ?? 0 : 0;
    const headroom = Math.max(0, maxByEquity - alreadyInvested);
    const maxNotionalBase = Math.max(0, Math.min(headroom, account.cash));

    let canBuy = true;
    let blockReason = null;

    // ── Budget « arithmétique », sans les verrous de politique ──────────────
    // Utilisé UNIQUEMENT pour construire le prompt. Le coupe-circuit et le
    // plafond du nombre de positions sont nos règles de gestion, pas des faits
    // de marché : les afficher au modèle changerait sa PRÉVISION selon que le
    // portefeuille est plein ou non, et les observations cesseraient d'être
    // comparables entre elles.
    //
    // Ce n'est pas une précaution théorique : ce modèle lit le contexte dans ses
    // prévisions — mesuré ce matin, il penche à la baisse quand les actualités
    // manquent, à l'encontre d'une consigne explicite. Lui annoncer « achat
    // INTERDIT » influencerait de la même façon.
    //
    // Le prompt lui dit déjà : « le seuil de passage à l'acte est appliqué
    // ailleurs, tu n'as pas à en tenir compte ». Ce paramètre rend cette phrase
    // vraie.
    if (ignorePolicyGates) {
      return {
        maxNotionalBase,
        maxQuantity: priceBase > 0 ? Number((maxNotionalBase / priceBase).toFixed(6)) : 0,
        canBuy: maxNotionalBase >= this.limits.minOrderValue,
        blockReason: maxNotionalBase >= this.limits.minOrderValue
          ? null
          : `budget disponible ${maxNotionalBase.toFixed(2)} ${account.currency} < minimum ${this.limits.minOrderValue}`,
        totalAllowance: Number(maxByEquity.toFixed(2)),
        alreadyInvested: Number(alreadyInvested.toFixed(2)),
      };
    }

    if (circuitBreaker?.tripped) {
      canBuy = false;
      blockReason = `coupe-circuit actif (-${circuitBreaker.drawdownPct.toFixed(1)} % sur le ${circuitBreaker.period ?? 'mois'})`;
    } else if (!position && account.positionsCount >= this.limits.maxPositions) {
      canBuy = false;
      blockReason = `nombre maximum de positions atteint (${this.limits.maxPositions})`;
    } else if (maxNotionalBase < this.limits.minOrderValue) {
      canBuy = false;
      // ── Deux causes très différentes, un seul message jusqu'ici ──────────
      // « budget disponible 0.00 USD < minimum 5 » s'affichait aussi bien quand
      // le compte n'avait plus de liquidités que quand la ligne était DÉJÀ à
      // son plafond. Le second cas n'est pas un échec : c'est le
      // dimensionnement qui fonctionne.
      //
      // Observé le 17 août sur MPC, classé premier des 150 : le dashboard
      // annonçait « achat bloqué » alors que la position était pleine depuis le
      // cycle précédent. Rien n'avait échoué, tout avait marché.
      blockReason = alreadyInvested >= maxByEquity - 1e-9
        ? `exposition déjà au plafond sur cet actif (${alreadyInvested.toFixed(2)} ${account.currency} `
          + `pour ${maxByEquity.toFixed(2)} autorisés) — rien à ajouter`
        : `liquidités insuffisantes : ${maxNotionalBase.toFixed(2)} ${account.currency} `
          + `disponibles, minimum ${this.limits.minOrderValue}`;
    }

    return {
      maxNotionalBase,
      maxQuantity: priceBase > 0 ? Number((maxNotionalBase / priceBase).toFixed(6)) : 0,
      canBuy,
      blockReason,
      // Enveloppe TOTALE autorisée sur l'actif, et ce qui y est déjà engagé.
      // `maxNotionalBase` ne dit que la marge restante — c'est le bon chiffre à
      // montrer au modèle, mais pas celui sur lequel dimensionner : voir
      // `validate`, qui raisonne en exposition cible.
      totalAllowance: Number(maxByEquity.toFixed(2)),
      alreadyInvested: Number(alreadyInvested.toFixed(2)),
    };
  }

  /**
   * Traduit la décision du LLM en ordre exécutable, ou la rejette.
   * @returns {{approved:boolean, quantity:number, reason:string, adjustments:string[]}}
   */
  validate({ decision, account, position, price, fxRate, budget }) {
    const adjustments = [];
    const priceBase = price * fxRate;

    if (decision.action === 'HOLD') {
      // « décision HOLD » ne disait rien : ni pourquoi, ni ce qu'il aurait fallu
      // pour agir. Or l'inaction est le cas le plus FRÉQUENT du bot — c'est donc
      // celui qui a le plus besoin d'être expliqué, sinon le journal se résume à
      // dix lignes identiques et illisibles.
      return {
        approved: false,
        quantity: 0,
        reason: explainHold(decision, position, this.limits),
        adjustments,
      };
    }

    if (decision.action === 'SELL') {
      if (!position || position.quantity <= 0) {
        return {
          approved: false,
          quantity: 0,
          reason: 'vente refusée : aucune position détenue (vente à découvert interdite)',
          adjustments,
        };
      }
      // Sortie totale. Une sortie partielle laisserait une position résiduelle
      // de quelques dollars, dont le stop serait plus coûteux à gérer que la
      // ligne ne vaut — et sur un compte de 100 $ elle ne protège de rien.
      const quantity = position.quantity;
      return { approved: quantity > 0, quantity, reason: 'vente autorisée', adjustments };
    }

    // --- BUY ---
    if (!budget.canBuy) {
      return { approved: false, quantity: 0, reason: `achat bloqué : ${budget.blockReason}`, adjustments };
    }
    // ── Le seuil de confiance ne s'applique QUE si une confiance existe ────
    // Ce garde-fou datait de l'époque où le modèle annonçait une probabilité.
    // Depuis qu'il ORDONNE au lieu de noter, il n'en annonce plus aucune, et
    // le champ vaut délibérément `null` — écrire 0 ferait croire à une
    // confiance nulle mesurée là où il n'y a rien à mesurer.
    //
    // Or en JavaScript, `null < 0.35` vaut VRAI : le garde-fou bloquait donc
    // la totalité des achats, en silence, avec un message parlant d'une
    // « probabilité null ». Le bot classait, sélectionnait, filtrait, puis
    // refusait tout au dernier verrou.
    //
    // Un seuil sur une valeur absente n'a pas de sens. Quand aucune confiance
    // n'est annoncée, il n'y a rien à comparer — c'est le RANG qui joue déjà
    // ce rôle, et il l'a joué en amont.
    const minConfidence = this.limits.minConfidence ?? 0.35;
    const confianceAnnoncee = Number.isFinite(decision.confidence);
    if (confianceAnnoncee && decision.confidence < minConfidence) {
      return {
        approved: false,
        quantity: 0,
        reason: `achat bloqué : probabilité ${decision.confidence} sous le seuil ${minConfidence}`,
        adjustments,
      };
    }

    // ── Une seule fonction de conviction, pas deux ─────────────────────────
    // Cette ligne multipliait `sizePct` par (0,5 + confiance/2). C'était
    // cohérent quand le modèle fournissait lui-même une taille et une confiance
    // indépendantes : le second facteur corrigeait la première.
    //
    // Ce n'est plus le cas. `sizePct` est maintenant DÉDUIT de l'écart de
    // probabilité, donc il encode déjà la conviction. Le produit des deux
    // appliquait une conviction au carré, avec une forme que personne n'a
    // choisie — et rabotait les positions de 5 à 25 % au passage.
    //
    // ── EXPOSITION CIBLE, PAS ACHAT INCRÉMENTAL ────────────────────────────
    // `sizePct` dimensionnait la MARGE RESTANTE, pas l'enveloppe totale. Sur
    // trois cycles consécutifs au même signal, cela produisait trois achats
    // décroissants — 12,02 $ puis 5,74 $ puis 5,11 $ — une série géométrique
    // convergeant vers le plafond, chaque tranche payant le spread.
    //
    // Or les bougies sont JOURNALIÈRES : à trois cycles par jour, le RSI,
    // l'ATR et la tendance sont pratiquement identiques. C'est la même décision
    // exécutée trois fois. Le carnet fantôme le reconnaît déjà et déduplique à
    // une observation par actif et par jour ; l'exécution, elle, comptait ces
    // signaux comme indépendants. Incohérence corrigée ici.
    //
    // `sizePct` exprime donc désormais une exposition VOULUE sur l'enveloppe
    // entière. On n'achète que l'écart entre cette cible et ce qui est déjà
    // engagé. Même signal deux fois → rien à faire. Conviction réellement
    // renforcée un autre jour → la cible monte, et on complète.
    const allowance = budget.totalAllowance ?? budget.maxNotionalBase;
    const invested = budget.alreadyInvested ?? 0;
    const target = allowance * decision.sizePct;
    const notional = Math.min(target - invested, budget.maxNotionalBase);

    if (invested > 0) {
      adjustments.push(
        `exposition cible ${target.toFixed(2)} ${account.currency}, déjà engagé ${invested.toFixed(2)} → complément ${notional.toFixed(2)}`,
      );
    }

    // Asymétrie DÉLIBÉRÉE : quand la cible tombe sous l'exposition en cours, on
    // ne allège pas. La fonction de dimensionnement gouverne l'ENTRÉE ; la
    // sortie appartient au stop et aux signaux de vente.
    //
    // En faire un rebalanceur continu paraîtrait plus cohérent et coûterait
    // cher : la conviction du modèle oscille de quelques points d'un cycle à
    // l'autre, chaque ajustement paierait le spread mesuré (~11 bps), et cette
    // rotation mangerait précisément l'avantage qu'on cherche à mesurer.
    if (notional < this.limits.minOrderValue && invested > 0) {
      return {
        approved: false,
        quantity: 0,
        reason:
          `achat ignoré : exposition déjà proche de la cible (${invested.toFixed(2)} sur ${target.toFixed(2)} ${account.currency} visés) `
          + '— le signal n\'a pas changé depuis la dernière entrée',
        adjustments,
      };
    }
    if (notional < this.limits.minOrderValue) {
      return {
        approved: false,
        quantity: 0,
        reason: `achat bloqué : notionnel ${notional.toFixed(2)} ${account.currency} sous le minimum ${this.limits.minOrderValue}`,
        adjustments,
      };
    }

    const quantity = Number((notional / priceBase).toFixed(6));
    if (decision.sizePct > 1) adjustments.push('taille demandée > 100 % du budget, ramenée au plafond');
    adjustments.push(`notionnel retenu ${notional.toFixed(2)} ${account.currency} sur ${budget.maxNotionalBase.toFixed(2)} autorisés`);

    return { approved: quantity > 0, quantity, reason: 'achat autorisé', adjustments };
  }

  /**
   * Niveaux de protection posés à l'ouverture.
   *
   * Le stop est dimensionné sur l'ATR et non sur un pourcentage fixe. La
   * raison est empirique : un stop à 5 % est SOUS le bruit quotidien d'une
   * valeur dont l'ATR journalier atteint 3 à 5 %. On se ferait sortir au hasard
   * par de la variance normale, pas par une invalidation de la thèse.
   *
   * Le plancher et le plafond évitent les deux dérives : un actif anormalement
   * calme donnerait un stop si serré qu'il déclencherait au moindre tick, un
   * actif en crise donnerait un stop si large qu'il ne protégerait plus rien.
   *
   * ── L'objectif de gain, longtemps refusé, et pourquoi il revient ────────
   * Il était écarté au motif qu'« un objectif fixe tronque la queue droite de
   * la distribution et détruit l'espérance des mouvements de tendance, qui
   * reposent précisément sur une minorité de gains très étendus ».
   *
   * L'argument est juste pour une stratégie de tendance longue. Il ne l'est
   * pas ici : mesuré sur dix ans de simulation du code réel, les dix meilleurs
   * trades ne font que 9 % des gains et le plus gros vaut +64 %. La détention
   * de 21 séances et la sortie au rang 23 empêchent déjà toute position de
   * courir. L'objectif protégeait une queue qui n'existe pas.
   *
   * Médiane de l'excédent annuel contre le même univers, par régime :
   *
   *     régime            sans objectif   bande 10-16 %
   *     2017-2019 calme       -5,3 pt        -0,0 pt
   *     2020-2022 disloqué    +8,7 pt       +12,8 pt
   *     2023-2026 récent      +3,2 pt        +9,0 pt
   *
   * Les trois régimes s'améliorent, et six valeurs contiguës de la bande sont
   * toutes au-dessus de la référence. C'est ce qui distingue cet effet des
   * pistes écartées cette semaine, où une valeur isolée sortait du bruit.
   *
   * ── Le NIVEAU, lui, n'est pas déterminable ──────────────────────────────
   * Entre 13 % et 17 %, la période 2017-2019 donne +4,1 / -1,1 / +0,9 / -4,6.
   * Des seuils voisins produisent des portefeuilles quasi identiques : cette
   * oscillation de cinq points est du bruit de trades individuels.
   *
   * ── Et le piège s'est refermé une première fois ─────────────────────────
   * J'avais retenu 13 %, en croyant prendre le milieu de la bande. Rejoué sur
   * dix ans, ce seuil-là donnait 1428 $ quand ses quatre voisins immédiats
   * tenaient tous autour de 1080 $ :
   *
   *     11 %    12 %     13 %     14 %     15 %     16 %    17 %
   *     756 $  1081 $   1428 $   1100 $   1073 $   1028 $   837 $
   *
   * 13 % n'était pas le centre, c'était le sommet — et un sommet isolé de
   * 32 % au-dessus de ses deux voisins ne décrit aucun phénomène.
   *
   * Le plateau réel va de 12 % à 16 %, et son milieu est 14 %. Sa valeur
   * (1100 $) est représentative de la bande, non exceptionnelle. C'est ce qui
   * la rend utilisable : on n'attend pas 1428 $, on attend ~1080 $.
   *
   * ── Pourquoi ça peut marcher ───────────────────────────────────────────
   * Le classement achète des titres à momentum extrême. Or l'IC transversal
   * de `momentumCourt` est NÉGATIF : les gagnants extrêmes reviennent en
   * arrière. Le bot exploite malgré tout son décile de tête, mais garder une
   * position après +13 % de hausse SUPPLÉMENTAIRE, c'est la détenir dans la
   * zone où le signal se retourne. L'objectif sort avant.
   */
  protectionLevels(entryPrice, atr) {
    const raw = atr > 0 ? (this.limits.stopAtrMultiple * atr) / entryPrice : this.limits.stopMinPct;
    const stopPct = Math.min(Math.max(raw, this.limits.stopMinPct), this.limits.stopMaxPct);
    const tp = this.limits.takeProfitPct;

    return {
      stopPrice: Number((entryPrice * (1 - stopPct)).toFixed(4)),
      takeProfitPrice: tp > 0 ? Number((entryPrice * (1 + tp)).toFixed(4)) : null,
      stopPct: Number(stopPct.toFixed(4)),
      atrUsed: atr ?? null,
    };
  }

  /**
   * Sorties automatiques, évaluées AVANT toute consultation du LLM.
   * Un stop ne se négocie pas : il s'exécute.
   */
  checkExits(position, price) {
    if (!position || position.quantity <= 0) return null;

    // Si aucun stop n'a été posé (position ouverte hors du bot, ou état perdu),
    // on retombe sur le plancher plutôt que de laisser la ligne sans protection.
    const stop = position.stopPrice ?? position.avgPrice * (1 - this.limits.stopMinPct);

    if (price <= stop) {
      return { triggered: 'STOP_LOSS', reason: `stop touché : ${price} <= ${stop.toFixed(4)}`, level: stop };
    }

    // Objectif de gain, posé à l'entrée par `protectionLevels` à +14 % — le
    // milieu du plateau mesuré entre 12 % et 16 %. Ce commentaire disait
    // encore « ce que la stratégie ne fait plus », vestige de la période où
    // `takeProfitPct` valait zéro : la lecture du code laissait croire que les
    // positions n'avaient pas d'objectif, alors que les dix lignes ouvertes en
    // portent une.
    if (position.takeProfitPrice && price >= position.takeProfitPrice) {
      return {
        triggered: 'TAKE_PROFIT',
        reason: `objectif atteint : ${price} >= ${position.takeProfitPrice.toFixed(4)}`,
        level: position.takeProfitPrice,
      };
    }
    return null;
  }

  get state() {
    return this.store.data;
  }
}

/**
 * Explique une inaction en toutes lettres.
 *
 * Le bot ne fait rien dans la grande majorité des cycles : c'est le
 * comportement attendu, pas une panne. Mais un journal qui répète « décision
 * HOLD » dix fois par cycle est inexploitable — on ne sait pas ce qu'il aurait
 * fallu pour agir.
 *
 * ── Deux régimes, parce qu'il y a deux façons de décider ──────────────────
 * Ce message décrivait une répartition de probabilités et un seuil à franchir.
 * C'était juste du temps où le modèle notait chaque actif isolément.
 *
 * Il CLASSE désormais, et rien de tout ça n'existe plus : `pUp`, `pDown` et
 * `pFlat` sont absents, si bien que `Math.round(undefined * 100)` produisait
 * « aucune action (NaN hausse / NaN baisse / NaN indécis) ». Constaté sur
 * ANET, DELL et CVX le 17 août — trois titres pourtant classés 6e, 7e et 8e.
 *
 * Ce qui décide maintenant est le RANG : on est retenu ou non selon sa place,
 * pas selon un seuil absolu. Le message le dit, et le seuil n'y figure plus
 * puisqu'il n'y en a pas.
 */
function explainHold(decision, position, limits) {
  const f = decision.forecast;
  const held = Boolean(position && position.quantity > 0);

  if (!f) {
    return held
      ? 'position conservée : aucune prévision exploitable, on ne touche à rien par défaut'
      : 'aucune action : aucune prévision exploitable';
  }

  // Régime CLASSEMENT : le rang est publié, aucune probabilité ne l'est.
  const rangConnu = Number.isFinite(decision.rangDecision) && Number.isFinite(decision.totalDecision);
  if (rangConnu) {
    const place = `rang ${decision.rangDecision} sur ${decision.totalDecision}`;
    return held
      ? `position conservée : ${place}, encore dans la bande de non-négociation`
      : `aucune action : ${place}, hors des dix retenus`;
  }

  // Régime PROBABILISTE, conservé pour les entrées antérieures du journal.
  const probabiliste = [f.pUp, f.pDown, f.pFlat].every(Number.isFinite);
  if (!probabiliste) {
    const force = Number.isFinite(f.edge) ? ` (force ${f.edge.toFixed(2)})` : '';
    return held
      ? `position conservée${force} : classement encore favorable`
      : `aucune action${force} : hors des dix retenus`;
  }

  const pct = (v) => Math.round(v * 100);
  const repartition = `${pct(f.pUp)} hausse / ${pct(f.pDown)} baisse / ${pct(f.pFlat)} indécis`;
  const ecart = Math.round(f.edge * 100);
  const seuil = Math.round((limits.minEdge ?? 0.2) * 100);
  const signe = ecart >= 0 ? `+${ecart}` : `${ecart}`;

  // Quand le modèle recommandait autre chose, c'est l'information la plus
  // parlante du message : elle montre que c'est le seuil qui a tranché.
  const avis = decision.advisedAction && decision.advisedAction !== 'HOLD'
    ? ` — le modèle conseillait ${decision.advisedAction}, le seuil a dit non`
    : '';

  if (held) {
    return `position conservée (${repartition}) : écart ${signe} pts, il en faudrait -${seuil} pour sortir${avis}`;
  }
  return `aucune action (${repartition}) : écart ${signe} pts, il en faudrait +${seuil} pour entrer${avis}`;
}
