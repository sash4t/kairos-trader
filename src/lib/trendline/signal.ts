import { buildTopDown, ladderFor, type TopDownState } from "./topdown";
import { lineValueAt, type Bar, type Timeframe, type TrendLine, type TrendlineConfig, type TrendlineSignal } from "./types";

export interface SignalInput {
  coin: string;
  barsByTimeframe: Partial<Record<Timeframe, Bar[]>>;
  execution: Timeframe;
  cfg: TrendlineConfig;
  /**
   * Ids of execution-timeframe lines already known to be broken. A break that
   * existed before the current state was established never fires a trade.
   */
  knownBrokenIds?: Set<string>;
}

function nearestOpposing(state: TopDownState, side: "long" | "short", t: number, price: number): TrendLine | null {
  const wanted = side === "long" ? "bullish" : "bearish";
  let best: TrendLine | null = null;
  let bestGap = Infinity;
  for (const line of state.lines) {
    if (line.type !== wanted || line.state !== "active") continue;
    const v = lineValueAt(line, t);
    if (!Number.isFinite(v) || v <= 0) continue;
    // Long → support must sit below price; short → resistance must sit above.
    const gap = side === "long" ? price - v : v - price;
    if (gap <= 0) continue;
    if (gap < bestGap) { bestGap = gap; best = line; }
  }
  return best;
}

/**
 * Pure price action. No indicators: a confirmed execution-timeframe CLOSE
 * through a trend line is the Action Line break, and the opposing line is the
 * Safety Line, which is also the stop.
 *
 * Bearish line broken upward  → LONG
 * Bullish line broken downward → SHORT
 */
export function evaluateTrendline(input: SignalInput): { signal: TrendlineSignal; state: TopDownState } {
  const { coin, barsByTimeframe, execution, cfg } = input;
  const state = buildTopDown(barsByTimeframe, execution, cfg);
  const execBars = barsByTimeframe[execution] ?? [];
  const lastBar = execBars.at(-1);
  const price = lastBar?.c ?? 0;
  const empty: TrendlineSignal = {
    coin, side: null, timeframe: execution, price,
    actionLine: null, safetyLine: null, initialStop: null,
    confidence: 0, reasons: [], detail: { ladder: ladderFor(execution).join(">") },
  };
  if (!lastBar || execBars.length < 40) {
    return { signal: { ...empty, reasons: ["Waiting for execution-timeframe history"] }, state };
  }

  const execLines = state.byTimeframe[execution] ?? [];
  const lastIndex = execBars.length - 1;
  // Only a break produced by the most recent confirmed close counts.
  const fresh = execLines.filter(l =>
    l.state === "broken" && l.brokenAtIndex === lastIndex && !input.knownBrokenIds?.has(l.id),
  );
  if (fresh.length === 0) {
    const active = execLines.filter(l => l.state === "active").length;
    return { signal: { ...empty, reasons: [`No new Action Line break on ${execution} (${active} active line(s))`] }, state };
  }

  // Prefer the line broken by the largest confirmed close-through.
  const actionLine = fresh
    .map(l => ({ l, v: lineValueAt(l, lastBar.t) }))
    .sort((x, y) => Math.abs(price - y.v) - Math.abs(price - x.v))[0];
  const side: "long" | "short" = actionLine.l.type === "bearish" ? "long" : "short";

  const safety = nearestOpposing(state, side, lastBar.t, price);
  if (!safety) {
    return {
      signal: { ...empty, reasons: [`Action Line broken (${actionLine.l.type}) but no opposing Safety Line — no trade`] },
      state,
    };
  }
  const safetyValue = lineValueAt(safety, lastBar.t);
  const buffer = safetyValue * (cfg.safetyBufferPct / 100);
  const initialStop = side === "long" ? safetyValue - buffer : safetyValue + buffer;
  if ((side === "long" && initialStop >= price) || (side === "short" && initialStop <= price)) {
    return { signal: { ...empty, reasons: ["Safety Line is on the wrong side of price — no trade"] }, state };
  }

  const reasons = [
    `${execution} close ${side === "long" ? "above" : "below"} ${actionLine.l.type} Action Line @ ${actionLine.v.toPrecision(6)}`,
    `Safety Line: ${safety.timeframe} ${safety.type} @ ${safetyValue.toPrecision(6)} (${safety.touches} touches)`,
    `Top-down context: ${ladderFor(execution).join(" → ")}`,
  ];

  return {
    signal: {
      coin, side, timeframe: execution, price,
      actionLine: { type: actionLine.l.type, value: actionLine.v },
      safetyLine: { type: safety.type, value: safetyValue, timeframe: safety.timeframe },
      initialStop,
      // Structure quality, not an indicator score.
      confidence: Math.min(95, 60 + actionLine.l.touches * 5 + safety.touches * 5),
      reasons,
      detail: {
        ladder: ladderFor(execution).join(">"),
        executionTimeframe: execution,
        actionLineType: actionLine.l.type,
        actionLineValue: actionLine.v,
        actionLineTouches: actionLine.l.touches,
        safetyLineType: safety.type,
        safetyLineTimeframe: safety.timeframe,
        safetyLineValue: safetyValue,
        safetyLineTouches: safety.touches,
        initialStop,
        entry: price,
      },
    },
    state,
  };
}

/** Current safety-line value for an open position, used to trail the stop. */
export function currentSafetyLine(state: TopDownState, side: "long" | "short", t: number, price: number): number | null {
  const line = nearestOpposing(state, side, t, price);
  return line ? lineValueAt(line, t) : null;
}
