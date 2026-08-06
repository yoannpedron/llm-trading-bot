import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { JsonStore } from '../storage/JsonStore.js';

const log = createLogger('spread');

/**
 * Journal des spreads observés — la réponse empirique à « combien coûte
 * vraiment un aller-retour ? ».
 *
 * Chez Alpaca, sur une fraction d'action, le coût se décompose ainsi :
 *   - commission                      : 0
 *   - frais réglementaires (à la vente): SEC ~20,60 $/M + FINRA TAF
 *                                        0,000119 $/action ≈ 0,03 bps
 *   - spread NBBO                     : payé UNE fois par aller-retour
 *                                        (achat à l'ask, vente au bid)
 *
 * Le spread est donc le seul coût qui compte, et c'est une variable, pas une
 * constante. Ce module l'échantillonne à chaque cycle pour qu'on puisse, après
 * quelques séances, remplacer les estimations contradictoires des rapports
 * (5 bps contre 40 bps) par une distribution mesurée sur nos propres actifs.
 *
 * Attention à la lecture : le flux gratuit `iex` ne voit que 2-3 % du volume,
 * donc ses spreads sont plus larges que le NBBO d'exécution réel. Les chiffres
 * ci-dessous sont un MAJORANT du coût, pas une mesure exacte.
 */

/** Frais réglementaires Alpaca, appliqués à la vente uniquement. */
const SEC_FEE_PER_DOLLAR = 20.6 / 1_000_000;
const FINRA_TAF_PER_SHARE = 0.000119;
const FINRA_TAF_CAP = 5.95;

/**
 * Coût total d'un aller-retour, en dollars puis en points de base.
 * @param {number} notional  montant engagé en dollars
 * @param {number} quantity  nombre d'actions (fractions incluses)
 * @param {number} spreadBps spread constaté au moment de l'entrée
 */
export function roundTripCost({ notional, quantity, spreadBps }) {
  // Le spread n'est payé qu'une fois sur l'aller-retour : on achète à l'ask
  // et on revend au bid, soit un écart total d'un spread plein.
  const spreadCost = notional * (spreadBps / 10000);
  const secFee = notional * SEC_FEE_PER_DOLLAR;
  const tafFee = Math.min(quantity * FINRA_TAF_PER_SHARE, FINRA_TAF_CAP);

  const total = spreadCost + secFee + tafFee;
  return {
    spreadCost: Number(spreadCost.toFixed(6)),
    regulatoryFees: Number((secFee + tafFee).toFixed(6)),
    total: Number(total.toFixed(6)),
    totalBps: Number(((total / notional) * 10000).toFixed(2)),
    // Mouvement minimum requis pour simplement rentrer dans ses frais.
    breakEvenPct: Number(((total / notional) * 100).toFixed(4)),
  };
}

