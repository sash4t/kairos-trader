import { evaluateMultiTimeframeSignal, type Bar } from "./strategy";
import { evaluateTrendBotSignal, TRENDBOT_STRATEGY_KEY } from "./trendbotStrategy";
import { TRENDLINE_STRATEGY_KEY } from "./trendline/types";

export type ScalpSide = "long" | "short";
export type StrategyKey = typeof TRENDLINE_STRATEGY_KEY | typeof TRENDBOT_STRATEGY_KEY;

export interface ScalpSignal {
  coin: string; side: ScalpSide | null; family: string; confidence: number; reasons: string[]; price: number; atrPct: number; indicators: Record<string, number>;
  actionLine?: number; safetyLine?: number;
}

export const STRATEGY_OPTIONS = [
  {
    key: TRENDLINE_STRATEGY_KEY,
    name: "Trendline Strategy - Pure Price",
    description: "Pure price action: Monthly → Weekly → Daily → 4H → 1H top-down trend lines, Action Line breaks and opposing Safety Line trailing stop. No indicators or fixed take-profit.",
  },
  {
    key: TRENDBOT_STRATEGY_KEY,
    name: "TrendBot Momentum",
    description: "EMA20/50 + RSI14 + MACD momentum, long and short.",
  },
] as const;

function aggregateBars(bars: Bar[], intervalMs: number): Bar[] {
  const groups = new Map<number, Bar>();
  for (const b of bars) {
    const key = Math.floor(b.t / intervalMs) * intervalMs;
    const existing = groups.get(key);
    if (!existing) groups.set(key, { t:key, o:b.o, h:b.h, l:b.l, c:b.c, v:b.v });
    else { existing.h=Math.max(existing.h,b.h); existing.l=Math.min(existing.l,b.l); existing.c=b.c; existing.v+=b.v; }
  }
  return [...groups.values()].sort((a,b)=>a.t-b.t);
}

export function evaluateScalp(coin: string, bars: Bar[], strategyKey: StrategyKey = TRENDLINE_STRATEGY_KEY): ScalpSignal {
  const sig = strategyKey === TRENDBOT_STRATEGY_KEY
    ? evaluateTrendBotSignal(coin, bars)
    : evaluateMultiTimeframeSignal(coin, aggregateBars(bars, 24 * 60 * 60 * 1000), aggregateBars(bars, 4 * 60 * 60 * 1000), bars);
  return { coin, side: sig.side, family: strategyKey, confidence: sig.confidence, reasons: sig.reasons, price: sig.price, atrPct: sig.indicators["atrPct"] ?? 0, indicators: sig.indicators, actionLine: sig.actionLine, safetyLine: sig.safetyLine };
}

export const DEFAULT_EXITS = { tpPct: 100, slPct: 0, trailActivatePct: 0, trailDistPct: 0 };
export interface ExitParams { tpPct: number; slPct: number; trailActivatePct: number; trailDistPct: number }
export interface TrailUpdate { stopLoss: number; trailHigh: number; changed: boolean }

export function updateTrail(side: ScalpSide, entry: number, mark: number, stopLoss: number, trailHigh: number | null, p: ExitParams): TrailUpdate {
  const best = side === "long" ? Math.max(trailHigh ?? entry, mark) : Math.min(trailHigh ?? entry, mark);
  const gainPct = side === "long" ? ((best - entry) / entry) * 100 : ((entry - best) / entry) * 100;
  let stop = stopLoss;
  if (gainPct >= p.trailActivatePct && p.trailDistPct > 0) {
    const candidate = side === "long" ? best * (1 - p.trailDistPct / 100) : best * (1 + p.trailDistPct / 100);
    stop = side === "long" ? Math.max(stopLoss, candidate) : Math.min(stopLoss, candidate);
  }
  return { stopLoss: stop, trailHigh: best, changed: stop !== stopLoss || best !== trailHigh };
}

export function exitReasonFor(side: ScalpSide, mark: number, stopLoss: number, takeProfit: number, entry?: number): string | null {
  const inProfit = entry != null && (side === "long" ? stopLoss > entry : stopLoss < entry);
  const stopLabel = inProfit ? "trailing_stop" : "stop_loss";
  if (side === "long") { if (mark <= stopLoss) return stopLabel; if (mark >= takeProfit) return "take_profit"; }
  else { if (mark >= stopLoss) return stopLabel; if (mark <= takeProfit) return "take_profit"; }
  return null;
}
