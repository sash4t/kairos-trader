-- Re-apply the canonical strategy allow-list in a new migration version.
-- Editing an already-recorded migration does not rerun it on deployed databases.
ALTER TABLE public.bot_settings
  DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;

UPDATE public.bot_settings
SET
  strategy_key = 'trend-pulse',
  min_confidence = GREATEST(min_confidence, 75),
  trailing_enabled = true
WHERE strategy_key = 'trendline-break';

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_strategy_key_check
  CHECK (
    strategy_key IN (
      'trendline_price_action',
      'trend-pulse',
      'intraday-pullback',
      'original-trend-price-action',
      'volatility-squeeze-breakout',
      'rsi-extremes-1h'
    )
  )
  NOT VALID;

ALTER TABLE public.bot_settings
  VALIDATE CONSTRAINT bot_settings_strategy_key_check;
