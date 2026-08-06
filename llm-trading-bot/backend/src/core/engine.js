import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { getMarketSnapshot, getPrice, getFxRate, isTradeable } from '../data/marketData.js';
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

  /** Récupère prix + taux de change de tous les actifs suivis ou détenus. */
  async #collectQuotes(symbols) {
    const quotes = {};
    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const snapshot = await getMarketSnapshot(symbol);
          const fxRate = await getFxRate(snapshot.currency);
          quotes[symbol] = { price: snapshot.lastPrice, fxRate, currency: snapshot.currency, snapshot };
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

  /** Analyse un actif et exécute (ou non) la décision du LLM. */
  async #processSymbol(symbol, { quotes, circuitBreaker }) {
    const outcome = { symbol, action: 'HOLD', executed: false, reason: null };

    try {
      const quote = quotes[symbol];
      const snapshot = quote?.snapshot ?? (await getMarketSnapshot(symbol));
      const fxRate = quote?.fxRate ?? (await getFxRate(snapshot.currency));
      const price = snapshot.indicators.price;

      const position = await this.broker.getPosition(symbol);

      if (config.schedule.onlyMarketHours) {
        const tradeable = isTradeable(snapshot);
        if (!tradeable.open) {
          outcome.reason = `analyse ignorée : ${tradeable.reason}`;
          log.info(`${symbol} — ${outcome.reason}`);
          return outcome;
        }
      }

      const account = await this.broker.getAccount();
      const budget = this.risk.computeBudget({ account, position, price, fxRate, circuitBreaker });

      // Rien à faire : ni position à gérer, ni budget pour ouvrir.
      // On évite l'appel LLM (quota, latence) et on le trace explicitement.
      if (!budget.canBuy && !position) {
        outcome.reason = `aucune action possible (${budget.blockReason})`;
        await this.journal.record({
          symbol,
          source: 'engine',
          action: 'HOLD',
          executed: false,
          confidence: 0,
          justification: `Cycle passé sans consulter l'IA : ${budget.blockReason}.`,
          technicalRationale: `RSI ${snapshot.indicators.rsi14}, MACD ${snapshot.indicators.macd.crossover}.`,
          newsSentiment: 'INDISPONIBLE',
          newsRationale: 'Non consultées (aucune action possible).',
          riskDecision: budget.blockReason,
          price,
          indicators: snapshot.indicators,
        });
        return outcome;
      }

      const news = await getNews(symbol);

      const decision = await decide({
        snapshot,
        news,
        account,
        position,
        budget,
        constraints: config.risk,
      });

      outcome.action = decision.action;

      const validation = this.risk.validate({ decision, account, position, price, fxRate, budget });

      let tradeResult = null;
      if (validation.approved && decision.action === 'BUY') {
        tradeResult = await this.broker.buy({
          symbol,
          quantity: validation.quantity,
          price,
          currency: snapshot.currency,
          fxRate,
          meta: { source: 'llm', reason: decision.justification.slice(0, 200), confidence: decision.confidence },
        });
        if (tradeResult.status === 'filled') {
          const levels = this.risk.protectionLevels(tradeResult.trade.price, decision);
          await this.broker.setProtection(symbol, levels);
        }
      } else if (validation.approved && decision.action === 'SELL') {
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
        action: decision.action,
        executed: outcome.executed,
        confidence: decision.confidence,
        sizePct: decision.sizePct,
        justification: decision.justification,
        technicalRationale: decision.technicalRationale,
        newsSentiment: decision.newsSentiment,
        newsRationale: decision.newsRationale,
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

      log.info(
        `${symbol} → ${decision.action} (confiance ${decision.confidence}) : ${outcome.executed ? 'EXÉCUTÉ' : outcome.reason}`,
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
      const symbols = [...new Set([...config.universe.symbols, ...(await this.broker.getPositions()).map((p) => p.symbol)])];

      const quotes = await this.#collectQuotes(symbols);
      await this.broker.markToMarket(quotes);

      const accountBefore = await this.broker.getAccount();
      const circuitBreaker = await this.risk.checkCircuitBreaker(accountBefore);

      const exits = await this.#applyProtectiveExits(quotes);

      const results = [];
      // Traitement séquentiel : ménage les quotas d'API et garde une
      // valorisation cohérente entre deux décisions du même cycle.
      // Le palier gratuit de Gemini limite les requêtes par minute : sans cette
      // pause, un univers de 3+ actifs déclenche des 429 dès le second symbole.
      for (const [index, symbol] of config.universe.symbols.entries()) {
        if (index > 0 && config.llm.cooldownMs > 0) await sleep(config.llm.cooldownMs);
        results.push(await this.#processSymbol(symbol, { quotes, circuitBreaker }));
      }

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
