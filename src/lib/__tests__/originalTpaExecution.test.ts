import { describe, expect, it } from "vitest";
import { ORIGINAL_TREND_PRICE_ACTION_KEY } from "../strategies/originalTrendPriceAction";
import { entryIocLimit, entryReferencePrice } from "../executionParity";

describe("paper/live execution parity", () => {
  it.each([ORIGINAL_TREND_PRICE_ACTION_KEY, "trend-pulse", "rsi-extremes"])(
    "uses the paper signal price and IOC ceiling for %s",
    (strategy) => {
      expect(entryReferencePrice(strategy, 100, 103)).toBe(100);
      expect(entryIocLimit(strategy, 100)).toBe(100);
    },
  );
});
