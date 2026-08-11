ALTER TABLE public.bot_settings DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;

UPDATE public.bot_settings
SET strategy_key = 'trendline_price_action'
WHERE strategy_key IS DISTINCT FROM 'trendbot_momentum';

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_strategy_key_check
  CHECK (strategy_key = ANY (ARRAY['trendline_price_action'::text, 'trendbot_momentum'::text]));

ALTER TABLE public.bot_settings ALTER COLUMN strategy_key SET DEFAULT 'trendline_price_action';

UPDATE public.bot_settings
SET scalp_tp_pct = 0,
    btc_shock_enabled = COALESCE(btc_shock_enabled, true),
    btc_shock_pct = 2.0,
    btc_shock_window_min = 15;

ALTER TABLE public.bot_settings ALTER COLUMN scalp_tp_pct SET DEFAULT 0;