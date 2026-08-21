/**
 * Browser paper entries are booked at the completed-candle signal price. Keep
 * every server strategy on that same reference. Live IOC execution may improve
 * on this price, but never crosses beyond it.
 */
export function entryReferencePrice(
  _strategyKey: string | undefined,
  signalPrice: number,
  _quotePrice: number,
): number {
  return signalPrice;
}

/** Cap every live IOC at the price used by paper so live never chases a worse entry. */
export function entryIocLimit(_strategyKey: string | undefined, signalPrice: number): number {
  return signalPrice;
}
