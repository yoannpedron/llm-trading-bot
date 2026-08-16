import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { getMarketSnapshot, getQuote, isTradeable } from '../data/marketData.js';
import { spreadLog } from '../data/spreadLog.js';
import { calendarPhase } from '../data/calendar.js';
import { filtrerResultats } from '../data/earnings.js';
import { filtrerParSpread, fenetreExecution } from './execution.js';
import { filtrerParVeto } from '../llm/veto.js';
import { shadowBook, BENCHMARK } from './shadowBook.js';
import { rankAndSelect, MIN_DISPERSION } from './ranking.js';
import { classerUnivers, decisionDepuisRang } from './listwiseRanking.js';
import { facteursPour, classerFacteurs, resolutionFacteur, FACTEURS } from './baselines.js';
import { sectorOf } from '../data/universe.js';
import { getNews } from '../news/newsService.js';
import { decide, providerActif } from '../llm/agent.js';

const log = createLogger('engine');


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
    this.progress = null;
    this.lastRanking = null;
  }

  get status() {
    return {
      isRunning: this.isRunning,
      paused: this.paused,
      // ── Progression du cycle en cours ──────────────────────────────────
      // À 150 actifs un cycle dure une vingtaine de minutes. Sans ce compteur,
      // rien ne distingue « ça travaille » de « c'est planté » : le dashboard
      // affichait « Cycle en cours… » pendant vingt minutes sans autre signe
      // de vie. C'est aussi ce qui rend possible le lancement asynchrone —
      // l'appel rend la main tout de suite, la progression se lit ici.
      progress: this.progress,
      cycleCount: this.cycleCount,
      lastCycleAt: this.journal.lastCycleAt,
      lastCycle: this.lastCycle,
      // Dernier classement transversal : c'est la décision réelle du bot
      // depuis le passage au rang, et elle n'était visible nulle part.
      lastRanking: this.lastRanking,
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
  async #evaluateSymbol(symbol, { quotes, circuitBreaker, sansLlm = false }) {
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

      // ── Mode classement : aucun appel au modèle ici ───────────────────────
      // Le modèle n'est plus interrogé actif par actif. Il l'est par LOTS,
      // après cette phase, et il ORDONNE au lieu de noter. La raison tient en
      // un chiffre : mesuré sur l'API, la notation individuelle produisait
      // trois valeurs distinctes sur vingt réponses, soit une cinquantaine
      // d'ex æquo au sommet sur 150 actifs — et le tri les départageait par
      // ordre alphabétique.
      //
      // Cette phase ne fait donc plus que RASSEMBLER le contexte. La décision
      // est injectée ensuite, à partir de la force latente reconstruite.
      if (sansLlm) {
        return {
          ...outcome,
          evaluated: true,
          decision: null,
          snapshot, news, phase, price, fxRate, position, account, budget,
        };
      }

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
  async #executeEvaluation(evaluation, { selected, sorties, rankInfo, rankingReason, baselines }) {
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

      // ── Sortie par classement ──────────────────────────────────────────
      // Symétrique de la règle d'entrée, et c'est tout l'objet du correctif.
      // L'entrée était RELATIVE — être dans les trois meilleurs — quand la
      // sortie restait ABSOLUE : ne vendre qu'un actif devenu franchement
      // mauvais, ce qui correspond à une chute sous la médiane. Trois positions
      // simplement devenues médiocres n'étaient donc jamais vendues, les trois
      // emplacements restaient occupés, et le classement transversal — la
      // raison d'être de toute la refonte — devenait inerte après le premier
      // jour de trading.
      //
      // La condition absolue est CONSERVÉE en plus : un actif qui s'effondre se
      // vend même s'il reste bien classé, parce qu'un bon rang dans un univers
      // qui baisse ne protège de rien.
      if (position?.quantity > 0 && sorties?.has(symbol) && effective.action !== 'SELL') {
        effective.action = 'SELL';
        effective.sizePct = 1;
        outcome.reason = `sortie par classement : rang ${rankInfo?.rank ?? '?'} au-delà du seuil de tolérance`;
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
        // Rangs des facteurs de référence pour CE cycle. Enregistrés avec la
        // décision du modèle pour que les deux soient notés sur exactement les
        // mêmes rendements, à la même échéance — sans quoi la comparaison ne
        // vaudrait rien.
        baselines: baselines?.get(symbol) ?? null,
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
    this.progress = {
      phase: 'résolution du carnet fantôme',
      done: 0,
      total: config.universe.symbols.length,
      symbol: null,
      startedAt: new Date().toISOString(),
      trigger,
    };
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
      //
      // La pause ne suit QUE les symboles ayant réellement consommé un appel.
      // Elle existe pour respecter la limite par minute de l'API : quand un
      // symbole est écarté sans consulter le modèle — marché fermé, actif non
      // négociable — il n'y a aucun débit à ménager. Attendre quand même
      // faisait durer 12 minutes un cycle de week-end qui ne décide de rien, à
      // raison de 5 secondes par actif ignoré sur 150.
      // Rassemblement du contexte — aucun appel au modèle, donc aucun délai à
      // respecter entre deux actifs. La boucle qui prenait douze minutes en
      // interrogeant le modèle cent cinquante fois en prend quelques secondes.
      const evaluations = [];
      for (const symbol of config.universe.symbols) {
        this.progress = { ...this.progress, phase: 'analyse', symbol, done: evaluations.length };
        evaluations.push(await this.#evaluateSymbol(symbol, { quotes, circuitBreaker, sansLlm: true }));
      }

      // ── LE MODÈLE ENTRE EN JEU ICI, ET IL ORDONNE ────────────────────────
      // Quatre tours de lots de dix, re-tirés au hasard. Soixante appels au
      // lieu de cent cinquante, et un ordre au lieu de notes agglutinées.
      this.progress = { ...this.progress, phase: 'classement', symbol: null, done: evaluations.length };

      const exploitables = evaluations.filter((e) => e.evaluated);
      const donnees = new Map(exploitables.map((e) => [e.symbol, { snapshot: e.snapshot, news: e.news }]));

      const listwise = await classerUnivers(donnees, {
        provider: providerActif(),
        onProgress: (p) => {
          this.progress = { ...this.progress, phase: 'classement', lot: p.lot, totalLots: p.total };
        },
      });

      // Report des décisions synthétisées sur les évaluations existantes.
      const parSymbole = new Map(listwise.evaluations.map((e) => [e.symbol, e.decision]));
      for (const e of exploitables) {
        e.decision = parSymbole.get(e.symbol) ?? decisionDepuisRang(null);
        if (!parSymbole.has(e.symbol)) e.evaluated = false;
      }

      // ── CLASSEMENTS DE RÉFÉRENCE, CALCULÉS PAR FORMULE ────────────────────
      // Le bot mesurait si l'IA bat le HASARD. Il ne mesurait jamais si elle bat
      // une FORMULE — la seule question qui décide si consulter un modèle de
      // langage apporte quoi que ce soit.
      //
      // Les facteurs sont calculés sur EXACTEMENT le même instantané de marché
      // que celui envoyé au modèle. Les deux classements voient donc la même
      // information ; la seule différence est que le modèle voit en plus les
      // actualités. C'est la condition pour que la comparaison soit honnête.
      //
      // Coût : nul. Les bougies sont déjà en mémoire, aucun appel réseau.
      const lignesFacteurs = evaluations
        .filter((e) => e.evaluated && e.snapshot)
        .map((e) => ({
          symbol: e.symbol,
          facteurs: facteursPour({ candles: e.snapshot.candles, indicators: e.snapshot.indicators }),
        }));
      const rangsFacteurs = classerFacteurs(lignesFacteurs);

      // ── PHASE 2 : classer, sélectionner, puis exécuter ────────────────────
      // On ne peut pas choisir les meilleurs sans les avoir tous vus. C'est
      // toute la raison d'être de la séparation en deux phases.
      const positionsOuvertes = await this.broker.getPositions();
      const held = new Set(positionsOuvertes.map((p) => p.symbol));

      // ── Écarter les actifs en fenêtre de publication de résultats ─────────
      // Le filtre ne porte que sur l'ACHAT. Une position déjà ouverte n'est pas
      // liquidée parce que ses résultats approchent : la sortie coûterait un
      // aller-retour certain contre un risque incertain, et la durée minimale
      // de détention existe précisément pour ne pas céder à ce réflexe.
      const { exclus: exclusResultats, calendrierDisponible } = await filtrerResultats(
        evaluations.filter((e) => e.evaluated).map((e) => e.symbol),
      );

      const eligibles = evaluations
        .filter((e) => e.evaluated)
        // On garde les actifs détenus dans le classement même exclus à l'achat :
        // les retirer les priverait de rang, et un actif sans rang n'est jamais
        // vendu — la fenêtre de résultats gèlerait la position au lieu de la
        // protéger.
        .filter((e) => !exclusResultats.has(e.symbol) || held.has(e.symbol));

      const ranking = rankAndSelect(eligibles, {
        maxSelected: config.risk.maxPositions,
        held,
        ageMinimum: config.risk.minHoldingDays,
        positions: positionsOuvertes,
        maxParSecteur: config.risk.maxPerSector,
        // La garde de dispersion est remplacée par un vrai test : le rapport
        // de vraisemblance du classement contre « le modèle ne différencie
        // rien », calibré par bootstrap sur la structure réelle des lots.
        abstention: config.ranking.exigerSignificativite && listwise.test
          ? {
            abstenir: !listwise.test.significatif,
            raison: `le classement n'est pas distinguable du hasard (p = ${listwise.test.p?.toFixed(3)}, `
              + `${listwise.diagnostics.reussis} lots exploités)`,
          }
          : null,
      });

      // Un actif exclu pour cause de résultats ne peut pas être acheté, même
      // s'il sort premier du classement.
      for (const symbol of exclusResultats.keys()) ranking.selected.delete(symbol);

      // ── Trois filtres d'exécution, appliqués aux seules OUVERTURES ────────
      // Aucun ne cherche de signal : ils réduisent une friction payée à coup
      // sûr. C'est le seul rendement du bot qui ne dépende d'aucune prévision.
      //
      // Les sorties ne passent par aucun d'eux. Retarder une vente pour
      // économiser deux points de base inverserait les priorités.
      const filtresExecution = { spread: null, fenetre: null, veto: null };
      const ouvertures = [...ranking.selected].filter((s) => !held.has(s));

      if (ouvertures.length) {
        // 1. Le spread. Un titre à 12 bps coûte 24 bps l'aller-retour, quatre
        //    fois notre coût mesuré — aucun signal ne le justifie quand 149
        //    autres candidats attendent.
        const spreads = new Map(ouvertures.map((s) => [s, quotes[s]?.spreadBps]));
        const { ecartes } = filtrerParSpread(ouvertures, spreads, config.risk);
        for (const symbol of ecartes.keys()) ranking.selected.delete(symbol);
        filtresExecution.spread = [...ecartes.entries()].map(([symbol, r]) => ({
          symbol, spreadBps: r.spreadBps, raison: r.raison,
        }));

        // 2. L'heure. Hors de la fenêtre de milieu de séance, on n'ouvre pas —
        //    on détient 21 séances, rien n'oblige à entrer ce matin.
        const fenetre = fenetreExecution(new Date(), config.risk);
        filtresExecution.fenetre = fenetre;
        if (!fenetre.ouverte) {
          const reportees = [...ranking.selected].filter((s) => !held.has(s));
          for (const symbol of reportees) ranking.selected.delete(symbol);
          if (reportees.length) {
            log.info(
              `${reportees.length} ouverture(s) reportée(s) : ${fenetre.raison} `
              + `(il est ${fenetre.heureET} à New York, fenêtre ${fenetre.fenetre}).`,
            );
          }
        }

        // 3. Le veto. Dernier maillon, et le seul qui consulte le modèle une
        //    seconde fois — sur une dizaine de candidats, pas cent cinquante.
        const restants = [...ranking.selected].filter((s) => !held.has(s));
        if (restants.length && config.risk.vetoActif) {
          const { refuses } = await filtrerParVeto(restants, {
            provider: providerActif(),
            newsPour: (symbol) => getNews(symbol),
          });
          for (const symbol of refuses.keys()) ranking.selected.delete(symbol);
          filtresExecution.veto = [...refuses.entries()].map(([symbol, r]) => ({
            symbol, motif: r.motif, gravite: r.gravite, constat: r.constat, erreur: r.erreur ?? null,
          }));
        }
      }

      // ── Le classement, conservé pour affichage ────────────────────────────
      // C'est la décision réelle du bot depuis le passage au rang, et elle
      // n'apparaissait nulle part : le dashboard montrait des HOLD sans dire
      // que l'actif avait été correctement noté puis écarté par le classement.
      // On garde l'ordre complet — pas seulement les retenus — parce que
      // l'intérêt est justement de voir QUI a été battu par QUI.
      this.lastRanking = {
        at: new Date().toISOString(),
        dispersion: ranking.dispersion ?? null,
        seuilDispersion: MIN_DISPERSION,
        mediane: ranking.median ?? null,
        // Renseigné quand aucune sélection n'a eu lieu : dispersion trop faible,
        // ou moins de deux prévisions exploitables. Sans ça, un cycle sans achat
        // et un cycle bloqué se ressemblent à l'écran.
        raisonAbstention: ranking.reason ?? null,
        maxRetenus: config.risk.maxPositions,
        seuilSortie: ranking.seuilSortie ?? null,
        sorties: [...(ranking.sorties ?? [])],
        // Une abstention doit toujours pouvoir s'expliquer. Sans ce détail, un
        // actif bien classé mais jamais acheté ressemble à un bug.
        dureeMinimale: config.risk.minHoldingDays,
        maxParSecteur: config.risk.maxPerSector,
        // Chaque filtre d'exécution consigne ce qu'il a écarté et pourquoi. Une
        // ouverture qui n'a pas eu lieu doit être explicable ; sinon un bon
        // classement suivi d'aucun achat ressemble à une panne.
        filtresExecution,
        // ── Diagnostic du classement par comparaison ──────────────────────
        // `valeursDistinctes` est le chiffre à surveiller : c'est celui qui
        // valait 3 sur 150 avec la notation individuelle. S'il retombe, tout
        // le reste est décoratif.
        listwise: {
          test: listwise.test,
          lots: listwise.diagnostics.lots,
          reussis: listwise.diagnostics.reussis,
          appels: listwise.diagnostics.appelsConsommes,
          valeursDistinctes: listwise.diagnostics.valeursDistinctes,
          partAveugle: listwise.diagnostics.partAveugle,
          connexe: listwise.diagnostics.connexe,
          biaisDePosition: listwise.diagnostics.biaisDePosition,
          wald: listwise.diagnostics.wald,
        },
        resultats: {
          calendrierDisponible,
          exclus: [...exclusResultats.entries()].map(([symbol, r]) => ({
            symbol, date: r.date ?? null, raison: r.raison,
          })),
        },
        // Résolution comparée : combien de valeurs DISTINCTES chaque classement
        // produit-il ? Observé en production, le modèle n'en donnait que trois
        // sur vingt réponses. Un facteur numérique en donne autant qu'il y a
        // d'actifs. Sans résolution, aucun classement n'est exploitable, et
        // aucune règle de sortie n'y remédie.
        resolution: {
          modele: (() => {
            const e = [...ranking.ranks.values()].map((r) => r.edge).filter(Number.isFinite);
            return e.length
              ? { n: e.length, distinctes: new Set(e.map((x) => x.toFixed(6))).size }
              : null;
          })(),
          facteurs: Object.fromEntries(
            Object.keys(FACTEURS).map((nom) => [nom, resolutionFacteur(lignesFacteurs, nom)]),
          ),
        },
        classement: [...ranking.ranks.entries()]
          .map(([symbol, r]) => ({
            symbol,
            rang: r.rank,
            total: r.total,
            rangFractionnaire: r.fractional,
            ecart: r.edge,
            retenu: ranking.selected.has(symbol),
            detenu: held.has(symbol),
            secteur: sectorOf(symbol),
          }))
          .sort((a, b) => a.rang - b.rang),
      };

      const results = [];
      for (const evaluation of evaluations) {
        if (!evaluation.evaluated) {
          results.push(evaluation); // marché fermé ou échec : rien à exécuter
          continue;
        }
        results.push(await this.#executeEvaluation(evaluation, {
          selected: ranking.selected,
          sorties: ranking.sorties,
          baselines: rangsFacteurs,
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
      this.progress = null;
    }
  }

  /**
   * Lance un cycle sans attendre sa fin.
   *
   * ── Pourquoi ce n'est pas un confort ──────────────────────────────────────
   * `POST /api/cycle` attendait la fin du cycle pour répondre. Avec dix actifs
   * la requête durait une minute et personne ne s'en apercevait. À 150 actifs
   * en séance elle dure une vingtaine de minutes : le navigateur, ou tout
   * intermédiaire entre lui et le serveur, coupe bien avant. Le dashboard
   * affichait « le cycle a échoué » pendant que le cycle se déroulait
   * normalement — le pire des messages, puisqu'il pousse à relancer.
   *
   * L'appel rend donc la main immédiatement et la progression se lit dans
   * `status.progress`. L'erreur éventuelle n'est pas perdue pour autant : elle
   * est journalisée et se retrouve dans `lastCycle`.
   */
  startCycle({ trigger = 'manual' } = {}) {
    if (this.isRunning) return { started: false, reason: 'cycle déjà en cours' };
    if (this.paused && trigger === 'cron') return { started: false, reason: 'bot en pause' };

    // Volontairement sans `await` : on veut la réponse HTTP tout de suite.
    // Le `catch` est indispensable — sans lui, une erreur deviendrait un rejet
    // non géré, et le processus n'a plus personne pour la rattraper.
    this.runCycle({ trigger }).catch((err) => {
      log.error(`Cycle ${trigger} en échec : ${err.message}`);
    });

    return {
      started: true,
      trigger,
      total: config.universe.symbols.length,
      startedAt: new Date().toISOString(),
    };
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    log.warn(this.paused ? 'Bot mis en PAUSE.' : 'Bot REPRIS.');
    return this.paused;
  }
}
