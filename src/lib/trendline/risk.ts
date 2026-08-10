export interface SizeInput {
  equity: number;
  /** account risk per trade, percent of equity */
  riskPct: number;
  entry: number;
  stop: number;
  szDecimals?: number;
  minSize?: number;
  maxLeverage?: number;
  /** notional headroom left under the exposure cap */
  maxNotional?: number;
  /** extra distance allowance for fees + slippage, percent of entry */
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

export const MIN_RISK_PCT = 0.25;
export const MAX_RISK_PCT = 2;
export const DEFAULT_RISK_PCT = 1;

export function clampRiskPct(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_RISK_PCT;
  return Math.min(MAX_RISK_PCT, Math.max(MIN_RISK_PCT, v));
}

/**
 * Size from the entry-to-initial-stop distance so a stop-out always costs the
 * same fraction of equity. Leverage only caps notional; it never changes the
 * account risk percentage.
 */
export function sizeFromRisk(input: SizeInput): SizeResult {
  const riskPct = clampRiskPct(input.riskPct);
  const riskUsd = input.equity * (riskPct / 100);
  const feeBuffer = input.entry * ((input.feeBufferPct ?? 0.1) / 100);
  const stopDistance = Math.abs(input.entry - input.stop) + feeBuffer;
  const base: SizeResult = { size: 0, notional: 0, riskUsd, stopDistance, leverage: 1, ok: false };
  if (!(stopDistance > 0) || !(input.entry > 0) || !(riskUsd > 0)) {
    return { ...base, reason: "invalid entry/stop/equity" };
  }
  let size = riskUsd / stopDistance;
  const maxLeverage = Math.max(1, input.maxLeverage ?? 1);
  const notionalCap = Math.min(
    input.maxNotional ?? Infinity,
    input.equity * maxLeverage,
  );
  if (size * input.entry > notionalCap) size = notionalCap / input.entry;
  if (input.szDecimals != null) size = Number(size.toFixed(input.szDecimals));
  const notional = size * input.entry;
  if (size <= 0 || notional <= 0) return { ...base, reason: "size rounds to zero" };
  if (input.minSize != null && size < input.minSize) return { ...base, size, notional, reason: "below exchange minimum size" };
  const leverage = Math.min(maxLeverage, Math.max(1, Math.ceil(notional / input.equity)));
  return { size, notional, riskUsd, stopDistance, leverage, ok: true };
}
