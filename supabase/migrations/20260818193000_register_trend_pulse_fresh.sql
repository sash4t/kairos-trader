-- Register Trend-Pulse as a standalone strategy. Existing legacy selections
-- are reset so users explicitly opt in to the new strategy after deployment.
ALTER TABLE public.bot_settings
  DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;

UPDATE public.bot_settings
SET strategy_key = 'trendline_price_action'
WHERE strategy_key IN ('trendline-break', 'trend-pulse');

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_strategy_key_check
  CHECK (strategy_key IN (
    'trendline_price_action',
    'trend-pulse',
    'intraday-pullback',
    'original-trend-price-action',
    'volatility-squeeze-breakout',
    'rsi-extremes-1h'
  ));

ALTER TABLE public.bot_settings
  VALIDATE CONSTRAINT bot_settings_strategy_key_check;
