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
  riskPct: 0.5,
  stopPct: 1.25,
  maxLeverage: 3,
  scanLimit: 60,
  scanEveryMs: 5 * 60 * 1000,
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

/**
 * Pure RSI(14) mean-reversion signal on completed 1H candles.
 *
 * Long: RSI reached <=30 during the recent arm window, then the latest
 * completed reading crosses back above 30 and is rising.
 * Short: inverse from >=70.
 */
export function evaluateRsiExtremes(coin: string, hourly: Bar[]): RsiExtremeSignal {
  const price = hourly.at(-1)?.c ?? 0;
  const empty: RsiExtremeSignal = { coin, side: null, confidence: 0, reasons: [], price, indicators: {} };
  if (hourly.length < 40) return { ...empty, reasons: ["Waiting for 1H RSI history"] };

  const values = rsi(hourly.map((b) => b.c), RSI_EXTREMES_DEFAULTS.period);
  const current = values.at(-1);
  const previous = values.at(-2);
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return { ...empty, reasons: ["Waiting for valid RSI(14)"] };

  const recent = values.slice(-(RSI_EXTREMES_DEFAULTS.armLookbackBars + 1));
  const priorWindow = recent.slice(0, -1).filter(Number.isFinite) as number[];
  const minRsi = priorWindow.length ? Math.min(...priorWindow) : current!;
  const maxRsi = priorWindow.length ? Math.max(...priorWindow) : current!;

  const crossedUp = previous! <= RSI_EXTREMES_DEFAULTS.oversold && current! > RSI_EXTREMES_DEFAULTS.oversold && current! > previous!;
  const crossedDown = previous! >= RSI_EXTREMES_DEFAULTS.overbought && current! < RSI_EXTREMES_DEFAULTS.overbought && current! < previous!;
  const longArmed = minRsi <= RSI_EXTREMES_DEFAULTS.oversold;
  const shortArmed = maxRsi >= RSI_EXTREMES_DEFAULTS.overbought;

  const indicators = { rsi: current!, rsiPrevious: previous!, minRecentRsi: minRsi, maxRecentRsi: maxRsi };

  let side: RsiExtremeSide | null = null;
  let extreme = current!;
  if (longArmed && crossedUp) { side = "long"; extreme = minRsi; }
  else if (shortArmed && crossedDown) { side = "short"; extreme = maxRsi; }

  if (!side) {
    return { ...empty, indicators, reasons: [`No 1H RSI reversal from <=${RSI_EXTREMES_DEFAULTS.oversold} or >=${RSI_EXTREMES_DEFAULTS.overbought}`] };
  }

  const confidence = confidenceFor(side, extreme, previous!, current!);
  const stopLoss = side === "long"
    ? price * (1 - RSI_EXTREMES_DEFAULTS.stopPct / 100)
    : price * (1 + RSI_EXTREMES_DEFAULTS.stopPct / 100);
  const reasons = [
    side === "long"
      ? `1H RSI reversed up from oversold ${extreme.toFixed(1)}`
      : `1H RSI reversed down from overbought ${extreme.toFixed(1)}`,
    `RSI ${previous!.toFixed(1)} → ${current!.toFixed(1)}`,
    side === "long" ? `Ride toward RSI ${RSI_EXTREMES_DEFAULTS.longExit}+` : `Ride toward RSI ${RSI_EXTREMES_DEFAULTS.shortExit}-`,
  ];

  return { coin, side, confidence, reasons, price, stopLoss, indicators };
}

export function shouldExitRsiExtreme(side: RsiExtremeSide, rsiValue: number): boolean {
  if (!Number.isFinite(rsiValue)) return false;
  return side === "long"
    ? rsiValue >= RSI_EXTREMES_DEFAULTS.longExit
    : rsiValue <= RSI_EXTREMES_DEFAULTS.shortExit;
}

export function rsiExtremeRiskSizedQuantity(equity: number, entry: number, stop: number, riskPct = RSI_EXTREMES_DEFAULTS.riskPct): number {
  const riskUsd = equity * (riskPct / 100);
  const distance = Math.abs(entry - stop);
  return riskUsd > 0 && distance > 0 ? riskUsd / distance : 0;
}
