/**
 * Pure, testable guards shared by the browser paper engine and the server agent.
 * Nothing here touches the network or the database.
 */
import { TRENDBOT_PARAMS } from "./trendbotStrategy";
import { TRENDBOT_MOMENTUM_KEY, normalizeStrategyKey } from "./strategies";

export const DAILY_LOSS_EXIT_REASON = "daily_loss_limit";
export const MAX_HOLD_EXIT_REASON = "max_hold_bars";
export const TRENDBOT_BAR_MS = 60 * 60 * 1000;

/** Start of the current UTC day in epoch ms. */
export function utcDayStart(now: number = Date.now()): number {
  return new Date(now).setUTCHours(0, 0, 0, 0);
}

export interface DailyLossCheck {
  breached: boolean;
  dayPnl: number;
  dayPnlPct: number;
  /** Reason a check was skipped, if it was. */
  disabled?: string;
}

/**
 * Daily circuit breaker. A zero / negative / non-finite limit means "disabled"
 * rather than an accidental divide-by-zero flatten.
 */
export function checkDailyLoss(
  dayStartEquity: number,
  currentEquity: number,
  dailyLossPct: number,
): DailyLossCheck {
  const limit = Number(dailyLossPct);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { breached: false, dayPnl: 0, dayPnlPct: 0, disabled: "daily_loss_pct disabled" };
  }
  if (!Number.isFinite(dayStartEquity) || dayStartEquity <= 0) {
    return { breached: false, dayPnl: 0, dayPnlPct: 0, disabled: "no valid day-start equity" };
  }
  const dayPnl = currentEquity - dayStartEquity;
  const dayPnlPct = (dayPnl / dayStartEquity) * 100;
  return { breached: dayPnlPct <= -limit, dayPnl, dayPnlPct };
}

/**
 * TrendBot Momentum forcibly exits after TRENDBOT_PARAMS.maxHoldBars completed
 * 1H bars. Adaptive and Pure Price have no time-based exit.
 */
export function isMaxHoldExpired(
  strategyKey: string | null | undefined,
  openedAtMs: number,
  now: number = Date.now(),
  barMs: number = TRENDBOT_BAR_MS,
): boolean {
  if (normalizeStrategyKey(strategyKey) !== TRENDBOT_MOMENTUM_KEY) return false;
  if (!Number.isFinite(openedAtMs) || openedAtMs <= 0) return false;
  const completedBars = Math.floor((now - openedAtMs) / barMs);
  return completedBars >= TRENDBOT_PARAMS.maxHoldBars;
}

export interface EquityPoint { ts: string | number; equity: number | string }

/**
 * Max drawdown for the CURRENT session only. A session boundary is any large
 * upward discontinuity in the equity series (paper reset, manual balance edit,
 * deposit) — historical drawdowns from before a reset must not be shown.
 */
export function sessionMaxDrawdown(series: EquityPoint[], jumpPct = 20): { maxDD: number; maxDDpct: number; startIndex: number } {
  const values = series.map(p => +p.equity).filter(v => Number.isFinite(v) && v > 0);
  if (values.length === 0) return { maxDD: 0, maxDDpct: 0, startIndex: 0 };
  let startIndex = 0;
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    if (prev > 0 && Math.abs(values[i] - prev) >= prev * (jumpPct / 100)) startIndex = i;
  }
  let peak = values[startIndex];
  let maxDD = 0;
  for (let i = startIndex; i < values.length; i++) {
    peak = Math.max(peak, values[i]);
    maxDD = Math.min(maxDD, values[i] - peak);
  }
  const maxDDpct = peak > 0 ? (maxDD / peak) * 100 : 0;
  return { maxDD, maxDDpct, startIndex };
}
