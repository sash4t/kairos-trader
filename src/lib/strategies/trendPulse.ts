import { atr, bollinger, ema, last, rsi } from "../indicators";
import type { Bar } from "../strategy";

export const TREND_PULSE_KEY = "trend-pulse" as const;
// Read-only compatibility for rows created before Trend-Pulse received its own
// canonical database key. New selections must always store TREND_PULSE_KEY.
export const TREND_PULSE_STORAGE_KEY = "trendline-break" as const;
export function isTrendPulseKey(value: string | null | undefined) {
  return value === TREND_PULSE_KEY || value === TREND_PULSE_STORAGE_KEY;
}
export const TREND_PULSE_DEFAULTS = {
  emaTrendFast: 20, emaTrendSlow: 50, rsiPeriod: 14, oversold: 28, overbought: 72,
  trendAlignedOversold: 30, trendAlignedOverbought: 70, rsiMinReversal: 3, rsiSetupWindowBars: 3,
  bbPeriod: 20, bbMult: 2, kcMult: 1.5, alignedMinVolumeRatio: 1.5, neutralMinVolumeRatio: 1.8, squeezeSetupWindowBars: 10,
  riskPct: 1.5, maxLeverage: 5, stopAtrMult: 1.2, partialFraction: 0.5, partialAtrMult: 1.5,
  trailAtrMult: 1, fullTargetAtrMult: 3.5, maxHoldHours: 8, minConfidence: 75,
  stopLossCooldownMs: 4 * 60 * 60 * 1000, scanLimit: 50, scanEveryMs: 60 * 1000,
} as const;
type Side = "long" | "short";
type Regime = "bull" | "bear" | "neutral";
export interface TrendPulseSignal { coin: string; side: Side | null; confidence: number; price: number; stopLoss?: number; takeProfit?: number; atrValue: number; regime: "bull" | "bear" | "neutral"; reasons: string[]; indicators: Record<string, number>; }
function kcSeries(bars: Bar[], period: number, mult: number) { const mid = ema(bars.map(b => b.c), period); const a = atr(bars, period); return { upper: mid.map((m, i) => m + a[i] * mult), lower: mid.map((m, i) => m - a[i] * mult) }; }
export function trailedExtreme(values: number[], oversold: number = TREND_PULSE_DEFAULTS.oversold, overbought: number = TREND_PULSE_DEFAULTS.overbought) {
  const previous = values.length - 2; let min = Number.POSITIVE_INFINITY; let max = Number.NEGATIVE_INFINITY;
  for (let i = previous; i >= 0; i--) { const v = values[i]; if (!Number.isFinite(v)) break; const outside = v <= oversold || v >= overbought; if (!outside && i !== previous) break; min = Math.min(min, v); max = Math.max(max, v); }
  return { min, max };
}
export function trendPulseThresholds(regime: Regime, side: Side) {
  const trendAligned = (side === "long" && regime === "bull") || (side === "short" && regime === "bear");
  return {
    trendAligned,
    oversold: regime === "bull" ? TREND_PULSE_DEFAULTS.trendAlignedOversold : TREND_PULSE_DEFAULTS.oversold,
    overbought: regime === "bear" ? TREND_PULSE_DEFAULTS.trendAlignedOverbought : TREND_PULSE_DEFAULTS.overbought,
    requiredVolumeRatio: trendAligned ? TREND_PULSE_DEFAULTS.alignedMinVolumeRatio : TREND_PULSE_DEFAULTS.neutralMinVolumeRatio,
  };
}
export function trendPulseConfidence(trendAligned: boolean, extreme: { min: number; max: number }, volumeRatio: number, squeezeAge: number, rsiAge: number) {
  let confidence = trendAligned ? TREND_PULSE_DEFAULTS.minConfidence : 65;
  if (extreme.min <= 20 || extreme.max >= 80) confidence += 8;
  if (volumeRatio >= 2.5) confidence += 6;
  if (squeezeAge <= 2) confidence += 5;
  if (rsiAge === 0) confidence += 2;
  return Math.min(95, confidence);
}
export function evaluateTrendPulse(coin: string, fourHour: Bar[], hourly: Bar[], fifteen: Bar[]): TrendPulseSignal {
  const price = fifteen.at(-1)?.c ?? 0;
  const none = (reason: string, indicators: Record<string, number> = {}, regime: TrendPulseSignal["regime"] = "neutral"): TrendPulseSignal => ({ coin, side: null, confidence: 0, price, atrValue: 0, regime, reasons: [reason], indicators });
  if (fourHour.length < 55 || hourly.length < 40 || fifteen.length < 40) return none("Waiting for 4H/1H/15m history");
  const h4 = fourHour.map(b => b.c), h4Price = last(h4)!, h4Ema20 = last(ema(h4, 20))!, h4Ema50 = last(ema(h4, 50))!;
  const regime = h4Price > h4Ema20 && h4Ema20 > h4Ema50 ? "bull" : h4Price < h4Ema20 && h4Ema20 < h4Ema50 ? "bear" : "neutral";
  const rv = rsi(hourly.map(b => b.c), TREND_PULSE_DEFAULTS.rsiPeriod);
  const longThresholds = trendPulseThresholds(regime, "long"), shortThresholds = trendPulseThresholds(regime, "short");
  const oversold = longThresholds.oversold, overbought = shortThresholds.overbought;
  let side: Side | null = null, rsiAge = -1, rsiNow = NaN, rsiPrev = NaN, extreme = { min: Infinity, max: -Infinity };
  for (let age = 0; age < TREND_PULSE_DEFAULTS.rsiSetupWindowBars; age++) {
    const end = rv.length - age;
    const window = rv.slice(0, end);
    const current = window.at(-1) ?? NaN, previous = window.at(-2) ?? NaN;
    const candidate = trailedExtreme(window, oversold, overbought);
    const long = candidate.min <= oversold && current - previous >= TREND_PULSE_DEFAULTS.rsiMinReversal && regime !== "bear";
    const short = candidate.max >= overbought && previous - current >= TREND_PULSE_DEFAULTS.rsiMinReversal && regime !== "bull";
    if (long || short) { side = long ? "long" : "short"; rsiAge = age; rsiNow = current; rsiPrev = previous; extreme = candidate; break; }
  }
  const base = { h4Price, h4Ema20, h4Ema50, rsiNow, rsiPrev, rsiMin: extreme.min, rsiMax: extreme.max, rsiAge, rsiOversoldThreshold: oversold, rsiOverboughtThreshold: overbought };
  if (!side) return none("No RSI extreme reversal", base, regime);
  const closes = fifteen.map(b => b.c), bb = bollinger(closes, 20, 2), kc = kcSeries(fifteen, 20, 1.5), i = fifteen.length - 1;
  let squeezeAge = 0; for (let age = 1; age <= TREND_PULSE_DEFAULTS.squeezeSetupWindowBars; age++) { const j = i - age; if (Number.isFinite(bb.upper[j]) && bb.upper[j] <= kc.upper[j] && bb.lower[j] >= kc.lower[j]) { squeezeAge = age; break; } }
  const prior = fifteen.slice(i - 4, i), released = side === "long" ? fifteen[i].c > Math.max(...prior.map(b => b.h)) : fifteen[i].c < Math.min(...prior.map(b => b.l));
  const avgVol = fifteen.slice(-21, -1).reduce((s, b) => s + b.v, 0) / 20, volumeRatio = avgVol > 0 ? fifteen[i].v / avgVol : 0, atrValue = last(atr(fifteen, 14)) ?? 0;
  const { trendAligned, requiredVolumeRatio } = trendPulseThresholds(regime, side);
  const indicators = { ...base, squeezeAge, volumeRatio, requiredVolumeRatio, atrValue, signalCandleTs: fifteen[i].t };
  if (!squeezeAge || !released || volumeRatio < requiredVolumeRatio || !(atrValue > 0)) return none("Trend-Pulse catalyst incomplete", indicators, regime);
  const confidence = trendPulseConfidence(trendAligned, extreme, volumeRatio, squeezeAge, rsiAge);
  const stopLoss = side === "long" ? price - atrValue * 1.2 : price + atrValue * 1.2, takeProfit = side === "long" ? price + atrValue * 3.5 : price - atrValue * 3.5;
  return { coin, side, confidence, price, stopLoss, takeProfit, atrValue, regime, indicators, reasons: [`4H ${regime} regime`, `1H RSI reversal confirmed ${rsiAge} completed bar${rsiAge === 1 ? "" : "s"} ago`, `15m squeeze released with ${volumeRatio.toFixed(2)}x volume (minimum ${requiredVolumeRatio.toFixed(1)}x)`] };
}
export function trendPulseRiskSizedQuantity(equity: number, entry: number, stop: number) { const d = Math.abs(entry - stop); return d > 0 ? equity * 0.015 / d : 0; }
