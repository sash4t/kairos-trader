import { describe, expect, it } from "vitest";
import type { Bar } from "../strategy";
import {
  SQUEEZE_DEFAULTS,
  evaluateVolatilitySqueezeBreakout,
  favorablePct,
  squeezeRiskSizedQuantity,
  squeezeTrailStop,
} from "../strategies/volatilitySqueezeBreakout";

const HOUR = 60 * 60 * 1000;
const FIFTEEN = 15 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

function hourlyMomentum(): Bar[] {
  return Array.from({ length: 80 }, (_, i) => {
    const c = 100 + 0.02 * i + 0.3 * Math.sin(i * 1.3);
    return { t: T0 + i * HOUR, o: c - 0.02, h: c + 0.08, l: c - 0.08, c, v: 1_000 };
  });
}

function breakout(volume = 200, compressed = true): Bar[] {
  const bars: Bar[] = Array.from({ length: 39 }, (_, i) => {
    const wave = compressed ? (i % 2 === 0 ? 0.02 : -0.02) : Math.sin(i * 0.8) * 0.7;
    const c = 100 + wave;
    return { t: T0 + i * FIFTEEN, o: 100, h: c + (compressed ? 0.08 : 0.35), l: c - (compressed ? 0.08 : 0.35), c, v: 100 };
  });
  bars.push({ t: T0 + 39 * FIFTEEN, o: 100.1, h: 102.2, l: 100, c: 102, v: volume });
  return bars;
}

describe("Volatility Squeeze Breakout momentum mode", () => {
  it("fires on 4-bar breakout + 1.2x volume + non-extreme RSI even without a squeeze", () => {
    const sig = evaluateVolatilitySqueezeBreakout("TEST", hourlyMomentum(), breakout(200, false));
    expect(sig.side).toBe("long");
    expect(sig.confidence).toBeGreaterThanOrEqual(SQUEEZE_DEFAULTS.minConfidence);
    expect(sig.indicators.volumeRatio).toBeGreaterThanOrEqual(1.2);
    expect(sig.stopLoss).toBeCloseTo(102 * (1 - 0.0045), 8);
    expect(sig.takeProfit).toBeCloseTo(102 * 1.01, 8);
  });

  it("treats a recent squeeze as a confidence booster rather than a gate", () => {
    const withSqueeze = evaluateVolatilitySqueezeBreakout("TEST", hourlyMomentum(), breakout(200, true));
    const withoutSqueeze = evaluateVolatilitySqueezeBreakout("TEST", hourlyMomentum(), breakout(200, false));
    expect(withSqueeze.side).toBe("long");
    expect(withoutSqueeze.side).toBe("long");
    expect(withSqueeze.confidence).toBeGreaterThanOrEqual(withoutSqueeze.confidence);
  });

  it("rejects an otherwise valid breakout below the 1.2x volume floor", () => {
    const sig = evaluateVolatilitySqueezeBreakout("TEST", hourlyMomentum(), breakout(110, false));
    expect(sig.side).toBeNull();
    expect(sig.reasons.join(" ")).toMatch(/volume/i);
  });

  it("uses the momentum-mode scanner defaults", () => {
    expect(SQUEEZE_DEFAULTS.kcMult).toBe(1.8);
    expect(SQUEEZE_DEFAULTS.breakoutLookback).toBe(4);
    expect(SQUEEZE_DEFAULTS.squeezeLookbackBars).toBe(5);
    expect(SQUEEZE_DEFAULTS.minVolumeRatio).toBe(1.2);
  });
});

describe("Volatility Squeeze Breakout risk and exit math", () => {
  it("sizes 1.5% equity risk against a 0.45% price stop", () => {
    const qty = squeezeRiskSizedQuantity(10_000, 100, 99.55);
    expect(qty).toBeCloseTo(333.333333, 5);
    expect(qty * 100).toBeCloseTo(33_333.3333, 3);
  });

  it("measures favorable movement symmetrically", () => {
    expect(favorablePct("long", 100, 100.4)).toBeCloseTo(0.4, 8);
    expect(favorablePct("short", 100, 99.6)).toBeCloseTo(0.4, 8);
  });

  it("trails a runner 0.5% from the best price without loosening the stop", () => {
    expect(squeezeTrailStop("long", 101, 100)).toBeCloseTo(100.495, 6);
    expect(squeezeTrailStop("long", 101, 100.8)).toBeCloseTo(100.8, 6);
    expect(squeezeTrailStop("short", 99, 100)).toBeCloseTo(99.495, 6);
    expect(squeezeTrailStop("short", 99, 99.2)).toBeCloseTo(99.2, 6);
  });
});
