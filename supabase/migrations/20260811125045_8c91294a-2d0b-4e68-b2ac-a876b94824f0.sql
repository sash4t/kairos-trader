ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS btc_shock_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS btc_shock_pct numeric NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS btc_shock_window_min integer NOT NULL DEFAULT 15;

ALTER TABLE public.bot_settings DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;

UPDATE public.bot_settings SET strategy_key = 'trendline_pure_price' WHERE strategy_key = 'trendline_price_action';
UPDATE public.bot_settings SET strategy_key = 'adaptive_trend_momentum' WHERE strategy_key NOT IN ('trendline_pure_price','trendbot_momentum');

ALTER TABLE public.bot_settings ALTER COLUMN strategy_key SET DEFAULT 'adaptive_trend_momentum';

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_strategy_key_check
  CHECK (strategy_key IN ('adaptive_trend_momentum','trendbot_momentum','trendline_pure_price'));

ALTER TABLE public.bot_settings DROP CONSTRAINT IF EXISTS bot_settings_btc_shock_pct_check;
ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_btc_shock_pct_check CHECK (btc_shock_pct >= 0.1 AND btc_shock_pct <= 25);
ALTER TABLE public.bot_settings DROP CONSTRAINT IF EXISTS bot_settings_btc_shock_window_check;
ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_btc_shock_window_check CHECK (btc_shock_window_min >= 1 AND btc_shock_window_min <= 240);

NOTIFY pgrst, 'reload schema';