import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { JsonStore } from '../storage/JsonStore.js';

const log = createLogger('execution');

/**
 * Mesure de la qualité d'exécution : cotation à la soumission vs prix de fill.
 *
 * ── Pourquoi mesurer plutôt que chercher ──────────────────────────────────
 * On aurait pu commander une recherche sur les rapports SEC Rule 605/606
 * d'Alpaca pour savoir vers quels grossistes les ordres sont routés et quelle
 * amélioration de prix moyenne ils obtiennent. Mais ces rapports agrègent tous
 * les clients, et les ordres FRACTIONNAIRES y sont historiquement mal reportés.
 *
 * La mesure directe est meilleure : on compare, sur NOS ordres, la cotation
 * observée à l'instant de la soumission et le prix effectivement obtenu. Vingt
 * lignes de code valent mieux qu'un rapport sur une moyenne qui n'est pas la
 * nôtre.
 *
 * ── Ce qu'on cherche à établir ────────────────────────────────────────────
 * Alpaca annonce exécuter les fractions au NBBO « sans amélioration de prix ».
 * Trois scénarios sont possibles, et ils changent la stratégie :
 *
 *   slippage ≈ 0        → on paie exactement le côté du spread, comme annoncé
 *   slippage < 0        → amélioration de prix : le coût réel est plus faible
 *                         que mesuré, on peut trader plus petit et plus souvent
 *   slippage > 0        → dégradation : le coût dépasse le spread affiché,
 *                         il faut relever le seuil de conviction pour entrer
 *
 * Référence : le prix « attendu » est l'ask à l'achat et le bid à la vente,
 * puisque c'est ce qu'un preneur de liquidité paie par construction.
 *
 * ── La cotation de référence n'est pas toujours utilisable ────────────────
 * On compare un fill routé par Alpaca au NBBO à une cotation venant du flux
 * IEX, qui est une place unique et minoritaire. Sur les titres moins liquides,
 * son ask peut être très au-dessus du marché réel. Cas mesuré en production :
 * AVGO coté bid 418,92 / ask 427,00 — soit 193 bps de spread — pour un fill
 * obtenu à 419,35. Comparé à cet ask fantaisiste, le fill paraissait meilleur
 * de 179 bps, et la moyenne du slippage tombait à −59 bps : le bot semblait
 * acheter systématiquement 0,6 % sous le prix demandé, ce qui n'existe pas.
 *
 * Le biais va dans le sens qui flatte, donc c'est celui qu'il faut traquer. Les
 * échantillons dont le spread affiché dépasse `MAX_REFERENCE_SPREAD_BPS` sont
 * archivés mais exclus de la statistique : la cotation, pas l'exécution, est en
 * cause. La médiane y résistait déjà ; la moyenne non, et elle est publiée.
 */

/**
 * Plafond de plausibilité absolu, jamais négociable.
 *
 * ── Pourquoi il doit rester dominant ──────────────────────────────────────
 * J'ai d'abord cru pouvoir le remplacer par un critère relatif à la médiane de
 * chaque actif. C'était une régression, et les données l'ont montrée aussitôt :
 * la moyenne du slippage est repassée de −1,26 à −39,94 bps, aucun échantillon
 * écarté.
 *
 * La cause tient en une ligne : la médiane de spread MESURÉE sur AVGO via IEX
 * vaut 244,88 bps. Un critère relatif y autorisait 734 bps. Le repère héritait
 * du défaut qu'il devait détecter — quand une source est systématiquement
 * mauvaise sur un titre, sa médiane l'est aussi, et le test relatif devient
 * inoffensif précisément là où il faudrait qu'il morde.
 *
 * Ce plafond, lui, s'appuie sur un fait extérieur aux données : une
 * mégacapitalisation américaine ne cote pas à 190 bps d'écart en séance. Jamais.
 */
const MAX_REFERENCE_SPREAD_BPS = 50;

/**
 * Multiple de la médiane de l'actif au-delà duquel sa cotation est écartée.
 *
 * Un seuil ABSOLU ne suffit pas, et c'est mesuré : un fill MSFT à 497,17 face à
 * un ask IEX de 498,00 donnait une « amélioration de prix » de 16,67 bps —
 * invraisemblable sur un ordre fractionnaire, mais sous le plafond de 50 bps,
 * donc comptée. Résultat affiché : « amélioration de prix sur 50 % des ordres »,
 * un artefact pur.
 *
 * Le bon repère est propre à chaque titre. MSFT cote autour de 2 bps en séance ;
 * un ask à 17 bps y est aberrant, alors que ce serait normal sur une valeur peu
 * traitée. On compare donc chaque cotation à la médiane MESURÉE de son actif —
 * un repère auto-calibré, qui se resserre à mesure que les données s'accumulent.
 */
