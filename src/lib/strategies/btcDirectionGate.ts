import { ema } from "../indicators";
import type { Bar } from "../strategy";

export const BTC_DIRECTION_GATE_DEFAULTS = {
  emaFast: 20,
  emaSlow: 50,
  adverseMoveHours: 2,
  adverseMovePct: 1.5,
} as const;

export type BtcDirectionGateSide = "long" | "short";

export interface BtcDirectionGateResult {
  allowed: boolean;
  reason: string;
  price: number;
  ema20: number;
  ema50: number;
  twoHourMovePct: number;
}

/** Evaluate BTC direction using completed 1H bars only. */
export function evaluateBtcDirectionGate(side: BtcDirectionGateSide, completedHourlyBars: Bar[]): BtcDirectionGateResult {
  const closes = completedHourlyBars.map((bar) => bar.c);
  const price = closes.at(-1) ?? Number.NaN;
  const ema20 = ema(closes, BTC_DIRECTION_GATE_DEFAULTS.emaFast).at(-1) ?? Number.NaN;
  const ema50 = ema(closes, BTC_DIRECTION_GATE_DEFAULTS.emaSlow).at(-1) ?? Number.NaN;
  const comparisonPrice = closes.at(-(BTC_DIRECTION_GATE_DEFAULTS.adverseMoveHours + 1)) ?? Number.NaN;
  const twoHourMovePct = Number.isFinite(price) && comparisonPrice > 0
    ? ((price - comparisonPrice) / comparisonPrice) * 100
    : Number.NaN;

  if (completedHourlyBars.length < BTC_DIRECTION_GATE_DEFAULTS.emaSlow
    || !Number.isFinite(price)
    || !Number.isFinite(ema20)
    || !Number.isFinite(ema50)
    || !Number.isFinite(twoHourMovePct)) {
    return { allowed: false, reason: "BTC 1H direction history unavailable", price, ema20, ema50, twoHourMovePct };
  }

  const adverseMove = side === "short"
    ? twoHourMovePct > BTC_DIRECTION_GATE_DEFAULTS.adverseMovePct
    : twoHourMovePct < -BTC_DIRECTION_GATE_DEFAULTS.adverseMovePct;
  if (adverseMove) {
    return {
      allowed: false,
      reason: `BTC moved ${twoHourMovePct.toFixed(2)}% over two completed hours against the ${side}`,
      price, ema20, ema50, twoHourMovePct,
    };
  }

  const directionAligned = side === "short"
    ? ema20 < ema50 || price < ema20
    : ema20 > ema50 || price > ema20;
  if (!directionAligned) {
    return {
      allowed: false,
      reason: `BTC 1H direction is not aligned with the ${side}`,
      price, ema20, ema50, twoHourMovePct,
    };
  }

  return { allowed: true, reason: `BTC 1H direction permits the ${side}`, price, ema20, ema50, twoHourMovePct };
}
