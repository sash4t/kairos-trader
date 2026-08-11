/**
 * Single source of truth for the three selectable Kairos strategies.
 * Adding Pure Price must never remove the original strategy or TrendBot.
 */
export const ADAPTIVE_STRATEGY_KEY = "adaptive_trend_momentum" as const;
export const TRENDBOT_MOMENTUM_KEY = "trendbot_momentum" as const;
export const PURE_PRICE_STRATEGY_KEY = "trendline_pure_price" as const;

export type StrategyKey =
  | typeof ADAPTIVE_STRATEGY_KEY
  | typeof TRENDBOT_MOMENTUM_KEY
  | typeof PURE_PRICE_STRATEGY_KEY;

export interface StrategyOption {
  key: StrategyKey;
  name: string;
  description: string;
  /** Pure price strategies use exchange maximum leverage, never 1x or % risk sizing. */
  usesMaxLeverage: boolean;
  usesIndicators: boolean;
}

export const STRATEGY_OPTIONS: readonly StrategyOption[] = [
  {
    key: ADAPTIVE_STRATEGY_KEY,
    name: "Adaptive Trend Following Momentum",
    description:
      "The original Kairos engine: Daily → 4H → 1H trend-line alignment with momentum/volatility confirmation, fixed stop-loss and take-profit sizing from position size %.",
    usesMaxLeverage: false,
    usesIndicators: true,
  },
  {
    key: TRENDBOT_MOMENTUM_KEY,
    name: "TrendBot Momentum",
    description: "EMA20/50 + RSI14 + MACD momentum on 1H bars, long and short, with configurable TP/SL and trailing exits.",
    usesMaxLeverage: false,
    usesIndicators: true,
  },
  {
    key: PURE_PRICE_STRATEGY_KEY,
    name: "Trendline Strategy - Pure Price",
    description:
      "Pure price action: Monthly → Weekly → Daily → 4H → 1H top-down trend lines. Action Line break enters, the opposing Safety Line is the dynamic trailing stop, no fixed take-profit, and positions size at the market's maximum Hyperliquid leverage.",
    usesMaxLeverage: true,
    usesIndicators: false,
  },
] as const;

const LEGACY_KEYS: Record<string, StrategyKey> = {
  // pre-registry names that existed in the database
  trendline_price_action: PURE_PRICE_STRATEGY_KEY,
  trendline_pure_price: PURE_PRICE_STRATEGY_KEY,
  bollinger_breakout: ADAPTIVE_STRATEGY_KEY,
  adaptive_trend_momentum: ADAPTIVE_STRATEGY_KEY,
  trendbot_momentum: TRENDBOT_MOMENTUM_KEY,
};

export function normalizeStrategyKey(value: string | null | undefined): StrategyKey {
  if (!value) return ADAPTIVE_STRATEGY_KEY;
  return LEGACY_KEYS[value] ?? ADAPTIVE_STRATEGY_KEY;
}

export function isPurePrice(key: string | null | undefined): boolean {
  return normalizeStrategyKey(key) === PURE_PRICE_STRATEGY_KEY;
}

export function strategyOption(key: string | null | undefined): StrategyOption {
  const k = normalizeStrategyKey(key);
  return STRATEGY_OPTIONS.find((o) => o.key === k)!;
}
