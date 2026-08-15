import { describe, expect, it } from "vitest";
import type { Bar } from "../strategy";
import {
  RSI_EXTREMES_DEFAULTS,
  evaluateRsiExtremes,
  evaluateRsiValues,
  shouldExitRsiExtreme,
  rsiExtremeRiskSizedQuantity,
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

  it("enters short when RSI reverses back below 70 after an overbought extreme", () => {
    const result = evaluateRsiValues([58, 74, 81, 68]);
    expect(result.side).toBe("short");
    expect(result.extreme).toBe(81);
    expect(result.confidence).toBeGreaterThan(RSI_EXTREMES_DEFAULTS.minConfidence);
  });

  it("does not enter without a prior RSI extreme reversal", () => {
    expect(evaluateRsiValues([45, 42, 39, 43]).side).toBeNull();
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3));
    expect(evaluateRsiExtremes("TEST", barsFromCloses(closes)).side).toBeNull();
  });

  it("gives deeper extremes a larger confidence bonus", () => {
    const shallow = evaluateRsiValues([40, 29, 28, 31]);
    const deep = evaluateRsiValues([40, 24, 19, 31]);
    expect(deep.confidence).toBeGreaterThan(shallow.confidence);
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
