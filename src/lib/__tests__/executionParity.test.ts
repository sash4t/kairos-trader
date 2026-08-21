import { describe, expect, it } from "vitest";
import { ORIGINAL_TREND_PRICE_ACTION_KEY } from "../strategies/originalTrendPriceAction";
import { entryExecutionPlan } from "../executionParity";

describe("paper/live execution parity", () => {
  it.each([ORIGINAL_TREND_PRICE_ACTION_KEY, "rsi-extremes"])(
    "keeps the strict paper signal price for %s",
    (strategy) => {
      const plan = entryExecutionPlan(strategy, "long", 100, 103, 2);
      expect(plan.referencePrice).toBe(100);
      expect(plan.limitPrice).toBe(100);
    },
  );

  it("allows Trend Pulse to chase by the smaller of 0.15 ATR and 0.25%", () => {
    const percentCapped = entryExecutionPlan("trend-pulse", "long", 100, 100.2, 2);
    expect(percentCapped.allowance).toBeCloseTo(0.25);
    expect(percentCapped.allowed).toBe(true);
    expect(percentCapped.referencePrice).toBe(100.2);
    expect(percentCapped.limitPrice).toBeCloseTo(100.25);

    const atrCapped = entryExecutionPlan("trend-pulse", "long", 100, 100.1, 1);
    expect(atrCapped.allowance).toBeCloseTo(0.15);
    expect(atrCapped.allowed).toBe(true);
  });

  it("rejects Trend Pulse after its chase allowance is exceeded", () => {
    const long = entryExecutionPlan("trend-pulse", "long", 100, 100.26, 2);
    const short = entryExecutionPlan("trend-pulse", "short", 100, 99.74, 2);
    expect(long.allowed).toBe(false);
    expect(short.allowed).toBe(false);
  });

  it("allows favorable Trend Pulse price improvement", () => {
    const plan = entryExecutionPlan("trend-pulse", "long", 100, 99.8, 2);
    expect(plan.allowed).toBe(true);
    expect(plan.referencePrice).toBe(99.8);
  });
});
