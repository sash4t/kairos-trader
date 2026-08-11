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

/**
 * Pure-price sizing deliberately has no hard-coded 1% account-risk rule.
 * Trendline Strategy - Pure Price runs at exactly 1x leverage; the Safety
 * Line remains the actual protective stop. Position notional is bounded by
 * available equity and the existing exposure headroom.
 */
export function sizeFromRisk(input: SizeInput): SizeResult {
  const feeBuffer = input.entry * ((input.feeBufferPct ?? 0.1) / 100);
  const stopDistance = Math.abs(input.entry - input.stop) + feeBuffer;
  const notionalCap = Math.min(input.maxNotional ?? Infinity, input.equity);
  const base: SizeResult = { size: 0, notional: 0, riskUsd: stopDistance, stopDistance, leverage: 1, ok: false };
  if (!(stopDistance > 0) || !(input.entry > 0) || !(notionalCap > 0)) return { ...base, reason: "invalid entry/stop/equity" };

  let size = notionalCap / input.entry;
  if (input.szDecimals != null) size = Number(size.toFixed(input.szDecimals));
  const notional = size * input.entry;
  if (size <= 0 || notional <= 0) return { ...base, reason: "size rounds to zero" };
  if (input.minSize != null && size < input.minSize) return { ...base, size, notional, reason: "below exchange minimum size" };
  return { size, notional, riskUsd: size * stopDistance, stopDistance, leverage: 1, ok: true };
}
