ALTER TABLE public.bot_settings DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;

UPDATE public.bot_settings
SET strategy_key = 'bollinger_breakout'
WHERE strategy_key IS DISTINCT FROM 'trendbot_momentum';

ALTER TABLE public.bot_settings ALTER COLUMN strategy_key SET DEFAULT 'bollinger_breakout';

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_strategy_key_check
  CHECK (strategy_key IN ('bollinger_breakout', 'trendbot_momentum'));

ALTER TABLE public.bot_settings ALTER COLUMN btc_shock_pct SET DEFAULT 2.0;
ALTER TABLE public.bot_settings ALTER COLUMN btc_shock_window_min SET DEFAULT 15;

UPDATE public.bot_settings SET btc_shock_pct = 2.0 WHERE btc_shock_pct = 1.5;

NOTIFY pgrst, 'reload schema';