-- Remove the old allow-list before migrating existing rows. Updating a
-- trendline-break row to trend-pulse while the old constraint is active makes
-- this migration fail before the replacement constraint can be installed.
ALTER TABLE public.bot_settings DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;

UPDATE public.bot_settings
SET strategy_key = 'trend-pulse', min_confidence = GREATEST(min_confidence, 75), trailing_enabled = true
WHERE strategy_key = 'trendline-break';

ALTER TABLE public.bot_settings ADD CONSTRAINT bot_settings_strategy_key_check CHECK (strategy_key IN (
  'trendline_price_action', 'trend-pulse', 'intraday-pullback', 'original-trend-price-action',
  'volatility-squeeze-breakout', 'rsi-extremes-1h'
));
