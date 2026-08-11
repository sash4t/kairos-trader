/**
 * GLOBAL hard ROE loss protection.
 *
 * Strategy-independent emergency exit: whenever an open position's return on
 * equity (margin) drops to or below `-maxRoeLossPct`, the position is flattened
 * immediately — before any strategy-specific stop/trailing logic and before new
 * entries are considered. It never replaces the ATR stop or the Pure Price
 * Safety Line; whichever stop triggers first closes the position.
 */

export type PositionSide = "long" | "short";

/** Default maximum tolerated loss, expressed in ROE percent. */
export const DEFAULT_MAX_ROE_LOSS_PCT = 1.0;

export const GLOBAL_ROE_STOP_REASON = "global_roe_stop";

export interface RoeInput {
  side: PositionSide;
  entry: number;
  mark: number;
  /** Actual position leverage (exchange-reported when live, stored value in paper). */
  leverage: number;
}

/**
 * ROE percent for a position.
 * long:  ((mark - entry) / entry) * leverage * 100
 * short: ((entry - mark) / entry) * leverage * 100
 */
export function positionRoePct({ side, entry, mark, leverage }: RoeInput): number {
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(mark)) return 0;
  const lev = Number.isFinite(leverage) && leverage > 0 ? leverage : 1;
  const move = side === "long" ? (mark - entry) / entry : (entry - mark) / entry;
  return move * lev * 100;
}

/** ROE percent derived from exchange-reported unrealised PnL and margin used. */
export function roePctFromPnl(unrealizedPnl: number, marginUsed: number): number | null {
  if (!Number.isFinite(unrealizedPnl) || !Number.isFinite(marginUsed) || marginUsed <= 0) return null;
  return (unrealizedPnl / marginUsed) * 100;
}

export function normalizeMaxRoeLossPct(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_ROE_LOSS_PCT;
  return Math.min(100, n);
}

/** True when ROE has reached (or passed) the negative threshold. */
export function roeStopTriggered(roePct: number, maxRoeLossPct: unknown = DEFAULT_MAX_ROE_LOSS_PCT): boolean {
  const limit = normalizeMaxRoeLossPct(maxRoeLossPct);
  // Small epsilon so float noise (e.g. -0.9999999999) still trips an exact -1.00% limit.
  return roePct <= -limit + 1e-9;
}

export interface RoeCheck {
  roePct: number;
  triggered: boolean;
  reason: string | null;
  message: string;
}

/** Full evaluation used by both the browser paper engine and the server agent. */
export function evaluateRoeStop(
  input: RoeInput & { maxRoeLossPct?: unknown; unrealizedPnl?: number; marginUsed?: number },
): RoeCheck {
  const exchangeRoe = input.unrealizedPnl != null && input.marginUsed != null
    ? roePctFromPnl(input.unrealizedPnl, input.marginUsed)
    : null;
  const roePct = exchangeRoe ?? positionRoePct(input);
  const triggered = roeStopTriggered(roePct, input.maxRoeLossPct);
  const limit = normalizeMaxRoeLossPct(input.maxRoeLossPct);
  return {
    roePct,
    triggered,
    reason: triggered ? GLOBAL_ROE_STOP_REASON : null,
    message: `GLOBAL ROE STOP ${roePct.toFixed(2)}% (limit -${limit.toFixed(2)}%) · ${input.side.toUpperCase()} lev ${input.leverage}x · entry ${input.entry} · mark ${input.mark}`,
  };
}
