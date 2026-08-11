export interface SizeResult {
  size: number;
  notional: number;
  stopDistance: number;
  leverage: number;
  ok: boolean;
  reason?: string;
}

export interface MaxLeverageSizeInput {
  /** Equity the strategy may allocate from (already capped by live_max_alloc_usd). */
  equity: number;
  entry: number;
  /** Protective Safety Line stop — used for reporting, never to derive size. */
  stop: number;
  /** The market's own maximum leverage from Hyperliquid asset metadata. */
  marketMaxLeverage: number;
  /** Remaining portfolio exposure headroom in notional USD. */
  maxNotional?: number;
  szDecimals?: number;
  minSize?: number;
  /** Margin safety buffer so the position is not opened at literally 100% margin. */
  marginBufferPct?: number;
}

/** Exchange maximum leverage for the asset, floored at 1x and rounded down. */
export function resolveMaxLeverage(marketMaxLeverage: number): number {
  if (!Number.isFinite(marketMaxLeverage) || marketMaxLeverage < 1) return 1;
  return Math.floor(marketMaxLeverage);
}

/**
 * Trendline Strategy - Pure Price sizing.
 *
 * There is deliberately NO 1% account-risk rule and NO forced 1x leverage:
 * the position is opened at the market's maximum available Hyperliquid
 * leverage, bounded by equity, the portfolio exposure headroom and a margin
 * buffer. The Safety Line remains the actual protective stop.
 */
export function sizeAtMaxLeverage(input: MaxLeverageSizeInput): SizeResult {
  const leverage = resolveMaxLeverage(input.marketMaxLeverage);
  const buffer = Math.min(Math.max(input.marginBufferPct ?? 2, 0), 50) / 100;
  const stopDistance = Math.abs(input.entry - input.stop);
  const base: SizeResult = { size: 0, notional: 0, stopDistance, leverage, ok: false };
  if (!(input.entry > 0) || !(input.equity > 0)) return { ...base, reason: "invalid entry/equity" };

  const capacity = input.equity * leverage * (1 - buffer);
  const notionalCap = Math.min(capacity, input.maxNotional ?? Infinity);
  if (!(notionalCap > 0)) return { ...base, reason: "no exposure headroom" };

  let size = notionalCap / input.entry;
  if (input.szDecimals != null) size = Number(size.toFixed(input.szDecimals));
  const notional = size * input.entry;
  if (size <= 0 || notional <= 0) return { ...base, reason: "size rounds to zero" };
  if (input.minSize != null && size < input.minSize) return { ...base, size, notional, reason: "below exchange minimum size" };
  return { size, notional, stopDistance, leverage, ok: true };
}
