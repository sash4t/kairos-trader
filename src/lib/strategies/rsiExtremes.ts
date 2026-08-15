import { rsi } from "../indicators";
import type { Bar } from "../strategy";

export const RSI_EXTREMES_KEY = "rsi-extremes-1h" as const;

export const RSI_EXTREMES_DEFAULTS = {
  period: 14,
  oversold: 30,
  overbought: 70,
  longExit: 52,
  shortExit: 48,
  armLookbackBars: 3,
  stopPct: 2,
  maxLeverage: 3,
  // Effectively unbounded relative to the Hyperliquid universe: scan every eligible liquid market.
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
  stopLoss?: number;
  indicators: Record<string, number>;
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

  const recent = values.slice(-(RSI_EXTREMES_DEFAULTS.armLookbackBars + 1));
  const priorWindow = recent.slice(0, -1).filter(Number.isFinite);
  const minRsi = priorWindow.length ? Math.min(...priorWindow) : current;
  const maxRsi = priorWindow.length ? Math.max(...priorWindow) : current;
  const crossedUp = previous <= RSI_EXTREMES_DEFAULTS.oversold && current > RSI_EXTREMES_DEFAULTS.oversold && current > previous;
  const crossedDown = previous >= RSI_EXTREMES_DEFAULTS.overbought && current < RSI_EXTREMES_DEFAULTS.overbought && current < previous;

  if (minRsi <= RSI_EXTREMES_DEFAULTS.oversold && crossedUp) {
    return { side: "long", confidence: confidenceFor("long", minRsi, previous, current), extreme: minRsi, current, previous };
  }
  if (maxRsi >= RSI_EXTREMES_DEFAULTS.overbought && crossedDown) {
    return { side: "short", confidence: confidenceFor("short", maxRsi, previous, current), extreme: maxRsi, current, previous };
  }
  return { side: null, confidence: 0, extreme: Number.NaN, current, previous };
}

/** Pure RSI(14) mean-reversion signal on completed 1H candles. */
export function evaluateRsiExtremes(coin: string, hourly: Bar[]): RsiExtremeSignal {
  const price = hourly.at(-1)?.c ?? 0;
  const empty: RsiExtremeSignal = { coin, side: null, confidence: 0, reasons: [], price, indicators: {} };
  if (hourly.length < 40) return { ...empty, reasons: ["Waiting for 1H RSI history"] };

  const values = rsi(hourly.map((b) => b.c), RSI_EXTREMES_DEFAULTS.period);
  const result = evaluateRsiValues(values);
  const finiteRecent = values.slice(-(RSI_EXTREMES_DEFAULTS.armLookbackBars + 1)).filter(Number.isFinite);
  const minRsi = finiteRecent.length ? Math.min(...finiteRecent) : result.current;
  const maxRsi = finiteRecent.length ? Math.max(...finiteRecent) : result.current;
  const indicators = { rsi: result.current, rsiPrevious: result.previous, minRecentRsi: minRsi, maxRecentRsi: maxRsi };

  if (!result.side) {
    return { ...empty, indicators, reasons: [`No 1H RSI reversal from <=${RSI_EXTREMES_DEFAULTS.oversold} or >=${RSI_EXTREMES_DEFAULTS.overbought}`] };
  }

  const stopLoss = result.side === "long"
    ? price * (1 - RSI_EXTREMES_DEFAULTS.stopPct / 100)
    : price * (1 + RSI_EXTREMES_DEFAULTS.stopPct / 100);
  const reasons = [
    result.side === "long"
      ? `1H RSI reversed up from oversold ${result.extreme.toFixed(1)}`
      : `1H RSI reversed down from overbought ${result.extreme.toFixed(1)}`,
    `RSI ${result.previous.toFixed(1)} → ${result.current.toFixed(1)}`,
    result.side === "long" ? `Ride toward RSI ${RSI_EXTREMES_DEFAULTS.longExit}+` : `Ride toward RSI ${RSI_EXTREMES_DEFAULTS.shortExit}-`,
  ];

  return { coin, side: result.side, confidence: result.confidence, reasons, price, stopLoss, indicators };
}

export function latestRsi(hourly: Bar[]): number {
  if (hourly.length < RSI_EXTREMES_DEFAULTS.period + 2) return Number.NaN;
  return rsi(hourly.map((b) => b.c), RSI_EXTREMES_DEFAULTS.period).at(-1) ?? Number.NaN;
}

export function shouldExitRsiExtreme(side: RsiExtremeSide, rsiValue: number): boolean {
  if (!Number.isFinite(rsiValue)) return false;
  return side === "long" ? rsiValue >= RSI_EXTREMES_DEFAULTS.longExit : rsiValue <= RSI_EXTREMES_DEFAULTS.shortExit;
}
