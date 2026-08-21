import { ORIGINAL_TREND_PRICE_ACTION_KEY } from "./originalTrendPriceAction";

/**
 * Original TPA paper entries are booked at the completed-candle signal price.
 * Keep the server path on that same reference instead of silently chasing the
 * current mark. Live IOC execution may still improve on this price, but never
 * crosses beyond it.
 */
export function entryReferencePrice(
  strategyKey: string | undefined,
  signalPrice: number,
  quotePrice: number,
): number {
  return strategyKey === ORIGINAL_TREND_PRICE_ACTION_KEY ? signalPrice : quotePrice;
}

/** Paper Original TPA only uses BTC shock protection, not the extra 1H gate. */
export function shouldApplyBtcDirectionGate(strategyKey: string | undefined): boolean {
  return strategyKey !== ORIGINAL_TREND_PRICE_ACTION_KEY;
}

/** Return an explicit IOC limit for Original TPA; other strategies remain market-like. */
export function entryIocLimit(
  strategyKey: string | undefined,
  signalPrice: number,
): number | undefined {
  return strategyKey === ORIGINAL_TREND_PRICE_ACTION_KEY ? signalPrice : undefined;
}
