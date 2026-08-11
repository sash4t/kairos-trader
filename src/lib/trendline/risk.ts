export interface SizeInput {
  equity: number;
  entry: number;
  stop: number;
  szDecimals?: number;
  minSize?: number;
  maxLeverage?: number;
  maxNotional?: number;
  feeBufferPct?: number;
}

export interface SizeResult {
  size: number;
  notional: number;
  riskUsd: number;
  stopDistance: number;
  leverage: number;
  ok: boolean;
  reason?: string;
}

/** Pure-price strategy deliberately has no fixed account-risk percentage. */
export function sizeFromRisk(input: SizeInput): SizeResult {
  const feeBuffer = input.entry * ((input.feeBufferPct ?? 0.1) / 100);
  const stopDistance = Math.abs(input.entry - input.stop) + feeBuffer;
  const maxLeverage = Math.max(1, input.maxLeverage ?? 1);
  const notionalCap = Math.min(input.maxNotional ?? Infinity, input.equity * maxLeverage);
  const base: SizeResult = { size: 0, notional: 0, riskUsd: stopDistance, stopDistance, leverage: 1, ok: false };
  if (!(stopDistance > 0) || !(input.entry > 0) || !(notionalCap > 0)) return { ...base, reason: "invalid entry/stop/equity" };

  // Position size is controlled by the configured notional/leverage cap, not
  // by a hard-coded 1% account-risk rule. The Safety Line remains the stop.
  let notional = notionalCap;
  if (input.szDecimals != null) {
    let size = Number((notional / input.entry).toFixed(input.szDecimals));
    notional = size * input.entry;
    if (size <= 0) return { ...base, reason: "size rounds to zero" };
    if (input.minSize != null && size < input.minSize) return { ...base, size, notional, reason: "below exchange minimum size" };
    return { size, notional, riskUsd: size * stopDistance, stopDistance, leverage: Math.min(maxLeverage, Math.max(1, Math.ceil(notional / input.equity))), ok: true };
  }
  const size = notional / input.entry;
  return { size, notional, riskUsd: size * stopDistance, stopDistance, leverage: Math.min(maxLeverage, Math.max(1, Math.ceil(notional / input.equity))), ok: size > 0 };
}
