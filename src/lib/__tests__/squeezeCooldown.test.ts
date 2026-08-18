import { describe, expect, it } from "vitest";
import {
  SQUEEZE_DEFAULTS,
  SQUEEZE_STOP_LOSS_EXIT_REASON,
  formatCooldownRemaining,
  squeezeCooldownMap,
} from "../strategies/volatilitySqueezeBreakout";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 18, 15, 0, 0);

describe("Volatility Squeeze stop-loss cooldown", () => {
  it("blocks a coin for four hours after an actual squeeze stop-loss", () => {
    const rows = [{
      coin: "ACE",
      exit_reason: SQUEEZE_STOP_LOSS_EXIT_REASON,
      closed_at: new Date(NOW - HOUR).toISOString(),
    }];
    const cooldown = squeezeCooldownMap(rows, NOW);
    expect(SQUEEZE_DEFAULTS.stopLossCooldownMs).toBe(4 * HOUR);
    expect(cooldown.get("ACE")).toBe(3 * HOUR);
  });

  it("does not block expired stop-losses", () => {
    const rows = [{
      coin: "ACE",
      exit_reason: SQUEEZE_STOP_LOSS_EXIT_REASON,
      closed_at: new Date(NOW - 4 * HOUR).toISOString(),
    }];
    expect(squeezeCooldownMap(rows, NOW).has("ACE")).toBe(false);
  });

  it("does not trigger for non-loss squeeze exits", () => {
    const rows = [
      { coin: "ACE", exit_reason: "squeeze_breakeven_or_trail", closed_at: new Date(NOW - HOUR).toISOString() },
      { coin: "HYPE", exit_reason: "squeeze_stale_exit", closed_at: new Date(NOW - HOUR).toISOString() },
      { coin: "SOL", exit_reason: "squeeze_hard_time_exit", closed_at: new Date(NOW - HOUR).toISOString() },
      { coin: "DOGE", exit_reason: "btc_shock", closed_at: new Date(NOW - HOUR).toISOString() },
    ];
    expect(squeezeCooldownMap(rows, NOW).size).toBe(0);
  });

  it("uses the newest stop-loss when multiple rows exist for the same coin", () => {
    const rows = [
      { coin: "ACE", exit_reason: SQUEEZE_STOP_LOSS_EXIT_REASON, closed_at: new Date(NOW - 3 * HOUR).toISOString() },
      { coin: "ACE", exit_reason: SQUEEZE_STOP_LOSS_EXIT_REASON, closed_at: new Date(NOW - 30 * 60 * 1000).toISOString() },
    ];
    expect(squeezeCooldownMap(rows, NOW).get("ACE")).toBe(3.5 * HOUR);
  });

  it("formats remaining cooldown compactly", () => {
    expect(formatCooldownRemaining(3 * HOUR + 12 * 60 * 1000)).toBe("3h 12m");
    expect(formatCooldownRemaining(25 * 60 * 1000)).toBe("25m");
  });
});
