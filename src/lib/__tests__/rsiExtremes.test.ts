import { describe, expect, it } from "vitest";
import type { Bar } from "../strategy";
import {
  RSI_EXTREMES_DEFAULTS,
  evaluateRsiExtremes,
  shouldExitRsiExtreme,
  rsiExtremeRiskSizedQuantity,
} from "../strategies/rsiExtremes";

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

function barsFromCloses(closes: number[]): Bar[] {
  return closes.map((c, i) => ({ t: T0 + i * HOUR, o: c, h: c * 1.001, l: c * 0.999, c, v: 1000 }));
}

describe("1H RSI Extremes", () => {
  it("does not enter without a prior RSI extreme reversal", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3));
    const sig = evaluateRsiExtremes("TEST", barsFromCloses(closes));
    expect(sig.side).toBeNull();
  });

  it("uses the intended RSI thresholds and risk defaults", () => {
    expect(RSI_EXTREMES_DEFAULTS.oversold).toBe(30);
    expect(RSI_EXTREMES_DEFAULTS.overbought).toBe(70);
    expect(RSI_EXTREMES_DEFAULTS.longExit).toBe(52);
    expect(RSI_EXTREMES_DEFAULTS.shortExit).toBe(48);
    expect(RSI_EXTREMES_DEFAULTS.riskPct).toBe(0.5);
    expect(RSI_EXTREMES_DEFAULTS.stopPct).toBe(1.25);
  });

  it("exits longs above the 50 zone and shorts below it", () => {
    expect(shouldExitRsiExtreme("long", 51.9)).toBe(false);
    expect(shouldExitRsiExtreme("long", 52)).toBe(true);
    expect(shouldExitRsiExtreme("short", 48.1)).toBe(false);
    expect(shouldExitRsiExtreme("short", 48)).toBe(true);
  });

  it("risk sizes against the emergency stop", () => {
    const qty = rsiExtremeRiskSizedQuantity(10_000, 100, 98.75);
    expect(qty).toBeCloseTo(40, 8);
  });
});
