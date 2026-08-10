export type Side = "long" | "short";

export interface RatchetInput {
  side: Side;
  entry: number;
  currentStop: number;
  /** current value of the opposing (safety) trend line, if one exists */
  safetyLineValue: number | null;
  /** stop sits this far beyond the safety line, percent */
  bufferPct: number;
}

export interface RatchetResult { stop: number; changed: boolean }

/**
 * The Safety Line IS the trailing stop. It may only tighten: a long stop can
 * only rise, a short stop can only fall. Never widened.
 */
export function ratchetSafetyStop(input: RatchetInput): RatchetResult {
  const { side, currentStop, safetyLineValue, bufferPct } = input;
  if (safetyLineValue == null || !Number.isFinite(safetyLineValue) || safetyLineValue <= 0) {
    return { stop: currentStop, changed: false };
  }
  const buffer = safetyLineValue * (bufferPct / 100);
  const candidate = side === "long" ? safetyLineValue - buffer : safetyLineValue + buffer;
  const next = side === "long" ? Math.max(currentStop, candidate) : Math.min(currentStop, candidate);
  return { stop: next, changed: next !== currentStop };
}

/**
 * Exit check. There is no fixed take-profit for this strategy — price
 * violating the safety stop is the only exit.
 */
export function safetyExitReason(side: Side, entry: number, mark: number, stop: number): string | null {
  const violated = side === "long" ? mark <= stop : mark >= stop;
  if (!violated) return null;
  const inProfit = side === "long" ? stop > entry : stop < entry;
  if (inProfit) return "trailing_stop";
  const movedFromInitial = side === "long" ? stop > entry * 0.999 : stop < entry * 1.001;
  return movedFromInitial ? "safety_line" : "stop_loss";
}
