import type { ScalpSide } from "./scalp";

/**
 * Pure sizing / risk math for a new entry.
 * Kept free of network + database access so it can be unit-tested and so the
 * server agent and any harness compute identical order intents.
 */
export interface EntryInputs {
  side: ScalpSide;
  /** Mark / quote price used for sizing. */
  price: number;
  /** Account equity available for this entry (already capped for live allocation). */
  equity: number;
  positionSizePct: number;
  maxExposurePct: number;
  /** User-configured leverage cap. */
  userMaxLeverage: number;
  /** Exchange maximum leverage for this asset. */
  assetMaxLeverage: number;
  /** Sum of notional across open positions. */
  currentExposure: number;
  slPct: number;
  tpPct: number;
  /** Size decimals for the asset (Hyperliquid rounding). */
  szDecimals?: number;
}

export interface EntryIntent {
  ok: boolean;
  reason?: string;
  side: ScalpSide;
  leverage: number;
  notional: number;
  size: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
}

export function buildEntryIntent(i: EntryInputs): EntryIntent {
  const leverage = Math.max(1, Math.floor(Math.min(i.userMaxLeverage, i.assetMaxLeverage)));
  const capNotional = i.equity * (i.maxExposurePct / 100) * i.userMaxLeverage;
  const headroom = capNotional - i.currentExposure;
  const base = {
    side: i.side,
    leverage,
    entryPrice: i.price,
    stopLoss: i.side === "long" ? i.price * (1 - i.slPct / 100) : i.price * (1 + i.slPct / 100),
    takeProfit: i.side === "long" ? i.price * (1 + i.tpPct / 100) : i.price * (1 - i.tpPct / 100),
  };
  if (!(i.price > 0)) return { ...base, ok: false, reason: "invalid price", notional: 0, size: 0 };
  if (headroom <= capNotional * 0.05) return { ...base, ok: false, reason: "exposure cap reached", notional: 0, size: 0 };

  const notional = Math.min(i.equity * (i.positionSizePct / 100) * leverage, headroom);
  let size = notional / i.price;
  if (i.szDecimals !== undefined) size = Number(size.toFixed(i.szDecimals));
  if (!(size > 0)) return { ...base, ok: false, reason: "size rounds to zero", notional, size: 0 };
  return { ...base, ok: true, notional: size * i.price, size };
}
