/**
 * Intraday Momentum Pullback strategy.
 * Timeframe stack: 4H (regime) → 1H (trend direction) → 15m (entries).
 *
 * Entry logic:
 *   Long:  established bullish 1H EMA20/50 trend → 15m pulls back to EMA20/VWAP
 *          → price rejects pullback and reclaims momentum candle.
 *   Short: inverse.
 *
 * Stop-loss model (structure + ATR, NOT a fixed % of price):
 *   stop = beyond most recent 8-bar swing ± ATR × buffer
 *   Position size is derived from the resulting stop distance so every
 *   trade risks approximately the same % of equity regardless of
 *   whether the chart needs a 0.4% or 1.2% price stop.
 *
 * Profit protection (R-based, not fixed %-of-price triggers):
 *   ≈ +1R  → move stop toward breakeven
 *   ≥ +1.5R → switch to ATR/price trailing stop
 *
 * Confirmation indicators (confidence scoring, not hard vetoes):
 *   RSI, MACD, volume improve the confidence score; low readings do NOT
 *   reject a structurally valid setup outright.
 */
import { atr, ema, last, macd, rsi } from "../indicators";
import type { Bar } from "../strategy";

export const INTRADAY_PULLBACK_KEY = "intraday-momentum-pullback" as const;

export const INTRADAY_DEFAULTS = {
  /** Default account risk per trade (% of equity). */
  riskPct: 0.4,
  /** Hard cap on position notional as % of equity (before leverage). */
  positionSizePct: 6,
  /** ATR multiplier beyond the swing extreme for the initial stop. */
  atrStopBuffer: 0.35,
  /** Reject setups where price is already > this many ATRs from EMA20. */
  maxExtensionAtr: 1.25,
  /** Minimum 15m ATR% to avoid dead markets. */
  minAtrPct: 0.18,
  /** Maximum 15m ATR% to avoid untradeably violent markets. */
  maxAtrPct: 4.5,
  /** Minimum volume ratio for any scoring credit (not a hard veto). */
  minVolumeRatio: 0.8,
  /** Take-profit in R multiples (used to set the TP level). */
  takeProfitR: 2.2,
  /**
   * R at which the stop begins trailing.
   * In the paper engine the stop moves toward breakeven at ~1R and
   * switches to the ATR/price trail from ~1.5R.
   */
  trailAtR: 1.5,
  /** Trail distance as a fraction of 1R (0.75 = trail at 75% of initial risk). */
  trailDistanceR: 0.75,
} as const;

export interface IntradayPullbackSignal {
  coin: string;
  side: "long" | "short" | null;
  confidence: number;
  reasons: string[];
  price: number;
  /** Structural + ATR stop — this is the risk anchor, NOT a fixed-% stop. */
  stopLoss?: number;
  atrValue: number;
  indicators: Record<string, number>;
}

