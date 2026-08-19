import { describe, expect, it } from "vitest";
import type { Bar } from "../strategy";
import {
  SQUEEZE_DEFAULTS,
  evaluateVolatilitySqueezeBreakout,
  favorablePct,
  squeezeProfitLockStop,
  squeezeRiskSizedQuantity,
  squeezeTrailStop,
} from "../strategies/volatilitySqueezeBreakout";

const HOUR = 60 * 60 * 1000;
const FIFTEEN = 15 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

function hourlyLong(): Bar[] {
  return Array.from({ length: 80 }, (_, i) => {
    const c = 100 + 0.025 * i + 0.22 * Math.sin(i * 1.1);
    return { t: T0 + i * HOUR, o: c - 0.02, h: c + 0.08, l: c - 0.08, c, v: 1_000 };
  });
}

function hourlyShort(): Bar[] {
  return Array.from({ length: 80 }, (_, i) => {
    const c = 100 - 0.025 * i + 0.22 * Math.sin(i * 1.1);
    return { t: T0 + i * HOUR, o: c + 0.02, h: c + 0.08, l: c - 0.08, c, v: 1_000 };
  });
}

function longWithFallingRsi(): Bar[] {
  const bars = hourlyLong();
  const prev = bars.at(-2)!.c;
  bars[bars.length - 1] = { ...bars.at(-1)!, o: prev, h: prev + 0.03, l: prev - 0.20, c: prev - 0.15 };
  return bars;
}

function longWithWrongEma(): Bar[] {
  return hourlyShort();
}

function makeLongBreakout(volume = 160, compressed = true): Bar[] {
  const bars: Bar[] = Array.from({ length: 39 }, (_, i) => {
    const wave = compressed ? (i % 2 === 0 ? 0.02 : -0.02) : Math.sin(i * 0.75) * 0.75;
    const c = 100 + wave;
    const halfRange = compressed ? 0.08 : 0.05;
    return { t: T0 + i * FIFTEEN, o: 100, h: c + halfRange, l: c - halfRange, c, v: 100 };
  });
  bars.push({ t: T0 + 39 * FIFTEEN, o: 100.1, h: 102.2, l: 100, c: 102, v: volume });
  return bars;
}

function makeShortBreakout(volume = 160): Bar[] {
  const bars: Bar[] = Array.from({ length: 39 }, (_, i) => {
    const c = 100 + (i % 2 === 0 ? 0.02 : -0.02);
    return { t: T0 + i * FIFTEEN, o: 100, h: c + 0.08, l: c - 0.08, c, v: 100 };
  });
  bars.push({ t: T0 + 39 * FIFTEEN, o: 99.9, h: 100, l: 97.8, c: 98, v: volume });
  return bars;
}

function signalNow(bars: Bar[], offsetMs = 60_000): number {
  return bars.at(-1)!.t + FIFTEEN + offsetMs;
}

