import { evaluateSignal, STRATEGY_PARAMS, type Bar } from "./strategy";

/**
 * Signal wrapper for the always-on agent.
 *
 * Now backed by the validated Bollinger(20, 2.5σ) breakout + SMA200 trend
 * filter on 1-hour bars — see evaluateSignal in strategy.ts for the backtest.
 * Exits are a fixed 3% target and 2% stop with a 0.3% trail armed at +0.5%.
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
    family: sig.side ? "bb_breakout" : "none",
    confidence: sig.confidence,
    reasons: sig.reasons,
    price: sig.price,
    atrPct: (sig.indicators["atrPct"] as number) ?? 0,
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
  tpPct: number;          // fixed take-profit, e.g. 2
  slPct: number;          // initial stop, e.g. 1
  trailActivatePct: number; // arm trailing once unrealised gain reaches this, e.g. 1
  trailDistPct: number;   // trail this far behind the best price, e.g. 0.5
}

export interface TrailUpdate { stopLoss: number; trailHigh: number; changed: boolean }

/** Ratchet a trailing stop. Returns the new stop and best-price watermark. */
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

/** Decide whether an open position must be closed at the current mark. */
export function exitReasonFor(side: ScalpSide, mark: number, stopLoss: number, takeProfit: number): string | null {
  if (side === "long") {
    if (mark <= stopLoss) return "stop_loss";
    if (mark >= takeProfit) return "take_profit";
  } else {
    if (mark >= stopLoss) return "stop_loss";
    if (mark <= takeProfit) return "take_profit";
  }
  return null;
}
