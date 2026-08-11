-- Trendline Price Action is the only supported strategy.
ALTER TABLE public.bot_settings DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;

UPDATE public.bot_settings
SET strategy_key = 'trendline_price_action',
    min_confidence = 62,
    updated_at = now();

ALTER TABLE public.bot_settings
  ALTER COLUMN strategy_key SET DEFAULT 'trendline_price_action';

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_strategy_key_check
  CHECK (strategy_key = 'trendline_price_action');

ALTER TABLE public.bot_settings
  ALTER COLUMN min_confidence SET DEFAULT 62;

NOTIFY pgrst, 'reload schema';
