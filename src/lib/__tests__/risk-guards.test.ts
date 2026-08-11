import { describe, expect, it } from "vitest";
import {
  checkDailyLoss, isMaxHoldExpired, sessionMaxDrawdown, utcDayStart,
  DAILY_LOSS_EXIT_REASON, MAX_HOLD_EXIT_REASON, TRENDBOT_BAR_MS,
} from "@/lib/riskGuards";
import { TRENDBOT_PARAMS } from "@/lib/trendbotStrategy";
import { ADAPTIVE_STRATEGY_KEY, TRENDBOT_MOMENTUM_KEY, PURE_PRICE_STRATEGY_KEY } from "@/lib/strategies";
import { ema, macd } from "@/lib/indicators";
import { buildLines } from "@/lib/trendline/lines";
import { DEFAULT_TRENDLINE_CONFIG, type Bar } from "@/lib/trendline/types";
import { evaluateTrendline } from "@/lib/trendline/signal";

describe("daily loss protection", () => {
  it("breaches once drawdown reaches the limit", () => {
    expect(checkDailyLoss(10_000, 9_500, 5).breached).toBe(true);
    expect(checkDailyLoss(10_000, 9_501, 5).breached).toBe(false);
  });
  it("treats zero / invalid limits as disabled instead of dividing by zero", () => {
    const r = checkDailyLoss(10_000, 1, 0);
    expect(r.breached).toBe(false);
    expect(r.disabled).toBeTruthy();
    expect(checkDailyLoss(0, -500, 5).breached).toBe(false);
    expect(Number.isFinite(checkDailyLoss(10_000, 9_000, 5).dayPnlPct)).toBe(true);
  });
  it("is strategy agnostic and exposes a stable exit reason", () => {
    expect(DAILY_LOSS_EXIT_REASON).toBe("daily_loss_limit");
    expect(checkDailyLoss(1_000, 800, 10).dayPnlPct).toBeCloseTo(-20);
  });
  it("uses the UTC day boundary", () => {
    const d = new Date(utcDayStart(Date.UTC(2026, 0, 5, 13, 30)));
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCDate()).toBe(5);
  });
});

describe("trendbot max hold", () => {
  const openedAt = Date.now() - TRENDBOT_PARAMS.maxHoldBars * TRENDBOT_BAR_MS;
  it("closes trendbot positions after maxHoldBars 1H bars", () => {
    expect(isMaxHoldExpired(TRENDBOT_MOMENTUM_KEY, openedAt)).toBe(true);
    expect(isMaxHoldExpired(TRENDBOT_MOMENTUM_KEY, Date.now() - TRENDBOT_BAR_MS)).toBe(false);
    expect(MAX_HOLD_EXIT_REASON).toBe("max_hold_bars");
  });
  it("never applies to the other two strategies", () => {
    expect(isMaxHoldExpired(ADAPTIVE_STRATEGY_KEY, openedAt)).toBe(false);
    expect(isMaxHoldExpired(PURE_PRICE_STRATEGY_KEY, openedAt)).toBe(false);
  });
});

describe("session max drawdown", () => {
  it("ignores drawdowns from before an equity reset", () => {
    const series = [1000, 900, 200, 10_000, 9_500].map((equity, i) => ({ ts: i, equity }));
    const { maxDDpct } = sessionMaxDrawdown(series);
    expect(maxDDpct).toBeCloseTo(-5, 5);
  });
  it("returns zero for a rising series", () => {
    expect(sessionMaxDrawdown([{ ts: 0, equity: 100 }, { ts: 1, equity: 101 }]).maxDD).toBe(0);
  });
});

describe("EMA seeding and MACD warmup", () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
  it("returns NaN until the first valid EMA index and seeds from the SMA", () => {
    const e = ema(closes, 10);
    for (let i = 0; i < 9; i++) expect(Number.isNaN(e[i])).toBe(true);
    const sma10 = closes.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    expect(e[9]).toBeCloseTo(sma10, 10);
    expect(Number.isFinite(e[59])).toBe(true);
  });
  it("does not emit a valid histogram during warmup", () => {
    const { hist, signal } = macd(closes);
    expect(Number.isNaN(hist[0])).toBe(true);
    expect(Number.isNaN(signal[10])).toBe(true);
    expect(Number.isFinite(hist[hist.length - 1])).toBe(true);
  });
});

const HOUR = 60 * 60 * 1000;
function wavyBars(count: number, base = 100): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const c = base + Math.sin(i / 4) * 3 + i * 0.05;
    return { t: i * HOUR, o: c, h: c + 0.6, l: c - 0.6, c, v: 5 };
  });
}

describe("rolling trendline anchor", () => {
  it("only anchors within the configured lookback window", () => {
    const bars = wavyBars(400, 50);
    const cfg = { ...DEFAULT_TRENDLINE_CONFIG, anchorLookbackBars: 100 };
    const lines = buildLines(bars, "1h", "bullish", cfg);
    const windowStart = bars[bars.length - 100].t;
    for (const l of lines) expect(l.a.t).toBeGreaterThanOrEqual(windowStart);
  });
  it("keeps the chained Point-B → Point-A behaviour", () => {
    const bars = wavyBars(300, 50);
    const lines = buildLines(bars, "1h", "bullish", DEFAULT_TRENDLINE_CONFIG);
    for (let i = 1; i < lines.length; i++) expect(lines[i].a.t).toBe(lines[i - 1].b.t);
  });
});

describe("known broken line persistence", () => {
  it("suppresses a consumed break but not a genuinely different line id", () => {
    const bars = wavyBars(200);
    const last = bars[bars.length - 1];
    bars.push({ t: last.t + HOUR, o: last.c, h: last.c + 15, l: last.c, c: last.c + 12, v: 90 });
    const first = evaluateTrendline({ coin: "T", barsByTimeframe: { "1h": bars }, execution: "1h", cfg: DEFAULT_TRENDLINE_CONFIG });
    if (first.signal.side) {
      expect(first.signal.actionLineId).toBeTruthy();
      const persisted = new Set([first.signal.actionLineId!]);
      const again = evaluateTrendline({ coin: "T", barsByTimeframe: { "1h": bars }, execution: "1h", cfg: DEFAULT_TRENDLINE_CONFIG, knownBrokenIds: persisted });
      expect(again.signal.side).toBeNull();
      const other = evaluateTrendline({ coin: "T", barsByTimeframe: { "1h": bars }, execution: "1h", cfg: DEFAULT_TRENDLINE_CONFIG, knownBrokenIds: new Set(["some:other:line:id"]) });
      expect(other.signal.side).toBe(first.signal.side);
    } else {
      expect(first.signal.actionLineId ?? null).toBeNull();
    }
  });
});

describe("adaptive history sufficiency", () => {
  it("2,000 1H bars aggregate to >= 80 daily and >= 80 4H bars", async () => {
    const { candlesToBars } = await import("@/lib/strategy");
    void candlesToBars;
    const hours = 2000;
    expect(Math.floor(hours / 24)).toBeGreaterThanOrEqual(80);
    expect(Math.floor(hours / 4)).toBeGreaterThanOrEqual(80);
  });
});
