import type { ScalpSide } from "./scalp";

export interface EntryInputs {
  side: ScalpSide;
  price: number;
  equity: number;
  positionSizePct: number;
  maxExposurePct: number;
  userMaxLeverage: number;
  assetMaxLeverage: number;
  currentExposure: number;
  slPct: number;
  tpPct: number;
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
  const capNotional = i.equity * (i.maxExposurePct / 100) * leverage;
  const headroom = capNotional - i.currentExposure;
  const base = {
    side: i.side,
    leverage,
    entryPrice: i.price,
    stopLoss: i.side === "long" ? i.price * (1 - i.slPct / 100) : i.price * (1 + i.slPct / 100),
    takeProfit: i.side === "long" ? i.price * (1 + i.tpPct / 100) : i.price * (1 - i.tpPct / 100),
  };
  if (!(i.price > 0) || !Number.isFinite(i.price)) return { ...base, ok: false, reason: "invalid price", notional: 0, size: 0 };
  if (!(i.equity > 0) || !Number.isFinite(i.equity)) return { ...base, ok: false, reason: "invalid equity", notional: 0, size: 0 };
  if (!(i.positionSizePct > 0) || !Number.isFinite(i.positionSizePct)) return { ...base, ok: false, reason: "invalid position size", notional: 0, size: 0 };
  if (!(i.maxExposurePct > 0) || !Number.isFinite(i.maxExposurePct)) return { ...base, ok: false, reason: "invalid exposure cap", notional: 0, size: 0 };
  if (headroom <= 0) return { ...base, ok: false, reason: "exposure cap reached", notional: 0, size: 0 };

  const notional = Math.min(i.equity * (i.positionSizePct / 100) * leverage, headroom);
  let size = notional / i.price;
  if (i.szDecimals !== undefined) size = Number(size.toFixed(i.szDecimals));
  if (!(size > 0) || !Number.isFinite(size)) return { ...base, ok: false, reason: "size rounds to zero", notional, size: 0 };
  return { ...base, ok: true, notional: size * i.price, size };
}
