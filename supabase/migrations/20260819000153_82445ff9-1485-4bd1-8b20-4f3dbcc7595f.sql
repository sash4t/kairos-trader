ALTER TABLE public.bot_settings
  DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;

UPDATE public.bot_settings
SET strategy_key = 'trend-pulse',
    min_confidence = GREATEST(min_confidence, 75),
    trailing_enabled = true
WHERE strategy_key = 'trendline-break';

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_strategy_key_check
  CHECK (strategy_key IN (
    'trendline_price_action',
    'trend-pulse',
    'intraday-momentum-pullback',
    'original-trend-price-action',
    'volatility-squeeze-breakout',
    'rsi-extremes-1h'
  ));

NOTIFY pgrst, 'reload schema';