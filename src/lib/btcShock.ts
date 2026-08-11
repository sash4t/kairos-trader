import type { Bar } from "./trendline/types";

export type ShockDirection = "drop" | "spike";

export interface BtcShockConfig {
  enabled: boolean;
  /** Absolute move, in percent, that counts as a shock. */
  thresholdPct: number;
  /** Look-back window in minutes. */
  windowMin: number;
}

export const DEFAULT_BTC_SHOCK: BtcShockConfig = { enabled: true, thresholdPct: 1.5, windowMin: 15 };

export interface BtcShockResult {
  direction: ShockDirection | null;
  movePct: number;
  from: number;
  to: number;
}

/**
 * Detects a sudden Bitcoin move over the configured window.
 * A drop means every open LONG must be flattened immediately; a spike means
 * every open SHORT must be flattened. Pure function so paper and live share
 * exactly the same behaviour.
 */
export function detectBtcShock(bars: Bar[], cfg: BtcShockConfig, now: number = Date.now()): BtcShockResult {
  const empty: BtcShockResult = { direction: null, movePct: 0, from: 0, to: 0 };
  if (!cfg.enabled || bars.length < 2) return empty;
  const windowMs = Math.max(1, cfg.windowMin) * 60_000;
  const cutoff = now - windowMs;
  const window = bars.filter((b) => b.t >= cutoff);
  const ref = (window.length >= 2 ? window[0] : bars[bars.length - 2]);
  const latest = bars[bars.length - 1];
  if (!ref || !latest || !(ref.c > 0)) return empty;
  const movePct = ((latest.c - ref.c) / ref.c) * 100;
  const threshold = Math.abs(cfg.thresholdPct);
  const direction: ShockDirection | null = movePct <= -threshold ? "drop" : movePct >= threshold ? "spike" : null;
  return { direction, movePct, from: ref.c, to: latest.c };
}

/** The position side that must be emergency-closed for a given shock. */
export function sideToFlatten(direction: ShockDirection): "long" | "short" {
  return direction === "drop" ? "long" : "short";
}
