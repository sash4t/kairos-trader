import { atr, bollinger, ema, last, rsi } from "../indicators";
import type { Bar } from "../strategy";

export const VOLATILITY_SQUEEZE_BREAKOUT_KEY = "volatility-squeeze-breakout" as const;

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export const SQUEEZE_DEFAULTS = {
  scanLimit: 70,
  scanEveryMs: 5 * 60 * 1000,
  bbPeriod: 20,
  bbMult: 2,
  kcPeriod: 20,
  kcMult: 1.8,
  breakoutLookback: 4,
  squeezeLookbackBars: 5,
  minVolumeRatio: 2.0,
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
  minConfidence: 82,
  // A completed 15m breakout can only be acted on during the first scanner window after close.
  signalFreshMs: 5 * 60 * 1000,
  // Do not fire the same direction again for the next two completed 15m bars after a breakout.
  sameDirectionBlockBars: 2,
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

function breakoutSideAt(bars: Bar[], idx: number, lookback: number): Side | null {
  if (idx < lookback || idx >= bars.length) return null;
  const prior = bars.slice(idx - lookback, idx);
  if (prior.length < lookback) return null;
  const high = Math.max(...prior.map((b) => b.h));
  const low = Math.min(...prior.map((b) => b.l));
  const close = bars[idx].c;
  if (close > high) return "long";
  if (close < low) return "short";
  return null;
}

export function evaluateVolatilitySqueezeBreakout(coin: string, hourly: Bar[], fifteen: Bar[], nowMs = Date.now()): SqueezeSignal {
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
  const recentSqueeze = squeezeAge > 0;
  const released = Number.isFinite(bb.upper[i]) && Number.isFinite(kc.upper[i])
    && (bb.upper[i] > kc.upper[i] || bb.lower[i] < kc.lower[i]);
  const bbExpanding = Number.isFinite(bb.width[i]) && Number.isFinite(bb.width[i - 1]) && bb.width[i] > bb.width[i - 1];

  const lookback = fifteen.slice(-(SQUEEZE_DEFAULTS.breakoutLookback + 1), -1);
  const recentHigh = Math.max(...lookback.map((b) => b.h));
  const recentLow = Math.min(...lookback.map((b) => b.l));
  const side = breakoutSideAt(fifteen, i, SQUEEZE_DEFAULTS.breakoutLookback);

  const signalCandleTs = fifteen[i].t;
  const signalCloseTs = signalCandleTs + FIFTEEN_MINUTES_MS;
  const signalAgeMs = nowMs - signalCloseTs;
  const signalFresh = signalAgeMs >= 0 && signalAgeMs < SQUEEZE_DEFAULTS.signalFreshMs;

  const recentBreakSides = Array.from({ length: SQUEEZE_DEFAULTS.sameDirectionBlockBars }, (_, offset) =>
    breakoutSideAt(fifteen, i - offset - 1, SQUEEZE_DEFAULTS.breakoutLookback));
  const sameDirectionRecently = side != null && recentBreakSides.includes(side);
  const oppositeDirectionRecently = side != null && recentBreakSides.some((s) => s != null && s !== side);

  const avgVol20 = mean(vols15.slice(-21, -1));
  const volumeRatio = avgVol20 > 0 ? (vols15[i] ?? 0) / avgVol20 : 0;

  const closes1h = hourly.map((b) => b.c);
  const hourPrice = hourly.at(-1)!.c;
  const hourEma20 = last(ema(closes1h, 20)) ?? hourPrice;
  const hourRsi = last(rsi(closes1h, 14)) ?? 50;
  const rsiOk = hourRsi >= 50 && hourRsi <= 70;

  const indicators = {
    priorSqueezed: recentSqueeze ? 1 : 0,
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
    signalCandleTs,
    signalCloseTs,
    signalAgeMs,
    signalFresh: signalFresh ? 1 : 0,
    sameDirectionRecently: sameDirectionRecently ? 1 : 0,
    oppositeDirectionRecently: oppositeDirectionRecently ? 1 : 0,
  };

  if (volumeRatio < SQUEEZE_DEFAULTS.minVolumeRatio) {
    return { ...empty, indicators, reasons: [`Breakout volume ${volumeRatio.toFixed(2)}x < ${SQUEEZE_DEFAULTS.minVolumeRatio.toFixed(1)}x minimum`] };
  }
  if (!rsiOk) {
    return { ...empty, indicators, reasons: [`1H RSI ${hourRsi.toFixed(1)} outside 50-70 momentum band`] };
  }
  if (!side) return { ...empty, indicators, reasons: [`No close beyond prior ${SQUEEZE_DEFAULTS.breakoutLookback}-candle extreme`] };
  if (!bbExpanding) {
    return { ...empty, indicators, reasons: ["Bollinger width is not expanding"] };
  }
  if (!signalFresh) {
    return { ...empty, indicators, reasons: [signalAgeMs < 0 ? "Waiting for breakout candle to complete" : "Breakout signal is stale; same 15m candle will not be re-traded"] };
  }
  if (sameDirectionRecently) {
    return { ...empty, indicators, reasons: [`Same-direction breakout blocked for ${SQUEEZE_DEFAULTS.sameDirectionBlockBars} completed 15m bars`] };
  }

  const stopLoss = side === "long" ? price * (1 - SQUEEZE_DEFAULTS.stopPct / 100) : price * (1 + SQUEEZE_DEFAULTS.stopPct / 100);
  const takeProfit = side === "long" ? price * (1 + SQUEEZE_DEFAULTS.targetPct / 100) : price * (1 - SQUEEZE_DEFAULTS.targetPct / 100);

  let confidence = 60;
  const reasons = [
    `Fresh 15m close broke prior ${SQUEEZE_DEFAULTS.breakoutLookback}-candle ${side === "long" ? "high" : "low"}`,
    `Volume ${volumeRatio.toFixed(2)}x 20-candle average`,
    `1H RSI ${hourRsi.toFixed(1)} inside 50-70 momentum band`,
    "Bollinger width is expanding",
  ];

  confidence += 12; // Mandatory >=2x volume confirmation.
  if (volumeRatio >= 3) confidence += 4;
  confidence += 10; // Mandatory 50-70 RSI momentum regime.
  confidence += 10; // Mandatory volatility expansion.

  if (oppositeDirectionRecently) {
    confidence += 4;
    reasons.push("Fresh opposite breakout after recent failed-direction move");
  }
  if (recentSqueeze) {
    confidence += 5;
    reasons.push(`Recent Bollinger/Keltner squeeze (${squeezeAge} bar${squeezeAge === 1 ? "" : "s"} ago)`);
  }
  const emaAligned = side === "long" ? hourPrice >= hourEma20 : hourPrice <= hourEma20;
  if (emaAligned) { confidence += 2; reasons.push("1H EMA20 direction agrees"); }
  if (released) reasons.push("Current candle is outside Keltner squeeze");

  const widthExpansion = bb.width[i - 1] > 0 ? bb.width[i] / bb.width[i - 1] : 1;
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
