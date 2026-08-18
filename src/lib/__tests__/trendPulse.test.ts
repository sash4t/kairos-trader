import { describe, expect, it } from "vitest";
import type { Bar } from "../strategy";
import { TREND_PULSE_DEFAULTS, evaluateTrendPulse, trendPulseConfidence, trendPulseThresholds } from "../strategies/trendPulse";

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
  it("uses wider aligned RSI gates and lower aligned volume", () => {
    expect(trendPulseThresholds("bull", "long")).toMatchObject({ trendAligned: true, oversold: 30, requiredVolumeRatio: 1.5 });
    expect(trendPulseThresholds("bear", "short")).toMatchObject({ trendAligned: true, overbought: 70, requiredVolumeRatio: 1.5 });
    expect(trendPulseThresholds("neutral", "long")).toMatchObject({ trendAligned: false, oversold: 28, overbought: 72, requiredVolumeRatio: 1.8 });
  });
  it("lets every valid trend-aligned setup clear the confidence gate", () => {
    expect(trendPulseConfidence(true, { min: 30, max: 30 }, 1.5, 10, 2)).toBe(TREND_PULSE_DEFAULTS.minConfidence);
  });
  it("uses three 1H bars and ten 15m bars as setup windows", () => {
    expect(TREND_PULSE_DEFAULTS).toMatchObject({ rsiSetupWindowBars: 3, squeezeSetupWindowBars: 10 });
  });
});
