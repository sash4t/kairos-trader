import { describe, expect, it } from "vitest";
import type { Bar } from "../strategy";
import {
  RSI_EXTREMES_DEFAULTS,
  completedHourlyBars,
  evaluateRsiExtremes,
  evaluateRsiValues,
  rsiTakeProfitHit,
  rsiTakeProfitPrice,
} from "../strategies/rsiExtremes";

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

function barsFromCloses(closes: number[]): Bar[] {
  return closes.map((c, i) => ({ t: T0 + i * HOUR, o: c, h: c * 1.001, l: c * 0.999, c, v: 1000 }));
}

describe("1H RSI Extremes", () => {
  it("enters long when RSI reverses back above 30 after an oversold extreme", () => {
    const result = evaluateRsiValues([45, 27, 24, 32]);
    expect(result.side).toBe("long");
    expect(result.extreme).toBe(24);
    expect(result.confidence).toBeGreaterThan(RSI_EXTREMES_DEFAULTS.minConfidence);
  });

  it("fires only on the first reversal from the trailed oversold low", () => {
    expect(evaluateRsiValues([45, 28, 24, 26]).side).toBe("long");
    expect(evaluateRsiValues([45, 28, 24, 26, 29]).side).toBeNull();
  });

  it("enters short on the first reversal from the highest trailed RSI", () => {
    const result = evaluateRsiValues([58, 72, 81, 79]);
    expect(result.side).toBe("short");
    expect(result.extreme).toBe(81);
    expect(result.confidence).toBeGreaterThan(RSI_EXTREMES_DEFAULTS.minConfidence);
    expect(evaluateRsiValues([58, 72, 81, 79, 76]).side).toBeNull();
  });

  it("scans the full eligible universe every minute", () => {
    expect(RSI_EXTREMES_DEFAULTS.scanEveryMs).toBe(60_000);
    expect(RSI_EXTREMES_DEFAULTS.scanLimit).toBeGreaterThanOrEqual(1_000);
  });

  it("does not enter without a prior RSI extreme reversal", () => {
    expect(evaluateRsiValues([45, 42, 39, 43]).side).toBeNull();
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3));
    expect(evaluateRsiExtremes("TEST", barsFromCloses(closes)).side).toBeNull();
  });

  it("does not reuse an old extreme after the first reversal", () => {
    expect(evaluateRsiValues([24, 31, 33, 35, 37]).side).toBeNull();
  });

  it("gives deeper extremes a larger confidence bonus", () => {
    const shallow = evaluateRsiValues([40, 29, 28, 31]);
    const deep = evaluateRsiValues([40, 24, 19, 31]);
    expect(deep.confidence).toBeGreaterThan(shallow.confidence);
  });

  it("uses the intended RSI thresholds and safety defaults", () => {
    expect(RSI_EXTREMES_DEFAULTS.oversold).toBe(30);
    expect(RSI_EXTREMES_DEFAULTS.overbought).toBe(70);
    expect(RSI_EXTREMES_DEFAULTS.maxLeverage).toBe(3);
  });

  it("excludes an in-progress 1H candle", () => {
    const bars = barsFromCloses([100, 101, 102]);
    const now = bars[2].t + HOUR - 1;
    expect(completedHourlyBars(bars, now)).toHaveLength(2);
  });

  it("applies the configured percentage take profit in both directions", () => {
    expect(rsiTakeProfitPrice("long", 100, 3)).toBe(103);
    expect(rsiTakeProfitPrice("short", 100, 3)).toBe(97);
    expect(rsiTakeProfitHit("long", 103, 103)).toBe(true);
    expect(rsiTakeProfitHit("short", 97, 97)).toBe(true);
    expect(rsiTakeProfitHit("long", 102.99, 103)).toBe(false);
  });
});