const MAX_SPREAD_VS_MEDIAN = 3;

class ExecutionQuality {
  constructor() {
    this.store = new JsonStore(config.storage.dir, 'execution-quality.json', {
      fills: [],
    });
    this.loaded = false;
  }

  async init() {
    if (!this.loaded) {
      await this.store.load();
      this.loaded = true;
    }
    return this;
  }

  /**
   * @param {object} sample
   * @param {'BUY'|'SELL'} sample.side
   * @param {object|null} sample.quote  cotation capturée AVANT la soumission
   * @param {number} sample.fillPrice
   */
  async record({ symbol, side, quote, fillPrice, quantity, orderId }) {
    await this.init();
    if (!(fillPrice > 0)) return null;

    // Sans cotation de référence, on archive quand même le fill : il servira
    // à l'historique, simplement pas à la statistique de slippage.
    const hasQuote = quote && quote.bid > 0 && quote.ask > 0;
    const mid = hasQuote ? (quote.bid + quote.ask) / 2 : null;
    const expected = hasQuote ? (side === 'BUY' ? quote.ask : quote.bid) : null;

    // Signe positif = défavorable, quel que soit le sens de l'ordre.
    const vsExpected = expected
      ? ((side === 'BUY' ? fillPrice - expected : expected - fillPrice) / expected) * 10000
      : null;
    const vsMid = mid
      ? ((side === 'BUY' ? fillPrice - mid : mid - fillPrice) / mid) * 10000
      : null;

    const sample = {
      t: new Date().toISOString(),
      symbol,
      side,
      orderId,
      quantity,
      fillPrice: Number(fillPrice.toFixed(4)),
      bid: hasQuote ? quote.bid : null,
      ask: hasQuote ? quote.ask : null,
      mid: mid ? Number(mid.toFixed(4)) : null,
      spreadBps: hasQuote ? Number((((quote.ask - quote.bid) / mid) * 10000).toFixed(2)) : null,
      slippageVsExpectedBps: vsExpected != null ? Number(vsExpected.toFixed(2)) : null,
      slippageVsMidBps: vsMid != null ? Number(vsMid.toFixed(2)) : null,
    };

    // Cotation trop large pour servir de référence : on garde la trace, on
    // écarte de la statistique, et on le dit dans les logs plutôt que de
    // publier une amélioration de prix imaginaire.
    if (sample.spreadBps != null) {
      const median = await medianSpreadFor(symbol);
      sample.symbolMedianBps = median;
      const limit = referenceLimit(median);

      if (sample.spreadBps > limit) {
        sample.referenceUsable = false;
        // Dire LEQUEL des deux critères a mordu : invoquer la médiane alors que
        // c'est le plafond qui a tranché induirait en erreur (sur AVGO, 191 bps
        // ne font que 0,8× une médiane elle-même aberrante).
        const parLePlafond = limit >= MAX_REFERENCE_SPREAD_BPS;
        sample.excludedReason = parLePlafond
          ? `cotation à ${sample.spreadBps} bps : au-delà du plafond de plausibilité de ${MAX_REFERENCE_SPREAD_BPS} bps`
          : `cotation à ${sample.spreadBps} bps, soit ${(sample.spreadBps / median).toFixed(1)}× la médiane mesurée de ${symbol} (${median} bps)`;
        log.warn(
          `${side} ${symbol} : ${sample.excludedReason} — fill archivé mais exclu de la mesure de qualité d'exécution.`,
        );
      } else {
        sample.referenceUsable = true;
      }
    }

    this.store.data.fills.push(sample);
    if (this.store.data.fills.length > 5000) {
      this.store.data.fills.splice(0, this.store.data.fills.length - 5000);
    }
    await this.store.save();

    if (vsExpected != null && sample.referenceUsable !== false) {
      const verdict = vsExpected < -0.5 ? 'amélioration' : vsExpected > 0.5 ? 'dégradation' : 'conforme';
      log.info(
        `${side} ${symbol} @ ${sample.fillPrice} vs ${expected.toFixed(4)} attendu → ` +
          `${vsExpected >= 0 ? '+' : ''}${vsExpected.toFixed(2)} bps (${verdict})`,
      );
    }
    return sample;
  }

