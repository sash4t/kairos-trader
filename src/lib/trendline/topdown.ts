import { buildTimeframeLines } from "./lines";
import { TIMEFRAME_LADDER, type Bar, type Timeframe, type TrendLine, type TrendlineConfig } from "./types";

export interface TopDownState {
  /** every line built at every timeframe, higher-timeframe structure preserved */
  lines: TrendLine[];
  byTimeframe: Partial<Record<Timeframe, TrendLine[]>>;
  execution: Timeframe;
}

/** Timeframes to analyse for a given execution timeframe: 1M → … → execution. */
export function ladderFor(execution: Timeframe): Timeframe[] {
  const idx = TIMEFRAME_LADDER.indexOf(execution);
  return TIMEFRAME_LADDER.slice(0, idx < 0 ? TIMEFRAME_LADDER.indexOf("1h") + 1 : idx + 1);
}

/**
 * Builds the full top-down ladder. Higher-timeframe lines are kept as
 * context; each lower timeframe refines the structure like a magnifying
 * glass rather than replacing it.
 */
export function buildTopDown(
  barsByTimeframe: Partial<Record<Timeframe, Bar[]>>,
  execution: Timeframe,
  cfg: TrendlineConfig,
): TopDownState {
  const byTimeframe: Partial<Record<Timeframe, TrendLine[]>> = {};
  const lines: TrendLine[] = [];
  for (const tf of ladderFor(execution)) {
    const bars = barsByTimeframe[tf];
    // Newer perps simply have no monthly/weekly history — they contribute no
    // lines at that level instead of disqualifying the symbol.
    if (!bars || bars.length < cfg.leftStrength + cfg.rightStrength + 6) continue;
    const tfLines = buildTimeframeLines(bars, tf, cfg);
    byTimeframe[tf] = tfLines;
    lines.push(...tfLines);
  }
  return { lines, byTimeframe, execution };
}
