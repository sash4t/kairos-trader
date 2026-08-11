// Technical indicators. All operate on numeric closes / candles.

export function ema(values: number[], period: number): number[] {
  if (values.length === 0 || period <= 0) return [];
  const out = Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : NaN);
  }
  return out;
}

export function rsi(closes: number[], period = 14): number[] {
  const out: number[] = [];
  if (closes.length < period + 1) return closes.map(() => NaN);
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gainSum += d; else lossSum -= d;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = 0; i < period; i++) out.push(NaN);
  out.push(100 - 100 / (1 + (avgGain / (avgLoss || 1e-9))));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out.push(100 - 100 / (1 + (avgGain / (avgLoss || 1e-9))));
  }
  return out;
}

/**
 * MACD. The signal EMA is computed only over the defined part of the MACD line
 * (the slow EMA warmup leaves leading NaNs), then re-aligned, so warmup never
 * produces a NaN-poisoned signal or a histogram that looks like momentum.
 */
export function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = closes.map((_, i) => (isFinite(ef[i]) && isFinite(es[i]) ? ef[i] - es[i] : NaN));
  const firstValid = line.findIndex((v) => isFinite(v));
  const sig = Array<number>(line.length).fill(NaN);
  if (firstValid >= 0) {
    const tail = ema(line.slice(firstValid), signal);
    for (let i = 0; i < tail.length; i++) sig[firstValid + i] = tail[i];
  }
  const hist = line.map((v, i) => (isFinite(v) && isFinite(sig[i]) ? v - sig[i] : NaN));
  return { line, signal: sig, hist };
}


export function atr(candles: { h: number; l: number; c: number }[], period = 14): number[] {
  const trs: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { trs.push(candles[i].h - candles[i].l); continue; }
    const p = candles[i - 1];
    const c = candles[i];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const out: number[] = [];
  if (trs.length < period) return trs.map(() => NaN);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let a = sum / period;
  for (let i = 0; i < period - 1; i++) out.push(NaN);
  out.push(a);
  for (let i = period; i < trs.length; i++) {
    a = (a * (period - 1) + trs[i]) / period;
    out.push(a);
  }
  return out;
}

/** Rolling standard deviation around a given mean series (population sigma). */
export function stddev(values: number[], period: number, mean: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1 || !isFinite(mean[i])) { out.push(NaN); continue; }
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (values[j] - mean[i]) ** 2;
    out.push(Math.sqrt(s / period));
  }
  return out;
}

export interface BollingerBands { mid: number[]; upper: number[]; lower: number[]; width: number[] }

/** Bollinger bands: SMA(period) +/- k * stddev(period). */
export function bollinger(values: number[], period = 20, k = 2.5): BollingerBands {
  const mid = sma(values, period);
  const sd = stddev(values, period, mid);
  const upper = mid.map((m, i) => m + k * sd[i]);
  const lower = mid.map((m, i) => m - k * sd[i]);
  const width = mid.map((m, i) => ((upper[i] - lower[i]) / m) * 100);
  return { mid, upper, lower, width };
}

export function last<T>(arr: T[]): T | undefined { return arr[arr.length - 1]; }