  /** Statistiques agrégées : la réponse empirique sur la qualité de routage. */
  async summary() {
    await this.init();
    // Rétrocompatible : les échantillons antérieurs au contrôle n'ont pas le
    // drapeau. On le recalcule à la volée, en réappliquant la règle courante —
    // sinon un durcissement du critère ne s'appliquerait qu'aux fills futurs et
    // les anciens continueraient à polluer la statistique.
    const medians = await allMedians();
    const usable = (f) => {
      if (f.slippageVsExpectedBps == null) return false;
      if (f.referenceUsable === false) return false;
      if (f.spreadBps == null) return true;
      const median = f.symbolMedianBps ?? medians[f.symbol] ?? null;
      const limit = referenceLimit(median);
      return f.spreadBps <= limit;
    };

    const measurable = this.store.data.fills.filter(usable);
    const excluded = this.store.data.fills.filter(
      (f) => f.slippageVsExpectedBps != null && !usable(f),
    );

    if (!measurable.length) {
      return {
        fills: this.store.data.fills.length,
        measurable: 0,
        excluded: excluded.length,
        note: excluded.length
          ? `${excluded.length} fill(s) écarté(s) : cotation de référence trop large pour servir de comparaison.`
          : 'Aucun fill mesurable pour le moment (cotation de référence manquante).',
      };
    }

    const stat = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return {
        n: values.length,
        meanBps: Number(mean.toFixed(2)),
        medianBps: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
        p90Bps: Number(sorted[Math.floor(sorted.length * 0.9)].toFixed(2)),
        worstBps: Number(sorted[sorted.length - 1].toFixed(2)),
      };
    };

    const vsExpected = stat(measurable.map((f) => f.slippageVsExpectedBps));
    const improved = measurable.filter((f) => f.slippageVsExpectedBps < -0.5).length;

    return {
      fills: this.store.data.fills.length,
      measurable: measurable.length,
      excluded: excluded.length,
      excludedNote: excluded.length
        ? `${excluded.length} fill(s) écarté(s) : cotation IEX trop large pour juger l'exécution (spread > ${MAX_REFERENCE_SPREAD_BPS} bps).`
        : null,
      vsExpectedSide: vsExpected,
      vsMid: stat(measurable.map((f) => f.slippageVsMidBps)),
      priceImprovementRate: Number((improved / measurable.length).toFixed(4)),
      bySide: {
        BUY: measurable.filter((f) => f.side === 'BUY').length
          ? stat(measurable.filter((f) => f.side === 'BUY').map((f) => f.slippageVsExpectedBps))
          : null,
        SELL: measurable.filter((f) => f.side === 'SELL').length
          ? stat(measurable.filter((f) => f.side === 'SELL').map((f) => f.slippageVsExpectedBps))
          : null,
      },
      interpretation:
        vsExpected.medianBps < -0.5
          ? 'Amélioration de prix constatée : le coût réel est inférieur au spread affiché.'
          : vsExpected.medianBps > 0.5
            ? 'Dégradation constatée : le coût dépasse le spread affiché, relever le seuil de conviction.'
            : 'Exécution conforme au NBBO annoncé : le coût se limite au côté du spread.',
    };
  }
}


/**
 * Médiane de spread mesurée pour un actif, ou null si pas encore mesurable.
 *
 * L'import est fait à la demande : `spreadLog` et ce module vivent dans le même
 * dossier et se référencent mutuellement, un import statique croisé rendrait
 * l'ordre d'initialisation fragile.
 */
async function medianSpreadFor(symbol) {
  try {
    const { spreadLog } = await import('./spreadLog.js');
    const s = await spreadLog.summary();
    return s.symbols?.[symbol]?.medianBps ?? null;
  } catch {
    return null;
  }
}

/** Toutes les médianes connues, pour réévaluer l'historique d'un seul coup. */
async function allMedians() {
  try {
    const { spreadLog } = await import('./spreadLog.js');
    const s = await spreadLog.summary();
    return Object.fromEntries(Object.entries(s.symbols || {}).map(([k, v]) => [k, v.medianBps]));
  } catch {
    return {};
  }
}

export const executionQuality = new ExecutionQuality();

/**
 * Écart maximal toléré sur une cotation de référence.
 *
 * Les DEUX critères s'appliquent, et on retient le plus strict :
 *   • le plafond absolu attrape les cotations grossièrement fausses, même quand
 *     la source est mauvaise en permanence sur ce titre ;
 *   • le critère relatif attrape les cas modérés qu'un plafond fixe laisse
 *     passer — MSFT à 20 bps quand sa normale est 2.
 *
 * Aucun des deux ne suffit seul : c'est vérifié dans les deux sens sur données
 * réelles.
 */
function referenceLimit(median) {
  if (median == null) return MAX_REFERENCE_SPREAD_BPS;
  // Plancher à 3 bps : sans lui, un titre très liquide (médiane 0,5 bps) verrait
  // exclure des fills normaux sur du simple bruit d'arrondi.
  const relative = Math.max(median * MAX_SPREAD_VS_MEDIAN, 3);
  return Math.min(relative, MAX_REFERENCE_SPREAD_BPS);
}
