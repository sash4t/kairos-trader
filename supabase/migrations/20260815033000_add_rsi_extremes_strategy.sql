-- Sixth strategy: pure 1H RSI Extremes mean-reversion.
ALTER TABLE public.bot_settings
  DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_strategy_key_check
  CHECK (strategy_key IN (
    'trendline_price_action',
    'trendline-break',
    'intraday-momentum-pullback',
    'original-trend-price-action',
    'volatility-squeeze-breakout',
    'rsi-extremes-1h'
  ));

ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS rsi_last_scan_at timestamptz;