function average(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/**
 * 4H / 1H trend bias using EMA20/EMA50 plus price structure.
 * Returns null for neutral/choppy conditions.
 */
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
  const base: IntradayPullbackSignal = {
    coin, side: null, confidence: 0, reasons: [], price, atrValue: 0, indicators: {},
  };

  if (fourHour.length < 60 || hourly.length < 60 || fifteen.length < 80) {
    return { ...base, reasons: ["Waiting for 4H → 1H → 15m history"] };
  }

  // ── Trend regime (4H + 1H must agree) ───────────────────────────────────────
  const fourBias = trendBias(fourHour);   // market regime
  const hourBias = trendBias(hourly);     // directional trend
  if (!fourBias || fourBias !== hourBias) {
    return { ...base, reasons: [`4H/1H trend not aligned (${fourBias ?? "neutral"}/${hourBias ?? "neutral"})`] };
  }

  // ── 15m indicators ──────────────────────────────────────────────────────────
  const closes = fifteen.map((b) => b.c);
  const vols   = fifteen.map((b) => b.v);
  const e20       = last(ema(closes, 20)) ?? NaN;
  const e50       = last(ema(closes, 50)) ?? NaN;
  const atrValue  = last(atr(fifteen, 14)) ?? 0;
  const atrPct    = price > 0 ? (atrValue / price) * 100 : 0;
  const rsiValue  = last(rsi(closes, 14)) ?? NaN;
  const histArr   = macd(closes).hist;
  const macd0     = histArr.at(-1) ?? NaN;
  const macd1     = histArr.at(-2) ?? NaN;
  const avgVol    = average(vols.slice(-21, -1));
  const volumeRatio = avgVol > 0 ? (vols.at(-1) ?? 0) / avgVol : 0;

  const candle   = fifteen.at(-1)!;
  const previous = fifteen.at(-2)!;
  // Distance from EMA20 in ATR units — rejects chasing
  const distanceAtr = atrValue > 0 ? Math.abs(price - e20) / atrValue : Infinity;

  const indicators = {
    fourHourBias: fourBias === "long" ? 1 : -1,
    hourlyBias:   hourBias === "long" ? 1 : -1,
    ema20: e20, ema50: e50, atrPct, rsi: rsiValue,
    macdHist: macd0, volumeRatio, distanceAtr,
  };

  // ── Hard gate: volatility only ───────────────────────────────────────────────
  if (!(atrPct >= INTRADAY_DEFAULTS.minAtrPct && atrPct <= INTRADAY_DEFAULTS.maxAtrPct)) {
    return { ...base, atrValue, indicators, reasons: [`15m ATR ${atrPct.toFixed(2)}% outside intraday volatility band`] };
  }
  // Reject chasing — price already extended well beyond the mean
  if (distanceAtr > INTRADAY_DEFAULTS.maxExtensionAtr) {
    return { ...base, atrValue, indicators, reasons: [`Price ${distanceAtr.toFixed(2)} ATR from EMA20; avoiding chase`] };
  }

  // ── 15m pullback / rejection entry pattern ───────────────────────────────────
  // Long: 15m low touched EMA20 area, candle closed bullish above EMA20
  // Short: inverse
  const longPullback  = fourBias === "long"
    && e20 > e50
    && candle.l <= e20 + atrValue * 0.2
    && candle.c > e20
    && candle.c > candle.o
    && candle.c > previous.c;

  const shortPullback = fourBias === "short"
    && e20 < e50
    && candle.h >= e20 - atrValue * 0.2
    && candle.c < e20
    && candle.c < candle.o
    && candle.c < previous.c;

  const side = longPullback ? "long" : shortPullback ? "short" : null;
  if (!side) {
    return { ...base, atrValue, indicators, reasons: ["No confirmed 15m EMA20 pullback/rejection"] };
  }

  // ── Structural ATR stop ──────────────────────────────────────────────────────
  // Stop is placed beyond the most recent swing extreme ± ATR buffer.
  // This means the stop distance varies with market conditions, and position
  // size is derived from that distance to keep risk constant per trade.
  const recent    = fifteen.slice(-9, -1);
  const structure = side === "long"
    ? Math.min(...recent.map((b) => b.l))
    : Math.max(...recent.map((b) => b.h));

  const stopLoss = side === "long"
    ? structure - atrValue * INTRADAY_DEFAULTS.atrStopBuffer
    : structure + atrValue * INTRADAY_DEFAULTS.atrStopBuffer;

  if (!(stopLoss > 0) || (side === "long" ? stopLoss >= price : stopLoss <= price)) {
    return { ...base, atrValue, indicators, reasons: ["Could not build valid structural ATR stop"] };
  }

  // ── Confidence scoring (no indicator vetoes beyond volatility + chase guard) ─
  const reasons = [
    "4H trend aligned",
    "1H trend aligned",
    "15m pullback reclaimed EMA20",
    "15m rejection candle confirmed",
  ];
  let confidence = 68;

  // RSI: momentum without overextension
  const rsiOk = side === "long" ? rsiValue >= 45 && rsiValue <= 73 : rsiValue >= 27 && rsiValue <= 55;
  if (rsiOk) {
    confidence += 6;
    reasons.push("RSI supports momentum without overextension");
  } else if (Number.isFinite(rsiValue)) {
    reasons.push(`RSI ${rsiValue.toFixed(1)} outside ideal band (not blocking)`);
  }

  // MACD: improving momentum
  const macdOk = side === "long" ? macd0 >= macd1 : macd0 <= macd1;
  if (macdOk) { confidence += 6; reasons.push("MACD momentum is improving"); }

  // Volume: confirmation (reduced score, not veto)
  if (volumeRatio >= INTRADAY_DEFAULTS.minVolumeRatio) {
    confidence += 5;
    reasons.push(`Volume ${volumeRatio.toFixed(2)}x 20-bar average`);
  } else {
    reasons.push(`Volume ${volumeRatio.toFixed(2)}x average (low but not blocking)`);
    confidence -= 3; // mild penalty; still tradeable
  }

  // Tight pullback bonus
  if (distanceAtr <= 0.55) confidence += 5;

  return {
    coin, side,
    confidence: Math.min(92, confidence),
    reasons, price, stopLoss, atrValue, indicators,
  };
}

/**
 * Calculate quantity from a fixed equity risk % and the actual stop distance.
 * This is what keeps per-trade risk constant regardless of how wide the stop is.
 */
export function riskSizedQuantity(equity: number, riskPct: number, entry: number, stop: number): number {
  const riskUsd  = equity * (riskPct / 100);
  const distance = Math.abs(entry - stop);
  return riskUsd > 0 && distance > 0 ? riskUsd / distance : 0;
}

/** R-multiple take-profit level from entry + stop. */
export function targetFromR(
  side: "long" | "short",
  entry: number,
  stop: number,
  r = INTRADAY_DEFAULTS.takeProfitR,
): number {
  const risk = Math.abs(entry - stop);
  return side === "long" ? entry + risk * r : entry - risk * r;
}

/**
 * Compute the updated stop based on current P&L expressed in R multiples.
 *
 * At ~1R:   move stop to near breakeven (entry + tiny sliver in favour)
 * At ≥1.5R: trail at `trailDistanceR × 1R` below/above best price.
 *
 * The stop never loosens: long stops only rise, short stops only fall.
 */
export function intradayRTrail(
  side: "long" | "short",
  entry: number,
  initialStop: number,
  bestPrice: number,
  currentStop: number,
): number {
  const r = Math.abs(entry - initialStop);
  if (!(r > 0) || !(bestPrice > 0)) return currentStop;

  const favorableR = side === "long"
    ? (bestPrice - entry) / r
    : (entry - bestPrice) / r;

  let candidate = currentStop;

  // ~1R: move to near breakeven
  if (favorableR >= 1.0) {
    const be = side === "long"
      ? entry + r * 0.05
      : entry - r * 0.05;
    candidate = side === "long"
      ? Math.max(candidate, be)
      : Math.min(candidate, be);
  }

  // ≥1.5R: trail at trailDistanceR × 1R below/above best
  if (favorableR >= INTRADAY_DEFAULTS.trailAtR) {
    const trailed = side === "long"
      ? bestPrice - r * INTRADAY_DEFAULTS.trailDistanceR
      : bestPrice + r * INTRADAY_DEFAULTS.trailDistanceR;
    candidate = side === "long"
      ? Math.max(candidate, trailed)
      : Math.min(candidate, trailed);
  }

  return candidate;
}
