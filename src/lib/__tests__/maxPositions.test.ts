import { describe, expect, it } from "vitest";
import { RSI_EXTREMES_KEY } from "../strategies/rsiExtremes";
import { MAX_OPEN_POSITIONS, clampMaxPositions, strategySelectionPatch } from "../scalp";

describe("maximum open positions", () => {
  it("caps every execution setting at 30", () => {
    expect(MAX_OPEN_POSITIONS).toBe(30);
    expect(clampMaxPositions(100)).toBe(30);
    expect(clampMaxPositions(30)).toBe(30);
    expect(clampMaxPositions(0)).toBe(1);
  });

  it("sets the RSI strategy default to 30 positions", () => {
    expect(strategySelectionPatch(RSI_EXTREMES_KEY)).toMatchObject({ max_positions: 30, rsi_risk_pct: 1 });
  });
});
