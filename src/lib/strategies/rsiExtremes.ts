import { atr, ema, rsi } from "../indicators";
import type { Bar } from "../strategy";

export const RSI_EXTREMES_KEY = "rsi-extremes-1h" as const;

export const RSI_EXTREMES_DEFAULTS = {
  period: 14,
  oversold: 35,
  overbought: 65,
  minReversalPoints: 2,
  emergencyAtrMult: 2,
  riskPct: 1,
  maxHoldHours: 6,
  breakevenFractionOfTarget: 0.5,
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
  stopLoss?: number;
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
    && current - previous >= RSI_EXTREMES_DEFAULTS.minReversalPoints;
  const recoveringShort = previous >= RSI_EXTREMES_DEFAULTS.overbought
    && previous === maxRsi
    && previous - current >= RSI_EXTREMES_DEFAULTS.minReversalPoints;

  if (recoveringLong) {
    return { side: "long", confidence: confidenceFor("long", minRsi, previous, current), extreme: minRsi, current, previous };
  }
  if (recoveringShort) {
    return { side: "short", confidence: confidenceFor("short", maxRsi, previous, current), extreme: maxRsi, current, previous };
  }
  return { side: null, confidence: 0, extreme: Number.NaN, current, previous };
}

/** Pure RSI(14) mean-reversion signal on completed 1H candles. */
export function evaluateRsiExtremes(coin: string, hourly: Bar[], fourHour: Bar[] = []): RsiExtremeSignal {
  const completed = completedHourlyBars(hourly);
  const price = completed.at(-1)?.c ?? 0;
  const empty: RsiExtremeSignal = { coin, side: null, confidence: 0, reasons: [], price, indicators: {} };
  if (completed.length < 40) return { ...empty, reasons: ["Waiting for completed 1H RSI history"] };

  const values = rsi(completed.map((b) => b.c), RSI_EXTREMES_DEFAULTS.period);
  const result = evaluateRsiValues(values);
  const signalBar = completed.at(-1)!;
  const candleConfirmed = result.side === "long"
    ? signalBar.c > signalBar.o
    : result.side === "short" ? signalBar.c < signalBar.o : false;
  const atrValue = atr(completed, RSI_EXTREMES_DEFAULTS.period).at(-1) ?? Number.NaN;
  const fourHourCloses = fourHour.map((bar) => bar.c);
  const ema20 = ema(fourHourCloses, 20).at(-1) ?? Number.NaN;
  const ema50 = ema(fourHourCloses, 50).at(-1) ?? Number.NaN;
  const fourHourPrice = fourHour.at(-1)?.c ?? Number.NaN;
  const strongBullTrend = fourHour.length >= 50 && fourHourPrice > ema20 && ema20 > ema50;
  const strongBearTrend = fourHour.length >= 50 && fourHourPrice < ema20 && ema20 < ema50;
  const regimeBlocked = result.side === "short" ? strongBullTrend : result.side === "long" ? strongBearTrend : false;
  const signalCandleTs = completed.at(-1)?.t ?? 0;
  const indicators = {
    rsi: result.current,
    rsiPrevious: result.previous,
    trailedRsiExtreme: result.extreme,
    hourlyAtr: atrValue,
    fourHourEma20: ema20,
    fourHourEma50: ema50,
    regimeBlocked: regimeBlocked ? 1 : 0,
    signalCandleTs,
  };

  if (!result.side) {
    return { ...empty, indicators, reasons: [`No completed-candle RSI reversal of at least ${RSI_EXTREMES_DEFAULTS.minReversalPoints} points from a trailed extreme`] };
  }
  if (!candleConfirmed) return { ...empty, indicators, reasons: ["RSI reversed, but the completed 1H price candle did not confirm the direction"] };
  if (regimeBlocked) return { ...empty, indicators, reasons: [`Blocked ${result.side} against a strong opposing 4H EMA20/50 trend`] };

  const stopLoss = Number.isFinite(atrValue)
    ? result.side === "long" ? price - atrValue * RSI_EXTREMES_DEFAULTS.emergencyAtrMult : price + atrValue * RSI_EXTREMES_DEFAULTS.emergencyAtrMult
    : undefined;

  const reasons = [
    result.side === "long"
      ? `Completed 1H RSI reversed up from trailed low ${result.extreme.toFixed(1)}`
      : `Completed 1H RSI reversed down from trailed high ${result.extreme.toFixed(1)}`,
    `RSI ${result.previous.toFixed(1)} → ${result.current.toFixed(1)}`,
    "Completed 1H price candle confirmed the reversal",
    fourHour.length >= 50 ? "4H EMA20/50 regime permits the trade" : "4H regime history unavailable; no veto applied",
    "Exit at the configured percentage take profit",
  ];

  return { coin, side: result.side, confidence: result.confidence, reasons, price, stopLoss, indicators };
}

export function rsiTakeProfitPrice(side: RsiExtremeSide, entryPrice: number, takeProfitPct: number): number {
  if (!(entryPrice > 0) || !(takeProfitPct > 0) || !Number.isFinite(takeProfitPct)) return Number.NaN;
  return side === "long"
    ? entryPrice * (1 + takeProfitPct / 100)
    : entryPrice * (1 - takeProfitPct / 100);
}

export function rsiTakeProfitHit(side: RsiExtremeSide, mark: number, takeProfit: number): boolean {
  if (!Number.isFinite(mark) || !Number.isFinite(takeProfit)) return false;
  return side === "long" ? mark >= takeProfit : mark <= takeProfit;
}

export function rsiBreakevenTrigger(side: RsiExtremeSide, entry: number, takeProfit: number): number {
  return entry + (takeProfit - entry) * RSI_EXTREMES_DEFAULTS.breakevenFractionOfTarget;
}
