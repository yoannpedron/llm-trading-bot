import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { getMarketSnapshot, getQuote, isTradeable } from '../data/marketData.js';
import { spreadLog } from '../data/spreadLog.js';
import { calendarPhase } from '../data/calendar.js';
import { shadowBook, BENCHMARK } from './shadowBook.js';
import { rankAndSelect } from './ranking.js';
import { getNews } from '../news/newsService.js';
import { decide } from '../llm/agent.js';

const log = createLogger('engine');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Moteur de trading — orchestre un cycle complet :
 *
 *   1. Valorisation du portefeuille aux prix courants
 *   2. Coupe-circuit journalier
 *   3. Sorties automatiques (stop-loss / take-profit) — AVANT le LLM
 *   4. Pour chaque actif : données de marché + indicateurs + actualités
 *      → prompt → décision LLM → validation risque → exécution broker
 *   5. Journalisation de tout, y compris des non-décisions
 *
 * Le moteur ne connaît ni Gemini ni Yahoo ni le courtier : il ne manipule que
 * les interfaces (`decide`, `getMarketSnapshot`, `BrokerAdapter`).
 */
export class TradingEngine {
  constructor({ broker, risk, journal }) {
    this.broker = broker;
    this.risk = risk;
    this.journal = journal;
    this.isRunning = false;
    this.paused = false;
    this.lastCycle = null;
    this.cycleCount = 0;
  }

  get status() {
    return {
      isRunning: this.isRunning,
      paused: this.paused,
      cycleCount: this.cycleCount,
      lastCycleAt: this.journal.lastCycleAt,
      lastCycle: this.lastCycle,
      broker: this.broker.name,
      isLive: this.broker.isLive,
      llmProvider: config.llm.provider,
      model: config.llm.model,
      symbols: config.universe.symbols,
      interval: config.universe.interval,
      cron: config.schedule.cron,
    };
  }

