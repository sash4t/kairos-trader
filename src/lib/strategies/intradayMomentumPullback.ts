/**
 * Intraday Momentum Pullback strategy.
 * Timeframe stack: 4H (regime guard) → 1H (trend direction) → 15m (entries).
 */
import { atr, ema, last, macd, rsi } from "../indicators";
import type { Bar } from "../strategy";

export const INTRADAY_PULLBACK_KEY = "intraday-momentum-pullback" as const;

export const INTRADAY_DEFAULTS = {
  riskPct: 0.4,
  positionSizePct: 6,
  atrStopBuffer: 0.35,
  maxExtensionAtr: 1.25,
  minAtrPct: 0.18,
  maxAtrPct: 4.5,
  minVolumeRatio: 0.8,
  takeProfitR: 2.2,
  trailAtR: 1.5,
  trailDistanceR: 0.75,
  pullbackZoneAtr: 0.35,
} as const;

export interface IntradayPullbackSignal {
  coin: string;
  side: "long" | "short" | null;
  confidence: number;
  reasons: string[];
  price: number;
  stopLoss?: number;
  atrValue: number;
  indicators: Record<string, number>;
}

function average(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function trendBias(bars: Bar[]): "long" | "short" | null {
  if (bars.length < 60) return null;
  const closes = bars.map((b) => b.c);
  const e20 = last(ema(closes, 20));
  const e50 = last(ema(closes, 50));
  if (!Number.isFinite(e20) || !Number.isFinite(e50)) return null;
  const price = closes.at(-1)!;
  if (price > e20! && e20! > e50!) return "long";
  if (price < e20! && e20! < e50!) return "short";
  return null;
}

export function evaluateIntradayPullback(
  coin: string,
  fourHour: Bar[],
  hourly: Bar[],
  fifteen: Bar[],
): IntradayPullbackSignal {
  const price = fifteen.at(-1)?.c ?? 0;
  const base: IntradayPullbackSignal = { coin, side: null, confidence: 0, reasons: [], price, atrValue: 0, indicators: {} };
  if (fourHour.length < 60 || hourly.length < 60 || fifteen.length < 80) {
    return { ...base, reasons: ["Waiting for 4H → 1H → 15m history"] };
  }

  const fourBias = trendBias(fourHour);
  const hourBias = trendBias(hourly);
  if (!hourBias) return { ...base, reasons: ["1H trend direction is neutral"] };
  if (fourBias && fourBias !== hourBias) {
    return { ...base, reasons: [`4H trend (${fourBias}) opposes 1H trend (${hourBias})`] };
  }

  const closes = fifteen.map((b) => b.c);
  const vols = fifteen.map((b) => b.v);
  const e20 = last(ema(closes, 20)) ?? NaN;
  const e50 = last(ema(closes, 50)) ?? NaN;
  const atrValue = last(atr(fifteen, 14)) ?? 0;
  const atrPct = price > 0 ? (atrValue / price) * 100 : 0;
  const rsiValue = last(rsi(closes, 14)) ?? NaN;
  const histArr = macd(closes).hist;
  const macd0 = histArr.at(-1) ?? NaN;
  const macd1 = histArr.at(-2) ?? NaN;
  const avgVol = average(vols.slice(-21, -1));
  const volumeRatio = avgVol > 0 ? (vols.at(-1) ?? 0) / avgVol : 0;

  const candle = fifteen.at(-1)!;
  const previous = fifteen.at(-2)!;
  const distanceAtr = atrValue > 0 ? Math.abs(price - e20) / atrValue : Infinity;
  const zone = atrValue * INTRADAY_DEFAULTS.pullbackZoneAtr;

  const indicators = {
    fourHourBias: fourBias === "long" ? 1 : fourBias === "short" ? -1 : 0,
    hourlyBias: hourBias === "long" ? 1 : -1,
    ema20: e20,
    ema50: e50,
    atrPct,
    rsi: rsiValue,
    macdHist: macd0,
    volumeRatio,
    distanceAtr,
    pullbackZoneAtr: INTRADAY_DEFAULTS.pullbackZoneAtr,
  };

  if (!(atrPct >= INTRADAY_DEFAULTS.minAtrPct && atrPct <= INTRADAY_DEFAULTS.maxAtrPct)) {
    return { ...base, atrValue, indicators, reasons: [`15m ATR ${atrPct.toFixed(2)}% outside intraday volatility band`] };
  }
  if (distanceAtr > INTRADAY_DEFAULTS.maxExtensionAtr) {
    return { ...base, atrValue, indicators, reasons: [`Price ${distanceAtr.toFixed(2)} ATR from EMA20; avoiding chase`] };
  }

  const longDirect = hourBias === "long"
    && e20 > e50
    && candle.l <= e20 + zone
    && candle.c > e20
    && candle.c > candle.o
    && candle.c > previous.c;
  const shortDirect = hourBias === "short"
    && e20 < e50
    && candle.h >= e20 - zone
    && candle.c < e20
    && candle.c < candle.o
    && candle.c < previous.c;

  // A second valid entry pattern: the prior bar touched/pierced EMA20 and the
  // current bar reclaims it. This catches common two-candle crypto pullbacks.
  const longReclaim = hourBias === "long"
    && e20 > e50
    && previous.l <= e20 + zone
    && candle.c > e20
    && candle.c > candle.o
    && candle.c > previous.c;
  const shortReclaim = hourBias === "short"
    && e20 < e50
    && previous.h >= e20 - zone
    && candle.c < e20
    && candle.c < candle.o
    && candle.c < previous.c;

  const side = longDirect || longReclaim ? "long" : shortDirect || shortReclaim ? "short" : null;
  if (!side) return { ...base, atrValue, indicators, reasons: ["No confirmed 15m EMA20 pullback or reclaim"] };

  const recent = fifteen.slice(-9, -1);
  const structure = side === "long" ? Math.min(...recent.map((b) => b.l)) : Math.max(...recent.map((b) => b.h));
  const stopLoss = side === "long"
    ? structure - atrValue * INTRADAY_DEFAULTS.atrStopBuffer
    : structure + atrValue * INTRADAY_DEFAULTS.atrStopBuffer;
  if (!(stopLoss > 0) || (side === "long" ? stopLoss >= price : stopLoss <= price)) {
    return { ...base, atrValue, indicators, reasons: ["Could not build valid structural ATR stop"] };
  }

  const reasons = [
    fourBias === side ? "4H trend agrees" : "4H regime neutral (not opposing)",
    "1H trend establishes direction",
    longDirect || shortDirect ? "15m EMA20 rejection confirmed" : "15m EMA20 reclaim confirmed",
  ];
  let confidence = 68;
  if (fourBias === side) confidence += 4;

  const rsiOk = side === "long" ? rsiValue >= 45 && rsiValue <= 73 : rsiValue >= 27 && rsiValue <= 55;
  if (rsiOk) { confidence += 6; reasons.push("RSI supports momentum without overextension"); }
  else if (Number.isFinite(rsiValue)) reasons.push(`RSI ${rsiValue.toFixed(1)} outside ideal band (not blocking)`);

  const macdOk = side === "long" ? macd0 >= macd1 : macd0 <= macd1;
  if (macdOk) { confidence += 6; reasons.push("MACD momentum is improving"); }

  if (volumeRatio >= INTRADAY_DEFAULTS.minVolumeRatio) {
    confidence += 5;
    reasons.push(`Volume ${volumeRatio.toFixed(2)}x 20-bar average`);
  } else {
    reasons.push(`Volume ${volumeRatio.toFixed(2)}x average (low but not blocking)`);
    confidence -= 3;
  }
  if (distanceAtr <= 0.55) confidence += 5;

  return { coin, side, confidence: Math.min(92, confidence), reasons, price, stopLoss, atrValue, indicators };
}

export function riskSizedQuantity(equity: number, riskPct: number, entry: number, stop: number): number {
  const riskUsd = equity * (riskPct / 100);
  const distance = Math.abs(entry - stop);
  return riskUsd > 0 && distance > 0 ? riskUsd / distance : 0;
}

export function targetFromR(side: "long" | "short", entry: number, stop: number, r: number = INTRADAY_DEFAULTS.takeProfitR): number {
  const risk = Math.abs(entry - stop);
  return side === "long" ? entry + risk * r : entry - risk * r;
}

export function intradayRTrail(
  side: "long" | "short",
  entry: number,
  initialStop: number,
  bestPrice: number,
  currentStop: number,
): number {
  const r = Math.abs(entry - initialStop);
  if (!(r > 0) || !(bestPrice > 0)) return currentStop;
  const favorableR = side === "long" ? (bestPrice - entry) / r : (entry - bestPrice) / r;
  let candidate = currentStop;
  if (favorableR >= 1.0) {
    const be = side === "long" ? entry + r * 0.05 : entry - r * 0.05;
    candidate = side === "long" ? Math.max(candidate, be) : Math.min(candidate, be);
  }
  if (favorableR >= INTRADAY_DEFAULTS.trailAtR) {
    const trailed = side === "long"
      ? bestPrice - r * INTRADAY_DEFAULTS.trailDistanceR
      : bestPrice + r * INTRADAY_DEFAULTS.trailDistanceR;
    candidate = side === "long" ? Math.max(candidate, trailed) : Math.min(candidate, trailed);
  }
  return candidate;
}
