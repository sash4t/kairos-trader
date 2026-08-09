import { evaluateSignal, STRATEGY_PARAMS, type Bar } from "./strategy";

/**
 * Signal wrapper for the always-on agent.
 * Backed by the TrendBot EMA + RSI + MACD confirmation strategy on 1-hour
 * Hyperliquid perpetual bars, mirrored for long and short entries.
 */
export type ScalpSide = "long" | "short";

export interface ScalpSignal {
  coin: string;
  side: ScalpSide | null;
  family: string;
  confidence: number;
  reasons: string[];
  price: number;
  atrPct: number;
  indicators: Record<string, number>;
}

export function evaluateScalp(coin: string, bars: Bar[]): ScalpSignal {
  const sig = evaluateSignal(coin, bars);
  return {
    coin,
    side: sig.side,
    family: sig.side ? "trendbot_momentum" : "none",
    confidence: sig.confidence,
    reasons: sig.reasons,
    price: sig.price,
    atrPct: sig.indicators["atrPct"] ?? 0,
    indicators: sig.indicators,
  };
}

export const DEFAULT_EXITS = {
  tpPct: STRATEGY_PARAMS.tpPct,
  slPct: STRATEGY_PARAMS.slPct,
  trailActivatePct: STRATEGY_PARAMS.trailActivatePct,
  trailDistPct: STRATEGY_PARAMS.trailDistPct,
};

export interface ExitParams {
  tpPct: number;
  slPct: number;
  trailActivatePct: number;
  trailDistPct: number;
}

export interface TrailUpdate { stopLoss: number; trailHigh: number; changed: boolean }

/** Ratchet a trailing stop in the correct direction for long or short perps. */
export function updateTrail(
  side: ScalpSide, entry: number, mark: number, stopLoss: number,
  trailHigh: number | null, p: ExitParams,
): TrailUpdate {
  const best = side === "long"
    ? Math.max(trailHigh ?? entry, mark)
    : Math.min(trailHigh ?? entry, mark);
  const gainPct = side === "long" ? ((best - entry) / entry) * 100 : ((entry - best) / entry) * 100;
  let stop = stopLoss;
  if (gainPct >= p.trailActivatePct) {
    const candidate = side === "long"
      ? best * (1 - p.trailDistPct / 100)
      : best * (1 + p.trailDistPct / 100);
    stop = side === "long" ? Math.max(stopLoss, candidate) : Math.min(stopLoss, candidate);
  }
  return { stopLoss: stop, trailHigh: best, changed: stop !== stopLoss || best !== trailHigh };
}

export function exitReasonFor(
  side: ScalpSide, mark: number, stopLoss: number, takeProfit: number, entry?: number,
): string | null {
  const inProfit = entry != null && (side === "long" ? stopLoss > entry : stopLoss < entry);
  const stopLabel = inProfit ? "trailing_stop" : "stop_loss";
  if (side === "long") {
    if (mark <= stopLoss) return stopLabel;
    if (mark >= takeProfit) return "take_profit";
  } else {
    if (mark >= stopLoss) return stopLabel;
    if (mark <= takeProfit) return "take_profit";
  }
  return null;
}
