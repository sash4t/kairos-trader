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
  breakoutLookback: 6,
  squeezeLookbackBars: 3,
  minVolumeRatio: 1.5,
  riskPct: 1.5,
  stopPct: 0.45,
  targetPct: 1.0,
  profitTrailActivatePct: 0.2,
  profitTrailDistancePct: 0.2,
  minLockedProfitPct: 0.05,
  breakevenAtPct: 0.4,
  partialAtPct: 1.0,
  partialFraction: 0.5,
  trailPct: 0.5,
  staleMovePct: 0.3,
  staleMinutes: 20,
  maxMinutes: 120,
  minConfidence: 70,
  signalFreshMs: 5 * 60 * 1000,
  sameDirectionBlockBars: 2,
  // Per-coin lockout after a real losing squeeze stop-loss.
  stopLossCooldownMs: 4 * 60 * 60 * 1000,
} as const;

/** Only an actual losing squeeze stop-loss triggers the cooldown. */
export const SQUEEZE_STOP_LOSS_EXIT_REASON = "squeeze_stop_loss" as const;

export interface SqueezeClosedRow {
  coin: string;
  exit_reason?: string | null;
  closed_at?: string | null;
}

/**
 * Maps coin -> remaining cooldown ms from closed squeeze positions.
 * Only rows whose exit_reason is exactly "squeeze_stop_loss" count.
 */
export function squeezeCooldownMap(
  rows: SqueezeClosedRow[] | null | undefined,
  nowMs = Date.now(),
  cooldownMs = SQUEEZE_DEFAULTS.stopLossCooldownMs,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows ?? []) {
    if (row?.exit_reason !== SQUEEZE_STOP_LOSS_EXIT_REASON) continue;
    const closedAt = row.closed_at ? Date.parse(row.closed_at) : NaN;
    if (!Number.isFinite(closedAt)) continue;
    const remaining = closedAt + cooldownMs - nowMs;
    if (remaining <= 0) continue;
    out.set(row.coin, Math.max(out.get(row.coin) ?? 0, remaining));
  }
  return out;
}

