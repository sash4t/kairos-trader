import { describe, expect, it } from "vitest";
import {
  positionRoePct, roeStopTriggered, evaluateRoeStop, normalizeMaxRoeLossPct,
  roePctFromPnl, DEFAULT_MAX_ROE_LOSS_PCT, GLOBAL_ROE_STOP_REASON,
} from "@/lib/roeGuard";

describe("global ROE loss protection", () => {
  it("defaults to -1.0% ROE", () => {
    expect(DEFAULT_MAX_ROE_LOSS_PCT).toBe(1.0);
    expect(normalizeMaxRoeLossPct(undefined)).toBe(1.0);
    expect(normalizeMaxRoeLossPct(0)).toBe(1.0);
    expect(normalizeMaxRoeLossPct(2.5)).toBe(2.5);
  });

  it("computes long ROE with leverage", () => {
    expect(positionRoePct({ side: "long", entry: 100, mark: 99, leverage: 1 })).toBeCloseTo(-1, 10);
    expect(positionRoePct({ side: "long", entry: 100, mark: 99, leverage: 10 })).toBeCloseTo(-10, 10);
    expect(positionRoePct({ side: "long", entry: 100, mark: 101, leverage: 5 })).toBeCloseTo(5, 10);
  });

  it("computes short ROE with leverage", () => {
    expect(positionRoePct({ side: "short", entry: 100, mark: 101, leverage: 1 })).toBeCloseTo(-1, 10);
    expect(positionRoePct({ side: "short", entry: 100, mark: 101, leverage: 20 })).toBeCloseTo(-20, 10);
    expect(positionRoePct({ side: "short", entry: 100, mark: 99, leverage: 3 })).toBeCloseTo(3, 10);
  });

  it("leverage scales the price move needed to hit the limit", () => {
    // 10x: a 0.1% adverse price move is already -1% ROE.
    expect(roeStopTriggered(positionRoePct({ side: "long", entry: 100, mark: 99.9, leverage: 10 }), 1)).toBe(true);
    // 1x: the same move is only -0.1% ROE.
    expect(roeStopTriggered(positionRoePct({ side: "long", entry: 100, mark: 99.9, leverage: 1 }), 1)).toBe(false);
  });

  it("triggers exactly at the threshold", () => {
    expect(roeStopTriggered(-1, 1)).toBe(true);
    expect(roeStopTriggered(-0.999999, 1)).toBe(false);
  });

  it("does not trigger for winning or shallow-losing positions", () => {
    const win = evaluateRoeStop({ side: "long", entry: 100, mark: 105, leverage: 5, maxRoeLossPct: 1 });
    expect(win.triggered).toBe(false);
    expect(win.reason).toBeNull();
    const shallow = evaluateRoeStop({ side: "short", entry: 100, mark: 100.05, leverage: 10, maxRoeLossPct: 1 });
    expect(shallow.roePct).toBeCloseTo(-0.5, 10);
    expect(shallow.triggered).toBe(false);
  });

  it("prefers exchange-reported PnL/margin when available", () => {
    expect(roePctFromPnl(-5, 100)).toBeCloseTo(-5, 10);
    expect(roePctFromPnl(-5, 0)).toBeNull();
    const check = evaluateRoeStop({ side: "long", entry: 100, mark: 100, leverage: 10, unrealizedPnl: -3, marginUsed: 100, maxRoeLossPct: 1 });
    expect(check.roePct).toBeCloseTo(-3, 10);
    expect(check.triggered).toBe(true);
    expect(check.reason).toBe(GLOBAL_ROE_STOP_REASON);
    expect(check.message).toContain("GLOBAL ROE STOP");
  });

  it("is safe with degenerate inputs", () => {
    expect(positionRoePct({ side: "long", entry: 0, mark: 10, leverage: 5 })).toBe(0);
    expect(positionRoePct({ side: "long", entry: 100, mark: 99, leverage: 0 })).toBeCloseTo(-1, 10);
  });
});
