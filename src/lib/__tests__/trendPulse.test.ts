import { describe, expect, it } from "vitest";
import type { Bar } from "../strategy";
import { TREND_PULSE_DEFAULTS, evaluateTrendPulse } from "../strategies/trendPulse";

const bars = (count: number, start: number, step: number, minutes: number): Bar[] => Array.from({ length: count }, (_, i) => ({ t: i * minutes * 60_000, o: start + step * i, h: start + step * i + 0.2, l: start + step * i - 0.2, c: start + step * i, v: 100 }));

describe("Trend-Pulse", () => {
  it("publishes the requested risk defaults", () => {
    expect(TREND_PULSE_DEFAULTS).toMatchObject({ riskPct: 1.5, maxLeverage: 5, minConfidence: 75, scanLimit: 50 });
  });
  it("waits for all three timeframe histories", () => {
    const signal = evaluateTrendPulse("TEST", bars(10, 100, 1, 240), bars(10, 100, 1, 60), bars(10, 100, 1, 15));
    expect(signal.side).toBeNull();
    expect(signal.reasons[0]).toContain("Waiting");
  });
});