export function formatCooldownRemaining(remainingMs: number): string {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

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

/**
 * Original Plus: a real recent 15m BB/KC squeeze must precede a fresh 6-bar
 * breakout with volatility expansion, volume, and light 1H direction support.
 */
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
  const rsiSeries = rsi(closes1h, 14);
  const hourRsi = last(rsiSeries) ?? 50;
  const hourRsiPrev = rsiSeries.at(-2) ?? hourRsi;
  const rsiSlope = hourRsi - hourRsiPrev;
  const emaAligned = side === "long" ? hourPrice >= hourEma20 : side === "short" ? hourPrice <= hourEma20 : false;
  const rsiRangeOk = side === "long"
    ? hourRsi >= 40 && hourRsi <= 75
    : side === "short"
      ? hourRsi >= 25 && hourRsi <= 60
      : false;
  const rsiSlopeOk = side === "long" ? rsiSlope > 0 : side === "short" ? rsiSlope < 0 : false;

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
    requiredVolumeRatio: SQUEEZE_DEFAULTS.minVolumeRatio,
    recentHigh,
    recentLow,
    hourlyPrice: hourPrice,
    hourlyEma20: hourEma20,
    emaAligned: emaAligned ? 1 : 0,
    hourlyRsi: hourRsi,
    hourlyRsiPrev: hourRsiPrev,
    rsiRangeOk: rsiRangeOk ? 1 : 0,
    rsiSlope,
    rsiSlopeOk: rsiSlopeOk ? 1 : 0,
    signalCandleTs,
    signalCloseTs,
    signalAgeMs,
    signalFresh: signalFresh ? 1 : 0,
    sameDirectionRecently: sameDirectionRecently ? 1 : 0,
    oppositeDirectionRecently: oppositeDirectionRecently ? 1 : 0,
  };

  if (!recentSqueeze) {
    return { ...empty, indicators, reasons: [`No Bollinger-inside-Keltner squeeze in prior ${SQUEEZE_DEFAULTS.squeezeLookbackBars} completed 15m candles`] };
  }
  if (!side) return { ...empty, indicators, reasons: [`No close beyond prior ${SQUEEZE_DEFAULTS.breakoutLookback}-candle extreme`] };
  if (!bbExpanding) return { ...empty, indicators, reasons: ["Bollinger width is not expanding"] };
  if (volumeRatio < SQUEEZE_DEFAULTS.minVolumeRatio) {
    return { ...empty, indicators, reasons: [`Breakout volume ${volumeRatio.toFixed(2)}x < ${SQUEEZE_DEFAULTS.minVolumeRatio.toFixed(1)}x minimum`] };
  }
  if (!emaAligned) {
    return { ...empty, indicators, reasons: [`1H price is on the wrong side of EMA20 for ${side} breakout`] };
  }
  if (!rsiRangeOk) {
    const range = side === "long" ? "40-75" : "25-60";
    return { ...empty, indicators, reasons: [`1H RSI ${hourRsi.toFixed(1)} outside ${range} ${side} range`] };
  }
  if (!rsiSlopeOk) {
    return { ...empty, indicators, reasons: [`1H RSI slope ${rsiSlope.toFixed(2)} is not ${side === "long" ? "rising" : "falling"} with the breakout`] };
  }
  if (!signalFresh) {
    return { ...empty, indicators, reasons: [signalAgeMs < 0 ? "Waiting for breakout candle to complete" : "Breakout signal is stale; same 15m candle will not be re-traded"] };
  }
  if (sameDirectionRecently) {
    return { ...empty, indicators, reasons: [`Same-direction breakout blocked for ${SQUEEZE_DEFAULTS.sameDirectionBlockBars} completed 15m bars`] };
  }

  const stopLoss = side === "long" ? price * (1 - SQUEEZE_DEFAULTS.stopPct / 100) : price * (1 + SQUEEZE_DEFAULTS.stopPct / 100);
  const takeProfit = side === "long" ? price * (1 + SQUEEZE_DEFAULTS.targetPct / 100) : price * (1 - SQUEEZE_DEFAULTS.targetPct / 100);

  let confidence = 76;
  const reasons = [
    `Recent Bollinger/Keltner squeeze (${squeezeAge} bar${squeezeAge === 1 ? "" : "s"} ago)`,
    `Fresh 15m close broke prior ${SQUEEZE_DEFAULTS.breakoutLookback}-candle ${side === "long" ? "high" : "low"}`,
    `Volume ${volumeRatio.toFixed(2)}x >= ${SQUEEZE_DEFAULTS.minVolumeRatio.toFixed(1)}x minimum`,
    "Bollinger width is expanding",
    `1H price/EMA20 + RSI ${hourRsiPrev.toFixed(1)} -> ${hourRsi.toFixed(1)} support ${side}`,
  ];

  if (volumeRatio >= 2) confidence += 6;
  else if (volumeRatio >= 1.75) confidence += 3;
  const widthExpansion = bb.width[i - 1] > 0 ? bb.width[i] / bb.width[i - 1] : 1;
  if (widthExpansion >= 1.25) confidence += 5;
  else if (widthExpansion >= 1.1) confidence += 2;
  if (squeezeAge === 1) confidence += 2;
  if (released) { confidence += 2; reasons.push("Current candle released outside Keltner squeeze"); }
  if (oppositeDirectionRecently) {
    confidence += 2;
    reasons.push("Fresh opposite breakout after recent failed-direction move");
  }

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

export function squeezeProfitLockStop(side: Side, entry: number, peak: number, currentStop: number): number {
  const favorable = favorablePct(side, entry, peak);
  if (favorable < SQUEEZE_DEFAULTS.profitTrailActivatePct) return currentStop;

  const lockedProfit = side === "long"
    ? entry * (1 + SQUEEZE_DEFAULTS.minLockedProfitPct / 100)
    : entry * (1 - SQUEEZE_DEFAULTS.minLockedProfitPct / 100);
  const trailed = side === "long"
    ? peak * (1 - SQUEEZE_DEFAULTS.profitTrailDistancePct / 100)
    : peak * (1 + SQUEEZE_DEFAULTS.profitTrailDistancePct / 100);
  const candidate = side === "long" ? Math.max(lockedProfit, trailed) : Math.min(lockedProfit, trailed);
  return side === "long" ? Math.max(currentStop, candidate) : Math.min(currentStop, candidate);
}