describe("Volatility Squeeze Breakout Original Plus", () => {
  it("requires a recent real squeeze and accepts 1.5x+ volume", () => {
    const bars = makeLongBreakout(160, true);
    const sig = evaluateVolatilitySqueezeBreakout("TEST", hourlyLong(), bars, signalNow(bars));
    expect(sig.side).toBe("long");
    expect(sig.indicators.priorSqueezed).toBe(1);
    expect(sig.indicators.squeezeAge).toBeGreaterThanOrEqual(1);
    expect(sig.indicators.squeezeAge).toBeLessThanOrEqual(3);
    expect(sig.indicators.requiredVolumeRatio).toBe(1.5);
    expect(sig.indicators.volumeRatio).toBeGreaterThanOrEqual(1.5);
    expect(sig.indicators.bbExpanding).toBe(1);
    expect(sig.indicators.emaAligned).toBe(1);
    expect(sig.indicators.rsiRangeOk).toBe(1);
    expect(sig.indicators.rsiSlopeOk).toBe(1);
    expect(sig.confidence).toBeGreaterThanOrEqual(SQUEEZE_DEFAULTS.minConfidence);
  });

  it("rejects a momentum breakout with no recent squeeze", () => {
    const bars = makeLongBreakout(300, false);
    const sig = evaluateVolatilitySqueezeBreakout("TEST", hourlyLong(), bars, signalNow(bars));
    expect(sig.side).toBeNull();
    expect(sig.indicators.priorSqueezed).toBe(0);
    expect(sig.reasons.join(" ")).toMatch(/No Bollinger-inside-Keltner squeeze/i);
  });

  it("rejects volume below 1.5x even with a valid squeeze", () => {
    const bars = makeLongBreakout(140, true);
    const sig = evaluateVolatilitySqueezeBreakout("TEST", hourlyLong(), bars, signalNow(bars));
    expect(sig.side).toBeNull();
    expect(sig.reasons.join(" ")).toMatch(/1\.5x minimum/i);
  });

  it("uses a 6-candle structural breakout", () => {
    expect(SQUEEZE_DEFAULTS.breakoutLookback).toBe(6);
    expect(SQUEEZE_DEFAULTS.squeezeLookbackBars).toBe(3);
    expect(SQUEEZE_DEFAULTS.kcMult).toBe(1.8);
    expect(SQUEEZE_DEFAULTS.minVolumeRatio).toBe(1.5);
    expect(SQUEEZE_DEFAULTS.minConfidence).toBe(70);
  });

  it("rejects a long when 1H price is below EMA20", () => {
    const bars = makeLongBreakout(180, true);
    const sig = evaluateVolatilitySqueezeBreakout("TEST", longWithWrongEma(), bars, signalNow(bars));
    expect(sig.side).toBeNull();
    expect(sig.indicators.emaAligned).toBe(0);
    expect(sig.reasons.join(" ")).toMatch(/wrong side of EMA20/i);
  });

  it("rejects a long when RSI slope turns down", () => {
    const bars = makeLongBreakout(180, true);
    const sig = evaluateVolatilitySqueezeBreakout("TEST", longWithFallingRsi(), bars, signalNow(bars));
    expect(sig.side).toBeNull();
    expect(sig.indicators.rsiSlope).toBeLessThanOrEqual(0);
    expect(sig.reasons.join(" ")).toMatch(/RSI slope/i);
  });

  it("accepts a short with EMA direction and falling RSI", () => {
    const bars = makeShortBreakout(180);
    const sig = evaluateVolatilitySqueezeBreakout("TEST", hourlyShort(), bars, signalNow(bars));
    expect(sig.side).toBe("short");
    expect(sig.indicators.emaAligned).toBe(1);
    expect(sig.indicators.rsiRangeOk).toBe(1);
    expect(sig.indicators.rsiSlopeOk).toBe(1);
  });

  it("expires a completed 15m breakout after the first 5-minute scanner window", () => {
    const bars = makeLongBreakout(180, true);
    const staleNow = bars.at(-1)!.t + FIFTEEN + SQUEEZE_DEFAULTS.signalFreshMs;
    const sig = evaluateVolatilitySqueezeBreakout("TEST", hourlyLong(), bars, staleNow);
    expect(sig.side).toBeNull();
    expect(sig.indicators.signalFresh).toBe(0);
    expect(sig.reasons.join(" ")).toMatch(/stale/i);
  });

  it("blocks repeated same-direction breakout bars for 30 minutes", () => {
    const bars = makeLongBreakout(180, true);
    bars[38] = { ...bars[38], o: 100.6, l: 100.5, c: 101.4, h: 101.5 };
    const sig = evaluateVolatilitySqueezeBreakout("TEST", hourlyLong(), bars, signalNow(bars));
    expect(sig.side).toBeNull();
    expect(sig.indicators.sameDirectionRecently).toBe(1);
    expect(sig.reasons.join(" ")).toMatch(/same-direction breakout blocked/i);
  });

  it("keeps the 4-hour stop-loss cooldown default", () => {
    expect(SQUEEZE_DEFAULTS.stopLossCooldownMs).toBe(4 * 60 * 60 * 1000);
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

  it("locks a minimum profit and ratchets the pre-partial stop in both directions", () => {
    expect(squeezeProfitLockStop("long", 100, 100.19, 99.55)).toBe(99.55);
    expect(squeezeProfitLockStop("long", 100, 100.2, 99.55)).toBeCloseTo(100.05, 8);
    expect(squeezeProfitLockStop("long", 100, 100.5, 100.05)).toBeCloseTo(100.299, 8);
    expect(squeezeProfitLockStop("long", 100, 100.3, 100.299)).toBeCloseTo(100.299, 8);

    expect(squeezeProfitLockStop("short", 100, 99.8, 100.45)).toBeCloseTo(99.95, 8);
    expect(squeezeProfitLockStop("short", 100, 99.5, 99.95)).toBeCloseTo(99.699, 8);
    expect(squeezeProfitLockStop("short", 100, 99.7, 99.699)).toBeCloseTo(99.699, 8);
  });
});
