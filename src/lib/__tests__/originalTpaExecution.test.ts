import { describe, expect, it } from "vitest";
import { ORIGINAL_TREND_PRICE_ACTION_KEY } from "../strategies/originalTrendPriceAction";
import {
  entryIocLimit,
  entryReferencePrice,
  shouldApplyBtcDirectionGate,
} from "../strategies/originalTrendPriceActionExecution";

describe("Original TPA paper/live execution parity", () => {
  it("uses the paper signal price as the live entry reference and IOC ceiling", () => {
    expect(entryReferencePrice(ORIGINAL_TREND_PRICE_ACTION_KEY, 100, 103)).toBe(100);
    expect(entryIocLimit(ORIGINAL_TREND_PRICE_ACTION_KEY, 100)).toBe(100);
  });

  it("does not add the server-only BTC direction veto", () => {
    expect(shouldApplyBtcDirectionGate(ORIGINAL_TREND_PRICE_ACTION_KEY)).toBe(false);
  });

  it("leaves other strategies on their existing server execution path", () => {
    expect(entryReferencePrice("trend-pulse", 100, 103)).toBe(103);
    expect(entryIocLimit("trend-pulse", 100)).toBeUndefined();
    expect(shouldApplyBtcDirectionGate("trend-pulse")).toBe(true);
  });
});
