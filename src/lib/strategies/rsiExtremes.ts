import { rsi } from "../indicators";
import type { Bar } from "../strategy";

export const RSI_EXTREMES_KEY = "rsi-extremes-1h" as const;

export const RSI_EXTREMES_DEFAULTS = {
  period: 14,
  oversold: 30,
  overbought: 70,
  exitReversalPoints: 4,
  maxLeverage: 3,
  // Scan every eligible RSI market on each due scan.
  scanLimit: 10_000,
  scanEveryMs: 60 * 1000,
  minConfidence: 70,
} as const;

export type RsiExtremeSide = "long" | "short";

export interface RsiExtremeSignal {
  coin: string;
  side: RsiExtremeSide | null;
  confidence: number;
  reasons: string[];
  price: number;
  indicators: Record<string, number>;
}

const HOUR_MS = 60 * 60 * 1000;

/** Keep only candles whose full 1H interval has closed. */
export function completedHourlyBars(hourly: Bar[], now = Date.now()): Bar[] {
  return hourly.filter((bar) => bar.t + HOUR_MS <= now);
}

function confidenceFor(side: RsiExtremeSide, extreme: number, previous: number, current: number): number {
  let confidence = RSI_EXTREMES_DEFAULTS.minConfidence;
  if (side === "long") {
    if (extreme <= 20) confidence += 8;
    else if (extreme <= 25) confidence += 5;
  } else {
    if (extreme >= 80) confidence += 8;
    else if (extreme >= 75) confidence += 5;
  }
  if (Math.abs(current - previous) >= 3) confidence += 3;
  return Math.min(95, confidence);
}

export function evaluateRsiValues(values: number[]): { side: RsiExtremeSide | null; confidence: number; extreme: number; current: number; previous: number } {
  const current = values.at(-1) ?? Number.NaN;
  const previous = values.at(-2) ?? Number.NaN;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    return { side: null, confidence: 0, extreme: Number.NaN, current, previous };
  }

  // Trail the contiguous RSI excursion. The signal fires only on the first
  // completed candle that reverses from the excursion's highest/lowest value.
  const finite = values.filter(Number.isFinite);
  let overboughtStart = finite.length - 2;
  while (overboughtStart > 0 && finite[overboughtStart - 1] >= RSI_EXTREMES_DEFAULTS.overbought) overboughtStart--;
  const overboughtTrail = finite.slice(overboughtStart, -1);
  const maxRsi = overboughtTrail.length ? Math.max(...overboughtTrail) : previous;

  let oversoldStart = finite.length - 2;
  while (oversoldStart > 0 && finite[oversoldStart - 1] <= RSI_EXTREMES_DEFAULTS.oversold) oversoldStart--;
  const oversoldTrail = finite.slice(oversoldStart, -1);
  const minRsi = oversoldTrail.length ? Math.min(...oversoldTrail) : previous;

  const recoveringLong = previous <= RSI_EXTREMES_DEFAULTS.oversold
    && previous === minRsi
    && current > previous;
  const recoveringShort = previous >= RSI_EXTREMES_DEFAULTS.overbought
    && previous === maxRsi
    && current < previous;

  if (recoveringLong) {
    return { side: "long", confidence: confidenceFor("long", minRsi, previous, current), extreme: minRsi, current, previous };
  }
  if (recoveringShort) {
    return { side: "short", confidence: confidenceFor("short", maxRsi, previous, current), extreme: maxRsi, current, previous };
  }
  return { side: null, confidence: 0, extreme: Number.NaN, current, previous };
}

/** Pure RSI(14) mean-reversion signal on completed 1H candles. */
export function evaluateRsiExtremes(coin: string, hourly: Bar[]): RsiExtremeSignal {
  const completed = completedHourlyBars(hourly);
  const price = completed.at(-1)?.c ?? 0;
  const empty: RsiExtremeSignal = { coin, side: null, confidence: 0, reasons: [], price, indicators: {} };
  if (completed.length < 40) return { ...empty, reasons: ["Waiting for completed 1H RSI history"] };

  const values = rsi(completed.map((b) => b.c), RSI_EXTREMES_DEFAULTS.period);
  const result = evaluateRsiValues(values);
  const signalCandleTs = completed.at(-1)?.t ?? 0;
  const indicators = {
    rsi: result.current,
    rsiPrevious: result.previous,
    trailedRsiExtreme: result.extreme,
    rsiExitTrail: result.current,
    signalCandleTs,
  };

  if (!result.side) {
    return { ...empty, indicators, reasons: [`No completed-candle reversal from a trailed RSI <=${RSI_EXTREMES_DEFAULTS.oversold} or >=${RSI_EXTREMES_DEFAULTS.overbought}`] };
  }

  const reasons = [
    result.side === "long"
      ? `Completed 1H RSI reversed up from trailed low ${result.extreme.toFixed(1)}`
      : `Completed 1H RSI reversed down from trailed high ${result.extreme.toFixed(1)}`,
    `RSI ${result.previous.toFixed(1)} → ${result.current.toFixed(1)}`,
    `Trail RSI until a ${RSI_EXTREMES_DEFAULTS.exitReversalPoints}-point completed-candle reversal`,
  ];

  return { coin, side: result.side, confidence: result.confidence, reasons, price, indicators };
}

export function latestRsi(hourly: Bar[]): number {
  const completed = completedHourlyBars(hourly);
  if (completed.length < RSI_EXTREMES_DEFAULTS.period + 2) return Number.NaN;
  return rsi(completed.map((b) => b.c), RSI_EXTREMES_DEFAULTS.period).at(-1) ?? Number.NaN;
}

export interface RsiExitTrail {
  extreme: number;
  reversalPoints: number;
  shouldExit: boolean;
}

/** Trail favorable RSI movement and exit after a completed-candle reversal. */
export function updateRsiExitTrail(side: RsiExtremeSide, rsiValue: number, priorExtreme?: number): RsiExitTrail {
  if (!Number.isFinite(rsiValue)) {
    return { extreme: Number.NaN, reversalPoints: 0, shouldExit: false };
  }
  const seed = Number.isFinite(priorExtreme) ? priorExtreme! : rsiValue;
  const extreme = side === "long" ? Math.max(seed, rsiValue) : Math.min(seed, rsiValue);
  const reversalPoints = side === "long" ? extreme - rsiValue : rsiValue - extreme;
  return {
    extreme,
    reversalPoints,
    shouldExit: reversalPoints >= RSI_EXTREMES_DEFAULTS.exitReversalPoints,
  };
}
