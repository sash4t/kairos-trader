import { findPivots } from "./pivots";
import { lineValueAt, type Bar, type LineType, type Pivot, type Timeframe, type TrendLine, type TrendlineConfig } from "./types";

interface Candidate { b: Pivot; slope: number; touches: number }

function evaluateCandidate(bars: Bar[], a: Pivot, b: Pivot, type: LineType, cfg: TrendlineConfig): Candidate | null {
  if (b.i <= a.i) return null;
  const slope = (b.price - a.price) / (b.t - a.t);
  if (type === "bullish" && slope <= 0) return null;
  if (type === "bearish" && slope >= 0) return null;
  let touches = 0;
  for (let i = a.i; i <= b.i; i++) {
    const bar = bars[i];
    const line = lineValueAt({ a, slope }, bar.t);
    const tol = line * (cfg.touchTolerancePct / 100);
    const pen = line * (cfg.penetrationTolerancePct / 100);
    const distance = type === "bullish" ? bar.l - line : line - bar.h;
    if (distance < -pen) return null;
    if (Math.abs(distance) <= tol) touches++;
  }
  if (touches < cfg.minTouches) return null;
  return { b, slope, touches };
}

/**
 * Chained trend-line construction per the top-down price-action method.
 * The initial anchor is selected from significant pivots inside the recent
 * rolling lookback; Point B of each line becomes Point A of the next.
 */
export function buildLines(bars: Bar[], timeframe: Timeframe, type: LineType, cfg: TrendlineConfig, endIndex: number = bars.length - 1): TrendLine[] {
  const { lows, highs } = findPivots(bars, cfg.leftStrength, cfg.rightStrength, endIndex);
  const pivots = type === "bullish" ? lows : highs;
  if (pivots.length < 2) return [];

  const lookbackStart = Math.max(0, endIndex - Math.max(2, cfg.anchorLookbackBars) + 1);
  const recentPivots = pivots.filter(p => p.i >= lookbackStart && p.i <= endIndex);
  if (recentPivots.length < 2) return [];
  let anchor = recentPivots.reduce((best, p) => type === "bullish" ? (p.price < best.price ? p : best) : (p.price > best.price ? p : best));

  const lines: TrendLine[] = [];
  let guard = 0;
  while (guard++ < 64) {
    let best: Candidate | null = null;
    for (const p of pivots) {
      if (p.i <= anchor.i) continue;
      const c = evaluateCandidate(bars, anchor, p, type, cfg);
      if (!c) continue;
      if (!best || c.touches > best.touches || (c.touches === best.touches && c.b.i > best.b.i)) best = c;
    }
    if (!best) break;
    const a = anchor;
    const line: TrendLine = { id: `${timeframe}:${type}:${a.t}:${best.b.t}`, timeframe, type, a, b: best.b, slope: best.slope, touches: best.touches, state: "active", brokenAtIndex: null, brokenAtTime: null };
    for (let i = best.b.i + 1; i <= Math.min(endIndex, bars.length - 1); i++) {
      const bar = bars[i];
      const v = lineValueAt(line, bar.t);
      const broke = type === "bullish" ? bar.c < v : bar.c > v;
      if (broke) { line.state = "broken"; line.brokenAtIndex = i; line.brokenAtTime = bar.t; break; }
    }
    lines.push(line);
    anchor = best.b;
  }
  return lines;
}

export function buildTimeframeLines(bars: Bar[], timeframe: Timeframe, cfg: TrendlineConfig, endIndex?: number): TrendLine[] {
  return [...buildLines(bars, timeframe, "bullish", cfg, endIndex), ...buildLines(bars, timeframe, "bearish", cfg, endIndex)];
}
