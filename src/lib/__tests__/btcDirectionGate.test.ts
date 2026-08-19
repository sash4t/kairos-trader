import { describe, expect, it } from "vitest";
import type { Bar } from "../strategy";
import { evaluateBtcDirectionGate } from "../strategies/btcDirectionGate";

const HOUR = 60 * 60 * 1000;

function barsFromCloses(closes: number[]): Bar[] {
  return closes.map((c, i) => ({ t: i * HOUR, o: c, h: c, l: c, c, v: 1 }));
}

describe("BTC 1H direction gate", () => {
  it("allows shorts when EMA20 is below EMA50", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 120 - i * 0.25);
    expect(evaluateBtcDirectionGate("short", barsFromCloses(closes)).allowed).toBe(true);
    expect(evaluateBtcDirectionGate("long", barsFromCloses(closes)).allowed).toBe(false);
  });

  it("allows a short when price is below EMA20 even before the EMA cross", () => {
    const closes = [...Array.from({ length: 58 }, (_, i) => 100 + i * 0.1), 104, 103];
    const result = evaluateBtcDirectionGate("short", barsFromCloses(closes));
    expect(result.ema20).toBeGreaterThan(result.price);
    expect(result.allowed).toBe(true);
  });

  it("reverses the direction requirements for longs", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 80 + i * 0.2);
    expect(evaluateBtcDirectionGate("long", barsFromCloses(closes)).allowed).toBe(true);
    expect(evaluateBtcDirectionGate("short", barsFromCloses(closes)).allowed).toBe(false);
  });

  it("vetoes a trade after a greater-than-1.5% adverse two-hour BTC move", () => {
    const shortCloses = [...Array(57).fill(100), 100, 100.8, 101.6];
    const longCloses = [...Array(57).fill(100), 100, 99.2, 98.4];
    expect(evaluateBtcDirectionGate("short", barsFromCloses(shortCloses)).allowed).toBe(false);
    expect(evaluateBtcDirectionGate("short", barsFromCloses(shortCloses)).reason).toContain("against the short");
    expect(evaluateBtcDirectionGate("long", barsFromCloses(longCloses)).allowed).toBe(false);
    expect(evaluateBtcDirectionGate("long", barsFromCloses(longCloses)).reason).toContain("against the long");
  });

  it("does not veto an exactly 1.5% move", () => {
    const closes = [...Array(57).fill(100), 100, 100.75, 101.5];
    expect(evaluateBtcDirectionGate("short", barsFromCloses(closes)).reason).not.toContain("against the short");
  });

  it("fails closed without enough completed 1H history", () => {
    const result = evaluateBtcDirectionGate("long", barsFromCloses(Array(49).fill(100)));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("history unavailable");
  });
});
