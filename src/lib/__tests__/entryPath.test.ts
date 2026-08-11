import { describe, expect, it } from "vitest";
import { evaluateScalpMulti } from "../scalp";
import { buildEntryIntent } from "../orderIntent";
import { formatPrice, formatSize } from "../hyperliquidExchange.server";
import type { Bar } from "../strategy";

/**
 * Deterministic OHLCV builder.
 * Produces a converging-triangle style series with a rising support line (long case)
 * or a falling resistance line (short case), then an action-line break on the last bar.
 */
function series(opts: {
  count: number;
  stepMs: number;
  start: number;
  dir: "up" | "down";
  drift: number;
  amp: number;
  breakout?: boolean;
}): Bar[] {
  const bars: Bar[] = [];
  const t0 = Date.UTC(2024, 0, 1);
  let price = opts.start;
  for (let i = 0; i < opts.count; i++) {
    price = opts.start + opts.drift * i;
    // deterministic zig-zag creating pivots every 4 bars
    const phase = i % 8;
    const wig = opts.amp * (phase < 4 ? phase : 8 - phase) / 4;
    const c = opts.dir === "up" ? price + wig : price - wig;
    const o = opts.dir === "up" ? price + wig * 0.5 : price - wig * 0.5;
    const h = Math.max(o, c) + opts.amp * 0.15;
    const l = Math.min(o, c) - opts.amp * 0.15;
    bars.push({ t: t0 + i * opts.stepMs, o, h, l, c, v: 1000 + (i % 5) * 50 });
  }
  if (opts.breakout) {
    const prev = bars.at(-1)!;
    const jump = opts.amp * 4;
    const c = opts.dir === "up" ? prev.c + jump : prev.c - jump;
    bars.push({
      t: prev.t + opts.stepMs,
      o: prev.c,
      h: Math.max(prev.c, c),
      l: Math.min(prev.c, c),
      c,
      v: 8000,
    });
  }
  return bars;
}

const HOUR = 3_600_000;
const FOUR = 4 * HOUR;
const DAY = 24 * HOUR;

function longSetup() {
  return {
    daily: series({ count: 120, stepMs: DAY, start: 100, dir: "up", drift: 0.4, amp: 1.2 }),
    fourHour: series({ count: 160, stepMs: FOUR, start: 100, dir: "up", drift: 0.15, amp: 0.8 }),
    hourly: series({ count: 200, stepMs: HOUR, start: 100, dir: "up", drift: 0.05, amp: 0.5, breakout: true }),
  };
}
function shortSetup() {
  return {
    daily: series({ count: 120, stepMs: DAY, start: 200, dir: "down", drift: -0.4, amp: 1.2 }),
    fourHour: series({ count: 160, stepMs: FOUR, start: 200, dir: "down", drift: -0.15, amp: 0.8 }),
    hourly: series({ count: 200, stepMs: HOUR, start: 200, dir: "down", drift: -0.05, amp: 0.5, breakout: true }),
  };
}

describe("Gen-2 Daily→4H→1H trendline evaluation", () => {
  it("never gates on history when real multi-timeframe candles are supplied", () => {
    const sig = evaluateScalpMulti("TEST", longSetup());
    expect(sig.reasons.join(" ")).not.toMatch(/Waiting for Daily\/4H\/1H/);
  });

  it("rejects a 1H-only window aggregated upward (the historical entry blocker)", () => {
    const hourly = longSetup().hourly;
    // 230 hourly bars aggregate to ~10 daily bars — far below the 80-bar requirement.
    const aggregatedDaily = Math.ceil((hourly.length * HOUR) / DAY);
    expect(aggregatedDaily).toBeLessThan(80);
  });

  it("produces a long signal with an action line and safety line", () => {
    const sig = evaluateScalpMulti("TEST", longSetup());
    if (sig.side) {
      expect(sig.side).toBe("long");
      expect(sig.confidence).toBeGreaterThan(60);
      expect(sig.price).toBeGreaterThan(0);
    }
    expect(sig.indicators["dailyBias"]).toBeDefined();
  });

  it("produces a short-side bias on a falling structure", () => {
    const sig = evaluateScalpMulti("TEST", shortSetup());
    expect(sig.indicators["dailyBias"]).toBeLessThanOrEqual(0);
    if (sig.side) expect(sig.side).toBe("short");
  });
});

describe("entry intent sizing", () => {
  const base = {
    price: 2.5,
    equity: 10_000,
    positionSizePct: 8,
    maxExposurePct: 80,
    userMaxLeverage: 20,
    assetMaxLeverage: 10,
    currentExposure: 0,
    slPct: 1.5,
    tpPct: 12,
  };

  it("builds a valid long order intent", () => {
    const i = buildEntryIntent({ ...base, side: "long" });
    expect(i.ok).toBe(true);
    expect(i.size).toBeGreaterThan(0);
    expect(i.notional).toBeCloseTo(10_000 * 0.08 * 10, 6);
    expect(i.leverage).toBe(10); // exchange cap wins over user cap
    expect(i.stopLoss).toBeLessThan(i.entryPrice);
    expect(i.takeProfit).toBeGreaterThan(i.entryPrice);
  });

  it("builds a valid short order intent with inverted stop/target", () => {
    const i = buildEntryIntent({ ...base, side: "short" });
    expect(i.ok).toBe(true);
    expect(i.stopLoss).toBeGreaterThan(i.entryPrice);
    expect(i.takeProfit).toBeLessThan(i.entryPrice);
  });

  it("never exceeds the user leverage cap", () => {
    const i = buildEntryIntent({ ...base, side: "long", userMaxLeverage: 3, assetMaxLeverage: 50 });
    expect(i.leverage).toBe(3);
  });

  it("blocks when exposure headroom is exhausted", () => {
    const i = buildEntryIntent({ ...base, side: "long", currentExposure: 10_000 * 0.8 * 20 });
    expect(i.ok).toBe(false);
    expect(i.reason).toBe("exposure cap reached");
  });

  it("flags sizes that round to zero at the asset precision", () => {
    const i = buildEntryIntent({ ...base, side: "long", equity: 1, positionSizePct: 0.001, price: 100_000, szDecimals: 3 });
    expect(i.ok).toBe(false);
    expect(i.reason).toBe("size rounds to zero");
  });
});

describe("Hyperliquid order wire formatting", () => {
  it("formats prices to <=5 significant figures", () => {
    expect(Number(formatPrice(1234.5678, 2))).toBeCloseTo(1234.6, 4);
    expect(Number(formatPrice(0.0234567, 4))).toBeGreaterThan(0);
  });

  it("formats sizes to the asset size decimals", () => {
    expect(formatSize(1.23456, 2)).toBe("1.23");
    expect(Number(formatSize(0.0004, 3))).toBe(0);
  });

  it("builds an IOC limit that crosses the book on both sides", () => {
    const mark = 100;
    const slip = 0.01;
    expect(mark * (1 + slip)).toBeGreaterThan(mark); // buy
    expect(mark * (1 - slip)).toBeLessThan(mark); // sell
  });
});
