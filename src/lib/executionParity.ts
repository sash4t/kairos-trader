import { isTrendPulseKey } from "./strategies/trendPulse";

export const TREND_PULSE_MAX_CHASE_ATR = 0.15;
export const TREND_PULSE_MAX_CHASE_PCT = 0.25;

type Side = "long" | "short";

export interface EntryExecutionPlan {
  allowed: boolean;
  referencePrice: number;
  limitPrice: number;
  allowance: number;
  adverseMove: number;
  adverseAtr: number;
  adversePct: number;
}

/**
 * Trend Pulse is a momentum breakout, so an exact signal-close limit often
 * misses a valid move. Permit a small adverse chase while rejecting extension.
 * Other strategies retain the strict completed-candle price used by paper.
 */
export function entryExecutionPlan(
  strategyKey: string | undefined,
  side: Side,
  signalPrice: number,
  quotePrice: number,
  atrValue: number,
): EntryExecutionPlan {
  const trendPulse = isTrendPulseKey(strategyKey);
  const validPrices =
    signalPrice > 0 &&
    quotePrice > 0 &&
    Number.isFinite(signalPrice) &&
    Number.isFinite(quotePrice);
  const validAtr = atrValue > 0 && Number.isFinite(atrValue);
  const allowance =
    trendPulse && validAtr
      ? Math.min(
          atrValue * TREND_PULSE_MAX_CHASE_ATR,
          signalPrice * (TREND_PULSE_MAX_CHASE_PCT / 100),
        )
      : 0;
  const adverseMove = side === "long" ? quotePrice - signalPrice : signalPrice - quotePrice;
  const allowed = validPrices && (!trendPulse || (validAtr && adverseMove <= allowance));
  return {
    allowed,
    referencePrice: trendPulse ? quotePrice : signalPrice,
    limitPrice: side === "long" ? signalPrice + allowance : signalPrice - allowance,
    allowance,
    adverseMove,
    adverseAtr: validAtr ? adverseMove / atrValue : Number.NaN,
    adversePct: signalPrice > 0 ? (adverseMove / signalPrice) * 100 : Number.NaN,
  };
}
