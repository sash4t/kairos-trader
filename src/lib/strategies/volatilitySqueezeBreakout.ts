import { atr, bollinger, ema, last, rsi } from "../indicators";
import type { Bar } from "../strategy";

export const VOLATILITY_SQUEEZE_BREAKOUT_KEY = "volatility-squeeze-breakout" as const;

export const SQUEEZE_DEFAULTS = {
  scanLimit: 70,
  scanEveryMs: 5 * 60 * 1000,
  bbPeriod: 20,
  bbMult: 2,
  kcPeriod: 20,
  kcMult: 1.5,
  breakoutLookback: 6,
  squeezeLookbackBars: 2,
  minVolumeRatio: 1.3,
  riskPct: 1.5,
  stopPct: 0.45,
  targetPct: 1.0,
  breakevenAtPct: 0.4,
  partialAtPct: 1.0,
  partialFraction: 0.5,
  trailPct: 0.5,
  staleMovePct: 0.3,
  staleMinutes: 20,
  maxMinutes: 120,
  minConfidence: 70,
} as const;

type Side = "long" | "short";

export interface SqueezeSignal {
  coin: string;
  side: Side | null;
  confidence: number;
  reasons: string[];
  price: number;
  stopLoss?: number;
  takeProfit?: number;
  indicators: Record<string, number>;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function kcSeries(bars: Bar[], period: number, mult: number) {
  const closes = bars.map((b) => b.c);
  const mid = ema(closes, period);
  const a = atr(bars, period);
  return { mid, upper: mid.map((m, i) => m + a[i] * mult), lower: mid.map((m, i) => m - a[i] * mult) };
}

export function evaluateVolatilitySqueezeBreakout(coin: string, hourly: Bar[], fifteen: Bar[]): SqueezeSignal {
  const price = fifteen.at(-1)?.c ?? 0;
  const empty: SqueezeSignal = { coin, side: null, confidence: 0, reasons: [], price, indicators: {} };
  if (hourly.length < 60 || fifteen.length < 40) return { ...empty, reasons: ["Waiting for 1H/15m history"] };

  const closes15 = fifteen.map((b) => b.c);
  const vols15 = fifteen.map((b) => b.v);
  const bb = bollinger(closes15, SQUEEZE_DEFAULTS.bbPeriod, SQUEEZE_DEFAULTS.bbMult);
  const kc = kcSeries(fifteen, SQUEEZE_DEFAULTS.kcPeriod, SQUEEZE_DEFAULTS.kcMult);
  const i = fifteen.length - 1;

  const isSqueezedAt = (idx: number) => idx >= 0
    && Number.isFinite(bb.upper[idx]) && Number.isFinite(kc.upper[idx])
    && bb.upper[idx] <= kc.upper[idx]
    && bb.lower[idx] >= kc.lower[idx];
  let squeezeAge = 0;
  for (let age = 1; age <= SQUEEZE_DEFAULTS.squeezeLookbackBars; age++) {
    if (isSqueezedAt(i - age)) { squeezeAge = age; break; }
  }
  const priorSqueezed = squeezeAge > 0;
  const released = Number.isFinite(bb.upper[i]) && Number.isFinite(kc.upper[i])
    && (bb.upper[i] > kc.upper[i] || bb.lower[i] < kc.lower[i]);
  const bbExpanding = Number.isFinite(bb.width[i]) && Number.isFinite(bb.width[i - 1]) && bb.width[i] > bb.width[i - 1];

  const lookback = fifteen.slice(-(SQUEEZE_DEFAULTS.breakoutLookback + 1), -1);
  const recentHigh = Math.max(...lookback.map((b) => b.h));
  const recentLow = Math.min(...lookback.map((b) => b.l));
  const breakoutLong = price > recentHigh;
  const breakoutShort = price < recentLow;

  const avgVol20 = mean(vols15.slice(-21, -1));
  const volumeRatio = avgVol20 > 0 ? (vols15[i] ?? 0) / avgVol20 : 0;

  const closes1h = hourly.map((b) => b.c);
  const hourPrice = hourly.at(-1)!.c;
  const hourEma20 = last(ema(closes1h, 20)) ?? hourPrice;
  const hourRsi = last(rsi(closes1h, 14)) ?? 50;
  const longDirectionOk = hourPrice >= hourEma20 && hourRsi >= 40 && hourRsi <= 70;
  const shortDirectionOk = hourPrice <= hourEma20 && hourRsi >= 30 && hourRsi <= 60;

  const indicators = {
    priorSqueezed: priorSqueezed ? 1 : 0,
    squeezeAge,
    squeezeReleased: released ? 1 : 0,
    bbExpanding: bbExpanding ? 1 : 0,
    bbWidth: bb.width[i],
    bbWidthPrev: bb.width[i - 1],
    kcUpper: kc.upper[i],
    kcLower: kc.lower[i],
    volumeRatio,
    recentHigh,
    recentLow,
    hourlyEma20: hourEma20,
    hourlyRsi: hourRsi,
  };

  if (!priorSqueezed) return { ...empty, indicators, reasons: [`No Bollinger-inside-Keltner squeeze in prior ${SQUEEZE_DEFAULTS.squeezeLookbackBars} completed 15m candles`] };
  if (!released || !bbExpanding) return { ...empty, indicators, reasons: ["Squeeze has not released with expanding Bollinger width"] };
  if (volumeRatio < SQUEEZE_DEFAULTS.minVolumeRatio) return { ...empty, indicators, reasons: [`Breakout volume ${volumeRatio.toFixed(2)}x < ${SQUEEZE_DEFAULTS.minVolumeRatio.toFixed(1)}x minimum`] };

  const side: Side | null = breakoutLong && longDirectionOk ? "long" : breakoutShort && shortDirectionOk ? "short" : null;
  if (!side) {
    if (!breakoutLong && !breakoutShort) return { ...empty, indicators, reasons: [`No close beyond prior ${SQUEEZE_DEFAULTS.breakoutLookback}-candle extreme`] };
    return { ...empty, indicators, reasons: [`1H EMA/RSI filter rejected ${breakoutLong ? "long" : "short"} breakout`] };
  }

  const stopLoss = side === "long" ? price * (1 - SQUEEZE_DEFAULTS.stopPct / 100) : price * (1 + SQUEEZE_DEFAULTS.stopPct / 100);
  const takeProfit = side === "long" ? price * (1 + SQUEEZE_DEFAULTS.targetPct / 100) : price * (1 - SQUEEZE_DEFAULTS.targetPct / 100);

  let confidence = 74;
  const reasons = [
    `15m Bollinger squeeze released (${squeezeAge} bar${squeezeAge === 1 ? "" : "s"} ago)`,
    `15m close broke prior ${SQUEEZE_DEFAULTS.breakoutLookback}-candle ${side === "long" ? "high" : "low"}`,
    `Volume ${volumeRatio.toFixed(2)}x 20-candle average`,
    `1H EMA20 + RSI ${hourRsi.toFixed(1)} support ${side}`,
  ];
  if (squeezeAge === 1) confidence += 2;
  if (volumeRatio >= 2) confidence += 6;
  else if (volumeRatio >= 1.75) confidence += 4;
  else if (volumeRatio >= 1.5) confidence += 2;
  const widthExpansion = bb.width[i - 1] > 0 ? bb.width[i] / bb.width[i - 1] : 1;
  if (widthExpansion >= 1.25) confidence += 5;
  else if (widthExpansion >= 1.1) confidence += 2;

  return {
    coin,
    side,
    confidence: Math.min(95, confidence),
    reasons,
    price,
    stopLoss,
    takeProfit,
    indicators: { ...indicators, widthExpansion },
  };
}

export function squeezeRiskSizedQuantity(equity: number, entry: number, stop: number, riskPct = SQUEEZE_DEFAULTS.riskPct): number {
  const riskUsd = equity * (riskPct / 100);
  const distance = Math.abs(entry - stop);
  return riskUsd > 0 && distance > 0 ? riskUsd / distance : 0;
}

export function favorablePct(side: Side, entry: number, price: number): number {
  return side === "long" ? ((price - entry) / entry) * 100 : ((entry - price) / entry) * 100;
}

export function adverseAbsPct(entry: number, price: number): number {
  return Math.abs((price - entry) / entry) * 100;
}

export function squeezeTrailStop(side: Side, peak: number, currentStop: number): number {
  const candidate = side === "long"
    ? peak * (1 - SQUEEZE_DEFAULTS.trailPct / 100)
    : peak * (1 + SQUEEZE_DEFAULTS.trailPct / 100);
  return side === "long" ? Math.max(currentStop, candidate) : Math.min(currentStop, candidate);
}
