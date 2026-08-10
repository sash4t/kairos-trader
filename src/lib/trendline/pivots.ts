import type { Bar, Pivot } from "./types";

/**
 * Confirmed swing pivots. A pivot at index i is only emitted once its
 * `right` confirmation candles have closed at or before `endIndex`, so the
 * result never repaints and never looks ahead of the evaluation point.
 */
export function findPivots(
  bars: Bar[],
  left: number,
  right: number,
  endIndex: number = bars.length - 1,
): { lows: Pivot[]; highs: Pivot[] } {
  const lows: Pivot[] = [];
  const highs: Pivot[] = [];
  const last = Math.min(endIndex, bars.length - 1);
  for (let i = left; i + right <= last; i++) {
    const bar = bars[i];
    let isLow = true;
    let isHigh = true;
    for (let j = 1; j <= left && (isLow || isHigh); j++) {
      if (bars[i - j].l <= bar.l) isLow = false;
      if (bars[i - j].h >= bar.h) isHigh = false;
    }
    for (let j = 1; j <= right && (isLow || isHigh); j++) {
      if (bars[i + j].l <= bar.l) isLow = false;
      if (bars[i + j].h >= bar.h) isHigh = false;
    }
    if (isLow) lows.push({ i, t: bar.t, price: bar.l, kind: "low" });
    if (isHigh) highs.push({ i, t: bar.t, price: bar.h, kind: "high" });
  }
  return { lows, highs };
}