  /**
   * Récupère cotations et bougies de tous les actifs suivis ou détenus.
   * Le passage par `getQuote` alimente au passage le journal des spreads,
   * qui construit la mesure empirique de notre coût de transaction réel.
   */
  async #collectQuotes(symbols) {
    const quotes = {};
    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const [snapshot, quote] = await Promise.all([getMarketSnapshot(symbol), getQuote(symbol)]);
          quotes[symbol] = {
            price: quote.price,
            bid: quote.bid,
            ask: quote.ask,
            spreadBps: quote.spreadBps,
            // Compte et actifs sont tous deux en USD : plus aucune conversion.
            fxRate: 1,
            currency: 'USD',
            snapshot,
          };
        } catch (err) {
          log.warn(`Cotation ${symbol} indisponible : ${err.message}`);
        }
      }),
    );
    return quotes;
  }

  /**
   * Applique les stops et objectifs sur les positions ouvertes.
   * Ces sorties sont mécaniques : elles ne passent jamais par le LLM.
   */
  async #applyProtectiveExits(quotes) {
    const exits = [];
    for (const position of await this.broker.getPositions()) {
      const quote = quotes[position.symbol];
      if (!quote) continue;

      const exit = this.risk.checkExits(position, quote.price);
      if (!exit) continue;

      const result = await this.broker.sell({
        symbol: position.symbol,
        quantity: position.quantity,
        price: quote.price,
        fxRate: quote.fxRate,
        meta: { source: exit.triggered, reason: exit.reason },
      });

      await this.journal.record({
        symbol: position.symbol,
        source: 'risk-manager',
        action: 'SELL',
        executed: result.status === 'filled',
        confidence: 1,
        justification: `Sortie automatique — ${exit.reason}`,
        technicalRationale: `Niveau ${exit.triggered} à ${exit.level.toFixed(4)}, prix ${quote.price}.`,
        newsSentiment: 'INDISPONIBLE',
        newsRationale: 'Sortie mécanique : les actualités ne sont pas consultées.',
        riskDecision: result.status === 'filled' ? 'exécuté' : result.reason,
        trade: result.trade ?? null,
        price: quote.price,
      });

      log.warn(`${exit.triggered} sur ${position.symbol} — ${exit.reason}`);
      exits.push({ symbol: position.symbol, type: exit.triggered, status: result.status });
    }
    return exits;
  }

  /**
   * PHASE 1 — évalue un actif SANS rien exécuter.
   *
   * La séparation évaluation / exécution est ce qui rend possible le classement
   * transversal : on ne peut pas choisir les meilleurs sans les avoir tous vus.
   * Auparavant chaque actif était jugé isolément contre un seuil absolu et
   * exécuté dans la foulée, si bien qu'avec un univers large le bot achetait
   * simplement les premiers de la liste à franchir la barre — l'ordre du
   * fichier de configuration décidait du portefeuille.
   */
  async #evaluateSymbol(symbol, { quotes, circuitBreaker }) {
    const outcome = { symbol, action: 'HOLD', executed: false, reason: null };

    try {
      const quote = quotes[symbol];
      const snapshot = quote?.snapshot ?? (await getMarketSnapshot(symbol));
      const fxRate = 1; // compte et actifs en USD : aucune conversion
      // Le prix de décision est la cotation courante si on l'a, sinon la
      // dernière clôture. On ne décide jamais sur un prix plus vieux que ça.
      const price = quote?.price ?? snapshot.indicators.price;

      const position = await this.broker.getPosition(symbol);

      if (config.schedule.onlyMarketHours) {
        const tradeable = await isTradeable(snapshot);
        if (!tradeable.open) {
          outcome.reason = `analyse ignorée : ${tradeable.reason}`;
          log.info(`${symbol} — ${outcome.reason}`);
          return outcome;
        }
      }

      const account = await this.broker.getAccount();
      const budget = this.risk.computeBudget({ account, position, price, fxRate, circuitBreaker });

      // ── ON INTERROGE TOUJOURS LE MODÈLE, MÊME SANS POUVOIR AGIR ────────────
      //
      // Une version précédente sautait l'appel LLM quand aucune action n'était
      // possible — plafond de positions atteint, ou coupe-circuit — pour
      // « ménager le quota et la latence ». C'était une fausse économie, et
      // mesurée comme telle : 30 appels par cycle pour 1000 disponibles, soit
      // 4 % du quota. Elle coûtait 70 % de l'instrument de mesure.
      //
      // Dès que 3 positions étaient tenues, 7 actifs sur 10 disparaissaient du
      // carnet fantôme. Le bot vendant rarement, c'était le régime NORMAL, pas
      // l'exception. Et le biais était pire que la perte de volume : les seuls
      // actifs encore mesurés étaient ceux qu'on détenait déjà, si bien qu'on
      // aurait mesuré « sait-il garder ? » en croyant mesurer « sait-il
      // choisir ? ».
      //
      // « Ç'aurait été un bon achat ? » est précisément la question que le
      // carnet fantôme existe pour trancher — et elle vaut le plus cher
      // justement quand on n'a pas pu agir.
      const news = await getNews(symbol);
      const phase = calendarPhase();

      // Budget présenté au modèle : arithmétique seule, sans nos verrous de
      // politique. Sinon la prévision dépendrait de l'état du portefeuille et
      // les observations cesseraient d'être comparables d'un cycle à l'autre.
      const promptBudget = this.risk.computeBudget({
        account, position, price, fxRate, circuitBreaker, ignorePolicyGates: true,
      });

      const decision = await decide({
        snapshot,
        news,
        account,
        position,
        budget: promptBudget,
        calendar: phase,
        constraints: config.risk,
      });

      outcome.action = decision.action;

      // L'évaluation s'arrête ici : le classement transversal, la sélection et
      // l'exécution appartiennent à la phase 2.
      return {
        ...outcome,
        evaluated: true,
        decision, snapshot, news, phase, price, fxRate, position, account, budget,
      };
    } catch (err) {
      log.error(`Échec de l'évaluation de ${symbol} : ${err.message}`);
      outcome.reason = err.message;
      return outcome;
    }
  }

  /** Exécute une décision déjà évaluée, puis la consigne. */
  async #executeEvaluation(evaluation, { selected, rankInfo, rankingReason }) {
    const { symbol, decision, snapshot, news, phase, price, fxRate, position, account, budget } = evaluation;
    const outcome = { symbol, action: decision.action, executed: false, reason: null };

    try {
      // La sélection transversale prime : un actif hors du top K ne s'achète
      // pas, même si sa prévision est bonne dans l'absolu.
      const effective = { ...decision };
      if (decision.action === 'BUY' && !selected.has(symbol)) {
        effective.action = 'HOLD';
        effective.sizePct = 0;
      }
      outcome.action = effective.action;

      // La validation, elle, s'appuie sur le budget RÉEL, verrous compris.
      const validation = this.risk.validate({
        decision: effective, account, position, price, fxRate, budget,
      });

      let tradeResult = null;
      if (validation.approved && effective.action === 'BUY') {
        tradeResult = await this.broker.buy({
          symbol,
          quantity: validation.quantity,
          price,
          currency: snapshot.currency,
          fxRate,
          meta: { source: 'llm', reason: decision.justification.slice(0, 200), confidence: decision.confidence },
        });
        if (tradeResult.status === 'filled') {
          // Le stop est dimensionné sur l'ATR courant de l'actif, pas sur un
          // pourcentage arbitraire ni sur une suggestion du modèle.
          //
          // Référence : le prix de revient MOYEN de la position après l'ordre,
          // pas le prix du dernier fill. Sur une position complétée en
          // plusieurs fois, se baser sur le dernier fill faisait dériver le
          // stop au gré du hasard intraday — il protégeait la dernière tranche
          // au lieu du capital réellement engagé.
          const after = await this.broker.getPosition(symbol);
          const reference = after?.avgPrice ?? tradeResult.trade.price;
          const levels = this.risk.protectionLevels(reference, snapshot.indicators.atr14);
          await this.broker.setProtection(symbol, levels);
          log.info(
            `Stop posé sur ${symbol} à ${levels.stopPrice} (${(levels.stopPct * 100).toFixed(1)} %, `
            + `ATR ${levels.atrUsed}, PRU ${reference})`,
          );
        }
      } else if (validation.approved && effective.action === 'SELL') {
        tradeResult = await this.broker.sell({
          symbol,
          quantity: validation.quantity,
          price,
          fxRate,
          meta: { source: 'llm', reason: decision.justification.slice(0, 200), confidence: decision.confidence },
        });
      }

      outcome.executed = tradeResult?.status === 'filled';
      outcome.reason = tradeResult?.reason ?? validation.reason;

      await this.journal.record({
        symbol,
        source: 'llm',
        action: effective.action,
        executed: outcome.executed,
        confidence: decision.confidence,
        sizePct: decision.sizePct,
        justification: decision.justification,
        newsSentiment: decision.newsSentiment,
        // La répartition annoncée : sans elle, le journal affiche une confiance
        // de 55 % sans dire d'où elle sort ni de quel côté elle penche.
        forecast: decision.forecast,
        // Le pré-mortem était produit par le modèle à chaque décision et jeté.
        // C'est pourtant la partie la plus instructive : ce que le modèle
        // considère lui-même comme le point faible de sa lecture.
        preMortem: decision.preMortem,
        // Divergence entre son conseil et ce que le seuil a décidé.
        advisedAction: decision.advisedAction,
        advisoryConflict: decision.advisoryConflict,
        riskFlags: decision.riskFlags,
        riskDecision: outcome.reason,
        riskAdjustments: validation.adjustments,
        agentWarnings: decision.warnings,
        model: decision.provider,
        price,
        currency: snapshot.currency,
        indicators: snapshot.indicators,
        newsProvider: news.provider,
        newsCount: news.articles.length,
        headlines: news.articles.slice(0, 5).map((a) => ({ title: a.title, source: a.source, url: a.url, publishedAt: a.publishedAt })),
        trade: tradeResult?.trade ?? null,
      });

      // Le carnet fantôme enregistre TOUTES les décisions, exécutées ou non.
      // C'est ce qui fait passer la mesure de ~70 observations par an à ~1000 :
      // sans lui, 99 % de ce que produit le bot serait jeté.
      await shadowBook.record({
        symbol,
        action: decision.action,
        confidence: decision.confidence,
        price,
        executed: outcome.executed,
        hadPosition: Boolean(position && position.quantity > 0),
        newsAvailable: !news.degraded,
        newsCount: news.articles.length,
        calendarPhase: phase.phase,
        model: decision.provider,
        source: 'llm',
        // La prévision chiffrée, indispensable à la mesure de calibration.
        forecast: decision.forecast,
        advisedAction: decision.advisedAction,
        advisoryConflict: decision.advisoryConflict,
        voided: decision.voided,
        // Rang transversal du jour : c'est cette valeur, et non la probabilité
        // brute, qui se confronte au rendement réalisé pour mesurer le Rank IC.
        rank: rankInfo?.rank ?? null,
        rankTotal: rankInfo?.total ?? null,
        rankFractional: rankInfo?.fractional ?? null,
        selected: selected.has(symbol),
      });

      const f = decision.forecast;
      log.info(
        `${symbol} → ${decision.action}`
        + (f ? ` (prévision ${Math.round(f.pUp * 100)}/${Math.round(f.pDown * 100)}/${Math.round(f.pFlat * 100)}, écart ${(f.edge * 100).toFixed(0)} pts)` : ' (sans prévision)')
        + ` : ${outcome.executed ? 'EXÉCUTÉ' : outcome.reason}`,
      );
      return outcome;
    } catch (err) {
      log.error(`Échec du traitement de ${symbol} : ${err.message}`);
      outcome.reason = err.message;
      await this.journal.record({
        symbol,
        source: 'engine',
        action: 'HOLD',
        executed: false,
        confidence: 0,
        justification: `Erreur technique pendant l'analyse : ${err.message}`,
        technicalRationale: 'n/d',
        newsSentiment: 'INDISPONIBLE',
        newsRationale: 'n/d',
        riskDecision: 'cycle en erreur',
        error: err.message,
      });
      return outcome;
    }
  }

  /** Exécute un cycle complet sur tout l'univers configuré. */
  async runCycle({ trigger = 'cron' } = {}) {
    if (this.isRunning) {
      log.warn('Cycle déjà en cours — déclenchement ignoré.');
      return { skipped: true, reason: 'cycle déjà en cours' };
    }
    if (this.paused && trigger === 'cron') {
      log.info('Bot en pause — cycle planifié ignoré.');
      return { skipped: true, reason: 'bot en pause' };
    }

    this.isRunning = true;
    const started = Date.now();
    log.info(`── Cycle #${this.cycleCount + 1} (${trigger}) ──`);

    try {
      // Résolution du carnet fantôme AVANT toute nouvelle décision : on ferme
      // le passé dont l'horizon est échu avant d'en produire davantage.
      await shadowBook
        .resolve((symbol) => getMarketSnapshot(symbol).then((s) => s.candles))
        .catch((err) => log.warn(`Résolution du carnet fantôme reportée : ${err.message}`));

      const symbols = [
        ...new Set([
          ...config.universe.symbols,
          ...(await this.broker.getPositions()).map((p) => p.symbol),
          // L'indice de référence sert à neutraliser le bêta de marché dans
          // le scoring : sans lui, on mesurerait la direction du marché, pas
          // la compétence de sélection du modèle.
          BENCHMARK,
        ]),
      ];

      const quotes = await this.#collectQuotes(symbols);
      await this.broker.markToMarket(quotes);

      const accountBefore = await this.broker.getAccount();
      const circuitBreaker = await this.risk.checkCircuitBreaker(accountBefore);

      const exits = await this.#applyProtectiveExits(quotes);

      // ── PHASE 1 : évaluer TOUT l'univers, sans rien exécuter ──────────────
      // Traitement séquentiel : ménage les quotas d'API et garde une
      // valorisation cohérente entre deux décisions du même cycle.
      // Le palier gratuit de Gemini limite les requêtes par minute : sans cette
      // pause, un univers de 3+ actifs déclenche des 429 dès le second symbole.
      const evaluations = [];
      for (const [index, symbol] of config.universe.symbols.entries()) {
        if (index > 0 && config.llm.cooldownMs > 0) await sleep(config.llm.cooldownMs);
        evaluations.push(await this.#evaluateSymbol(symbol, { quotes, circuitBreaker }));
      }

      // ── PHASE 2 : classer, sélectionner, puis exécuter ────────────────────
      // On ne peut pas choisir les meilleurs sans les avoir tous vus. C'est
      // toute la raison d'être de la séparation en deux phases.
      const held = new Set((await this.broker.getPositions()).map((p) => p.symbol));
      const ranking = rankAndSelect(evaluations.filter((e) => e.evaluated), {
        maxSelected: config.risk.maxPositions,
        held,
      });

      const results = [];
      for (const evaluation of evaluations) {
        if (!evaluation.evaluated) {
          results.push(evaluation); // marché fermé ou échec : rien à exécuter
          continue;
        }
        results.push(await this.#executeEvaluation(evaluation, {
          selected: ranking.selected,
          rankInfo: ranking.ranks.get(evaluation.symbol) ?? null,
          rankingReason: ranking.reason,
        }));
      }

      // Récapitulatif des spreads observés : c'est la mesure qui, séance après
      // séance, remplacera les estimations contradictoires par un chiffre réel.
      await spreadLog.logSummary();

      const accountAfter = await this.broker.getAccount();
      const summary = {
        trigger,
        durationMs: Date.now() - started,
        symbolsAnalyzed: results.length,
        protectiveExits: exits,
        decisions: results,
        executed: results.filter((r) => r.executed).length,
        circuitBreaker,
        equity: accountAfter.equity,
        cash: accountAfter.cash,
        equityChange: Number((accountAfter.equity - accountBefore.equity).toFixed(2)),
      };

      this.cycleCount += 1;
      this.lastCycle = summary;
      await this.journal.recordCycle(summary);

      log.info(
        `── Cycle terminé en ${summary.durationMs} ms — ${summary.executed} ordre(s), équity ${accountAfter.equity} ${accountAfter.currency} ──`,
      );
      return summary;
    } catch (err) {
      log.error(`Cycle en échec : ${err.message}`);
      return { error: err.message };
    } finally {
      this.isRunning = false;
    }
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    log.warn(this.paused ? 'Bot mis en PAUSE.' : 'Bot REPRIS.');
    return this.paused;
  }
}