class SpreadLog {
  constructor() {
    this.store = new JsonStore(config.storage.dir, 'spreads.json', {
      samples: [],
      bySymbol: {},
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
   * Enregistre une observation. `marketOpen` est déterminant : hors séance,
   * les cotations sont des fantômes overnight (on a mesuré 1010 bps sur TSLA
   * à 23h22 ET) et pollueraient totalement les statistiques.
   */
  async record({ symbol, bid, ask, spreadBps, price, marketOpen }) {
    await this.init();
    if (!Number.isFinite(spreadBps) || spreadBps <= 0) return null;

    const sample = {
      t: new Date().toISOString(),
      symbol,
      bid,
      ask,
      price: Number(price.toFixed(4)),
      spreadBps: Number(spreadBps.toFixed(2)),
      marketOpen: Boolean(marketOpen),
      feed: config.universe.feed,
    };

    this.store.data.samples.push(sample);
    if (this.store.data.samples.length > 20000) {
      this.store.data.samples.splice(0, this.store.data.samples.length - 20000);
    }

    // Seules les observations en séance alimentent les statistiques.
    if (marketOpen) {
      const stats = this.store.data.bySymbol[symbol] || { n: 0, sum: 0, min: Infinity, max: 0, values: [] };
      stats.n += 1;
      stats.sum += sample.spreadBps;
      stats.min = Math.min(stats.min, sample.spreadBps);
      stats.max = Math.max(stats.max, sample.spreadBps);
      stats.values.push(sample.spreadBps);
      if (stats.values.length > 500) stats.values.shift();
      this.store.data.bySymbol[symbol] = stats;
    }

    await this.store.save();
    return sample;
  }

  /** Statistiques par symbole, calculées sur les seules mesures en séance. */
  async summary() {
    await this.init();
    const out = {};

    for (const [symbol, s] of Object.entries(this.store.data.bySymbol)) {
      if (!s.n) continue;
      const sorted = [...s.values].sort((a, b) => a - b);
      const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
      const mean = s.sum / s.n;

      // Coût d'un aller-retour sur une position type, au spread médian.
      const notional = config.risk.initialCapital * config.risk.maxPositionPct;
      const cost = roundTripCost({ notional, quantity: notional / 200, spreadBps: pct(50) });

      out[symbol] = {
        samples: s.n,
        meanBps: Number(mean.toFixed(2)),
        medianBps: Number(pct(50).toFixed(2)),
        p90Bps: Number(pct(90).toFixed(2)),
        minBps: Number(s.min.toFixed(2)),
        maxBps: Number(s.max.toFixed(2)),
        roundTripOnTypicalPosition: cost,
      };
    }

    // ── Écarter les actifs dont le flux est inexploitable ──────────────────
    // Mesuré sur le flux IEX : médiane 244,88 bps sur AVGO, 118 sur META, 63 sur
    // TSLA — pour des mégacapitalisations dont le NBBO réel tient dans 1 à 5 bps.
    // IEX est une place unique à ~2 % de part de marché, et le seul flux du
    // palier gratuit ; ses cotations sont larges ou périmées sur une partie de
    // l'univers.
    //
    // Le mélanger au reste donnait un « spread médian » de 8,88 bps composé pour
    // moitié de valeurs crédibles (2-3 bps) et pour moitié d'aberrations. Le
    // chiffre paraissait raisonnable, ce qui est le pire des cas : rien ne
    // signalait que la mesure était fausse.
    //
    // Ces actifs restent listés — les écarter en silence masquerait l'étendue du
    // problème — mais ils ne participent plus à l'agrégat.
    const PLAUSIBLE_MEDIAN_BPS = 50;
    for (const [symbol, s] of Object.entries(out)) {
      s.feedUsable = s.medianBps <= PLAUSIBLE_MEDIAN_BPS;
      if (!s.feedUsable) {
        s.note = `médiane ${s.medianBps} bps : invraisemblable pour ${symbol}, `
          + `flux ${config.universe.feed} non exploitable sur cet actif`;
      }
    }

    const all = Object.values(out).filter((x) => x.feedUsable);
    const unusable = Object.entries(out).filter(([, x]) => !x.feedUsable).map(([k]) => k);
    const medianOfMedians = all.length
      ? Number([...all.map((x) => x.medianBps)].sort((a, b) => a - b)[Math.floor(all.length / 2)].toFixed(2))
      : null;

    // ── Coût de référence au niveau du PORTEFEUILLE ────────────────────────
    // Le dashboard prenait `Object.values(symbols)[0]` — le premier actif venu,
    // au gré de l'ordre des clés — et l'affichait comme le coût général. D'où un
    // « coût aller-retour » passé de 26,64 à 2,46 bps en une matinée sans que le
    // marché ait bougé, et un seuil de rentabilité qui laissait croire que
    // trader était quasi gratuit alors que le spread médian vaut 11 bps.
    //
    // Le chiffre représentatif est calculé ici une fois, sur la médiane des
    // médianes, et non choisi au hasard côté affichage.
    const typicalNotional = config.risk.initialCapital * config.risk.maxPositionPct;
    const portfolioRoundTrip = medianOfMedians != null
      ? roundTripCost({
        notional: typicalNotional,
        quantity: typicalNotional / 200,
        spreadBps: medianOfMedians,
      })
      : null;

    return {
      feed: config.universe.feed,
      symbols: out,
      overall: all.length
        ? {
            symbolsMeasured: all.length,
            symbolsExcluded: unusable.length,
            excludedSymbols: unusable,
            totalSamples: all.reduce((s, x) => s + x.samples, 0),
            medianOfMedians,
            roundTrip: portfolioRoundTrip,
          }
        : null,
      note:
        `Mesures sur le flux ${config.universe.feed}. Alpaca exécute au NBBO consolidé, `
        + 'plus serré : ces chiffres sont un majorant du coût réel.'
        + (unusable.length
          ? ` ${unusable.length} actif(s) écarté(s) faute de cotations plausibles sur ce flux : ${unusable.join(', ')}.`
          : ''),
    };
  }

  /** Trace un récapitulatif dans les logs, une fois par cycle. */
  async logSummary() {
    const s = await this.summary();
    if (!s.overall) return;
    log.info(
      `Spread médian sur ${s.overall.symbolsMeasured} actifs : ${s.overall.medianOfMedians} bps ` +
        `(${s.overall.totalSamples} mesures en séance, flux ${s.feed})`,
    );
  }
}

export const spreadLog = new SpreadLog();
