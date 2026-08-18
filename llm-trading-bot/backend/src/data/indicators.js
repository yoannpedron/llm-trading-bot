/**
 * Indicateurs d'analyse technique — implémentations pures, sans dépendance.
 * Chaque fonction reçoit un tableau de nombres (ou de bougies) ordonné du plus
 * ancien au plus récent et retourne un tableau de même longueur, `null` pour les
 * périodes où l'indicateur n'est pas encore défini.
 */

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let acc = 0;
  for (let i = 0; i < period; i += 1) acc += values[i];
  out[period - 1] = acc / period;
  for (let i = period; i < values.length; i += 1) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/**
 * Valeur du RSI à partir des moyennes de gain et de perte.
 *
 *   perte nulle ET gain nul  -> 50, l'actif n'a pas bougé
 *   perte nulle, gain positif -> 100, il n'a fait que monter
 */
function rsiDepuis(avgGain, avgLoss) {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * RSI de Wilder (lissage exponentiel des gains/pertes moyens).
 *
 * ── Le cas « aucun mouvement » ────────────────────────────────────────────
 * Quand la perte moyenne est nulle, le rapport gain/perte diverge et la
 * formule est indéfinie. Le repli était 100 — « surachat maximal » — ce qui
 * est juste quand il n'y a QUE des hausses, et faux quand il n'y a aucun
 * mouvement du tout : une série parfaitement plate donnait RSI = 100.
 *
 * Le RSI alimente le facteur `surventeRsi`, qui vaut (50 − RSI)/50 : un titre
 * immobile aurait donc reçu le score le plus baissier de l'univers, −1, à
 * égalité avec un titre en surachat franc. On distingue donc les deux.
 */
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = rsiDepuis(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    const g = delta > 0 ? delta : 0;
    const l = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = rsiDepuis(avgGain, avgLoss);
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const line = values.map((_, i) => (emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null));

  const defined = line.filter((v) => v != null);
  const signalDefined = ema(defined, signalPeriod);
  const offset = line.length - defined.length;

  const signal = new Array(values.length).fill(null);
  for (let i = 0; i < signalDefined.length; i += 1) signal[i + offset] = signalDefined[i];

  const histogram = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { line, signal, histogram };
}

export function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    const slice = values.slice(i - period + 1, i + 1);
    const mean = mid[i];
    const variance = slice.reduce((acc, v) => acc + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { middle: mid, upper, lower };
}

/** Average True Range — sert au dimensionnement des stops. */
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;

  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });

  let acc = 0;
  for (let i = 1; i <= period; i += 1) acc += trs[i];
  out[period] = acc / period;
  for (let i = period + 1; i < candles.length; i += 1) {
    out[i] = (out[i - 1] * (period - 1) + trs[i]) / period;
  }
  return out;
}

const last = (arr) => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null);
const round = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

/**
 * Calcule le paquet d'indicateurs injecté dans le prompt du LLM.
 * Retourne uniquement les dernières valeurs + quelques dérivées interprétables
 * (tendance, croisements) pour garder le prompt compact et lisible.
 */
export function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume ?? 0);

  const rsi14 = rsi(closes, 14);
  const macdRes = macd(closes);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const sma200 = sma(closes, 200);
  const bb = bollinger(closes, 20, 2);
  const atr14 = atr(candles, 14);
  const volSma20 = sma(volumes, 20);

  const price = last(closes);
  const macdLine = last(macdRes.line);
  const macdSignal = last(macdRes.signal);
  const histNow = last(macdRes.histogram);
  const histPrev = macdRes.histogram.length > 1 ? macdRes.histogram[macdRes.histogram.length - 2] : null;

  const pctChange = (periods) => {
    if (closes.length <= periods) return null;
    const ref = closes[closes.length - 1 - periods];
    return ref ? ((price - ref) / ref) * 100 : null;
  };

  const currentAtr = last(atr14);

  return {
    price: round(price, 4),
    rsi14: round(last(rsi14), 2),
    macd: {
      line: round(macdLine, 4),
      signal: round(macdSignal, 4),
      histogram: round(histNow, 4),
      crossover:
        histNow == null || histPrev == null
          ? 'unknown'
          : histPrev <= 0 && histNow > 0
            ? 'bullish_cross'
            : histPrev >= 0 && histNow < 0
              ? 'bearish_cross'
              : histNow > 0
                ? 'above_signal'
                : 'below_signal',
    },
    ema20: round(last(ema20), 4),
    ema50: round(last(ema50), 4),
    sma200: round(last(sma200), 4),
    trend:
      last(ema20) == null || last(ema50) == null
        ? 'unknown'
        : last(ema20) > last(ema50)
          ? 'haussière'
          : 'baissière',
    bollinger: {
      upper: round(last(bb.upper), 4),
      middle: round(last(bb.middle), 4),
      lower: round(last(bb.lower), 4),
      position:
        last(bb.upper) == null
          ? 'unknown'
          : price >= last(bb.upper)
            ? 'au-dessus de la bande haute (surachat)'
            : price <= last(bb.lower)
              ? 'sous la bande basse (survente)'
              : 'dans les bandes',
    },
    atr14: round(currentAtr, 4),
    atrPct: round(currentAtr && price ? (currentAtr / price) * 100 : null, 2),
    volume: last(volumes),
    volumeVsAvg: round(last(volSma20) ? last(volumes) / last(volSma20) : null, 2),
    change: {
      last1: round(pctChange(1), 2),
      last5: round(pctChange(5), 2),
      last20: round(pctChange(20), 2),
    },
    support: round(Math.min(...closes.slice(-40)), 4),
    resistance: round(Math.max(...closes.slice(-40)), 4),
  };
}
