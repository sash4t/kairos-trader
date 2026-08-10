/** Pure price-action trend-line engine — shared by the browser paper engine and the server agent. */

export const TIMEFRAME_LADDER = ["1M", "1w", "1d", "4h", "1h", "30m", "15m", "5m"] as const;
export type Timeframe = (typeof TIMEFRAME_LADDER)[number];

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1M": 30 * 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "5m": 5 * 60 * 1000,
};

export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

export interface Pivot { i: number; t: number; price: number; kind: "low" | "high" }

export type LineType = "bullish" | "bearish";

export interface TrendLine {
  id: string;
  timeframe: Timeframe;
  type: LineType;
  a: Pivot;
  b: Pivot;
  /** price change per millisecond */
  slope: number;
  touches: number;
  state: "active" | "broken";
  /** index of the bar whose CLOSE broke the line, if any */
  brokenAtIndex: number | null;
  brokenAtTime: number | null;
}

export interface TrendlineConfig {
  /** confirmed swing pivot strength */
  leftStrength: number;
  rightStrength: number;
  /** fraction of price a bar may sit off the line and still count as a touch */
  touchTolerancePct: number;
  /** fraction of price a bar may poke through the line before the line is invalid */
  penetrationTolerancePct: number;
  /** minimum touches (including A and B) for a valid line */
  minTouches: number;
  /** stop placed this far beyond the safety line */
  safetyBufferPct: number;
}

export const DEFAULT_TRENDLINE_CONFIG: TrendlineConfig = {
  leftStrength: 3,
  rightStrength: 3,
  touchTolerancePct: 0.15,
  penetrationTolerancePct: 0.35,
  minTouches: 2,
  safetyBufferPct: 0.15,
};

export const TRENDLINE_STRATEGY_KEY = "trendline_price_action" as const;

/** Evaluate a line at an arbitrary timestamp — lines extend forward indefinitely. */
export function lineValueAt(line: Pick<TrendLine, "a" | "slope">, t: number): number {
  return line.a.price + line.slope * (t - line.a.t);
}

export interface TrendlineSignal {
  coin: string;
  side: "long" | "short" | null;
  timeframe: Timeframe;
  price: number;
  actionLine: { type: LineType; value: number } | null;
  safetyLine: { type: LineType; value: number; timeframe: Timeframe } | null;
  /** initial protective stop, just beyond the safety line */
  initialStop: number | null;
  confidence: number;
  reasons: string[];
  /** structured detail for bot_events / position logging */
  detail: Record<string, number | string>;
}
