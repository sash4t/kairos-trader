import { atr, bollinger, ema, last, rsi } from "../indicators";
import type { Bar } from "../strategy";

export const TREND_PULSE_KEY = "trend-pulse" as const;
export const TREND_PULSE_DEFAULTS = {
  emaTrendFast: 20, emaTrendSlow: 50, rsiPeriod: 14, oversold: 28, overbought: 72, rsiMinReversal: 3,
  bbPeriod: 20, bbMult: 2, kcMult: 1.5, minVolumeRatio: 1.8,
  riskPct: 1.5, maxLeverage: 5, stopAtrMult: 1.2, partialFraction: 0.5, partialAtrMult: 1.5,
  trailAtrMult: 1, fullTargetAtrMult: 3.5, maxHoldHours: 8, minConfidence: 75,
  stopLossCooldownMs: 4 * 60 * 60 * 1000, scanLimit: 50, scanEveryMs: 60 * 1000,
} as const;
type Side = "long" | "short";
export interface TrendPulseSignal { coin: string; side: Side | null; confidence: number; price: number; stopLoss?: number; takeProfit?: number; atrValue: number; regime: "bull" | "bear" | "neutral"; reasons: string[]; indicators: Record<string, number>; }
function kcSeries(bars: Bar[], period: number, mult: number) { const mid = ema(bars.map(b => b.c), period); const a = atr(bars, period); return { upper: mid.map((m, i) => m + a[i] * mult), lower: mid.map((m, i) => m - a[i] * mult) }; }
export function trailedExtreme(values: number[]) {
  const previous = values.length - 2; let min = Number.POSITIVE_INFINITY; let max = Number.NEGATIVE_INFINITY;
  for (let i = previous; i >= 0; i--) { const v = values[i]; if (!Number.isFinite(v)) break; const outside = v <= TREND_PULSE_DEFAULTS.oversold || v >= TREND_PULSE_DEFAULTS.overbought; if (!outside && i !== previous) break; min = Math.min(min, v); max = Math.max(max, v); }
  return { min, max };
}
export function evaluateTrendPulse(coin: string, fourHour: Bar[], hourly: Bar[], fifteen: Bar[]): TrendPulseSignal {
  const price = fifteen.at(-1)?.c ?? 0;
  const none = (reason: string, indicators: Record<string, number> = {}, regime: TrendPulseSignal["regime"] = "neutral"): TrendPulseSignal => ({ coin, side: null, confidence: 0, price, atrValue: 0, regime, reasons: [reason], indicators });
  if (fourHour.length < 55 || hourly.length < 40 || fifteen.length < 40) return none("Waiting for 4H/1H/15m history");
  const h4 = fourHour.map(b => b.c), h4Price = last(h4)!, h4Ema20 = last(ema(h4, 20))!, h4Ema50 = last(ema(h4, 50))!;
  const regime = h4Price > h4Ema20 && h4Ema20 > h4Ema50 ? "bull" : h4Price < h4Ema20 && h4Ema20 < h4Ema50 ? "bear" : "neutral";
  const rv = rsi(hourly.map(b => b.c), 14), rsiNow = last(rv) ?? NaN, rsiPrev = rv.at(-2) ?? NaN, extreme = trailedExtreme(rv);
  const long = extreme.min <= 28 && rsiNow - rsiPrev >= 3 && regime !== "bear";
  const short = extreme.max >= 72 && rsiPrev - rsiNow >= 3 && regime !== "bull";
  const side: Side | null = long ? "long" : short ? "short" : null;
  const base = { h4Price, h4Ema20, h4Ema50, rsiNow, rsiPrev, rsiMin: extreme.min, rsiMax: extreme.max };
  if (!side) return none("No RSI extreme reversal", base, regime);
  const closes = fifteen.map(b => b.c), bb = bollinger(closes, 20, 2), kc = kcSeries(fifteen, 20, 1.5), i = fifteen.length - 1;
  let squeezeAge = 0; for (let age = 1; age <= 5; age++) { const j = i - age; if (Number.isFinite(bb.upper[j]) && bb.upper[j] <= kc.upper[j] && bb.lower[j] >= kc.lower[j]) { squeezeAge = age; break; } }
  const prior = fifteen.slice(i - 4, i), released = side === "long" ? fifteen[i].c > Math.max(...prior.map(b => b.h)) : fifteen[i].c < Math.min(...prior.map(b => b.l));
  const avgVol = fifteen.slice(-21, -1).reduce((s, b) => s + b.v, 0) / 20, volumeRatio = avgVol > 0 ? fifteen[i].v / avgVol : 0, atrValue = last(atr(fifteen, 14)) ?? 0;
  const indicators = { ...base, squeezeAge, volumeRatio, atrValue, signalCandleTs: fifteen[i].t };
  if (!squeezeAge || !released || volumeRatio < 1.8 || !(atrValue > 0)) return none("Trend-Pulse catalyst incomplete", indicators, regime);
  let confidence = 60 + (regime === "neutral" ? 4 : 12); if (extreme.min <= 20 || extreme.max >= 80) confidence += 8; if (volumeRatio >= 2.5) confidence += 6; if (squeezeAge <= 2) confidence += 5;
  const stopLoss = side === "long" ? price - atrValue * 1.2 : price + atrValue * 1.2, takeProfit = side === "long" ? price + atrValue * 3.5 : price - atrValue * 3.5;
  return { coin, side, confidence: Math.min(95, confidence), price, stopLoss, takeProfit, atrValue, regime, indicators, reasons: [`4H ${regime} regime`, `1H RSI reversed ${Math.abs(rsiNow - rsiPrev).toFixed(1)} points from an extreme`, `15m squeeze released with ${volumeRatio.toFixed(2)}x volume`] };
}
export function trendPulseRiskSizedQuantity(equity: number, entry: number, stop: number) { const d = Math.abs(entry - stop); return d > 0 ? equity * 0.015 / d : 0; }
