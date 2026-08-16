import { evaluateMultiTimeframeSignal, TRENDLINE_STRATEGY_KEY, type Bar } from "./strategy";
import { TRENDLINE_BREAK_KEY } from "./strategies/trendlineBreak";
import { INTRADAY_PULLBACK_KEY } from "./strategies/intradayMomentumPullback";
import { ORIGINAL_TREND_PRICE_ACTION_KEY } from "./strategies/originalTrendPriceAction";
import { VOLATILITY_SQUEEZE_BREAKOUT_KEY } from "./strategies/volatilitySqueezeBreakout";
import { RSI_EXTREMES_KEY } from "./strategies/rsiExtremes";

export type ScalpSide = "long" | "short";
export type StrategyKey = typeof TRENDLINE_STRATEGY_KEY | typeof TRENDLINE_BREAK_KEY | typeof INTRADAY_PULLBACK_KEY | typeof ORIGINAL_TREND_PRICE_ACTION_KEY | typeof VOLATILITY_SQUEEZE_BREAKOUT_KEY | typeof RSI_EXTREMES_KEY;
export const MAX_OPEN_POSITIONS = 30;
export function clampMaxPositions(value: number): number {
  return Math.min(MAX_OPEN_POSITIONS, Math.max(1, Math.floor(value || 1)));
}

export interface ScalpSignal {
  coin: string; side: ScalpSide | null; family: string; confidence: number; reasons: string[]; price: number; atrPct: number; indicators: Record<string, number>;
  actionLine?: number; safetyLine?: number;
}

export const STRATEGY_OPTIONS = [
  { key: TRENDLINE_STRATEGY_KEY, name: "Trendline Price Action", description: "Top-down trend lines: Daily → 4H → 1H. Daily sets the major bias, 4H confirms it, and 1H provides the action-line break." },
  { key: TRENDLINE_BREAK_KEY, name: "Trendline Break", description: "Chained multi-timeframe trendlines. Close through an upward line goes short; close through a downward line goes long; the opposing line is the structural safety stop." },
  { key: INTRADAY_PULLBACK_KEY, name: "Intraday Momentum Pullback", description: "Paper-mode 4H → 1H → 15m momentum pullbacks with EMA20 rejection entries, structure + ATR stops, risk-based sizing and R-based profit protection." },
  { key: ORIGINAL_TREND_PRICE_ACTION_KEY, name: "Original Trend Price Action", description: "1H trend-line execution with EMA20/50, RSI, MACD, volume and ATR confidence scoring, gated by aligned Daily and 4H direction." },
  { key: VOLATILITY_SQUEEZE_BREAKOUT_KEY, name: "Volatility Squeeze Breakout", description: "15m momentum breakout: 4-candle breakout + ≥1.2x volume + non-extreme 1H RSI; recent squeeze only boosts confidence." },
  { key: RSI_EXTREMES_KEY, name: "1H RSI Trail", description: "Trail completed 1H RSI above 70 or below 30, enter on the first reversal, then exit at the configured percentage take profit." },
] as const;

export function aggregateBars(bars: Bar[], intervalMs: number): Bar[] {
  const groups = new Map<number, Bar>();
  for (const b of bars) {
    const key = Math.floor(b.t / intervalMs) * intervalMs;
    const existing = groups.get(key);
    if (!existing) groups.set(key, { t:key, o:b.o, h:b.h, l:b.l, c:b.c, v:b.v });
    else { existing.h=Math.max(existing.h,b.h); existing.l=Math.min(existing.l,b.l); existing.c=b.c; existing.v+=b.v; }
  }
  return [...groups.values()].sort((a,b)=>a.t-b.t);
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const FOUR_HOUR_MS = 4 * 60 * 60 * 1000;

function toSignal(coin: string, sig: ReturnType<typeof evaluateMultiTimeframeSignal>): ScalpSignal {
  return { coin, side: sig.side, family: TRENDLINE_STRATEGY_KEY, confidence: sig.confidence, reasons: sig.reasons, price: sig.price, atrPct: sig.indicators["atrPct"] ?? 0, indicators: sig.indicators, actionLine: sig.actionLine, safetyLine: sig.safetyLine };
}

export function evaluateScalpMulti(
  coin: string,
  series: { daily: Bar[]; fourHour: Bar[]; hourly: Bar[] },
): ScalpSignal {
  return toSignal(coin, evaluateMultiTimeframeSignal(coin, series.daily, series.fourHour, series.hourly));
}

export function evaluateScalp(coin: string, bars: Bar[]): ScalpSignal {
  return evaluateScalpMulti(coin, { daily: aggregateBars(bars, DAY_MS), fourHour: aggregateBars(bars, FOUR_HOUR_MS), hourly: bars });
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

/** Shared strategy-selection patch used by both the Settings and Strategy screens. */
export function strategySelectionPatch(key: StrategyKey): Record<string, unknown> {
  if (key === INTRADAY_PULLBACK_KEY) return { strategy_key: key, min_confidence: 65, trailing_enabled: true };
  if (key === ORIGINAL_TREND_PRICE_ACTION_KEY) return { strategy_key: key, min_confidence: 60, trailing_enabled: true };
  if (key === VOLATILITY_SQUEEZE_BREAKOUT_KEY) return { strategy_key: key, min_confidence: 70, trailing_enabled: true, max_positions: 5 };
  if (key === RSI_EXTREMES_KEY) return { strategy_key: key, min_confidence: 70, trailing_enabled: false, max_positions: MAX_OPEN_POSITIONS, daily_loss_pct: 5 };
  return { strategy_key: key };
}
