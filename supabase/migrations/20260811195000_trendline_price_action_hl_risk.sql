-- Finalize the selectable trendline strategy configuration.
-- The strategy engine uses the stable internal key `trendline-break`.
ALTER TABLE public.bot_settings
  DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;

UPDATE public.bot_settings
SET strategy_key = 'trendline-break'
WHERE strategy_key IS NULL
   OR strategy_key IN ('trendline_price_action', 'trendline_pure_price', 'adaptive_trend_momentum');

ALTER TABLE public.bot_settings
  ALTER COLUMN strategy_key SET DEFAULT 'trendline-break';

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_strategy_key_check
  CHECK (strategy_key IN ('trendline-break', 'bollinger_breakout', 'trendbot_momentum'));

ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS tb_position_size_pct numeric NOT NULL DEFAULT 5;

-- Weekly is the highest timeframe. Monthly is intentionally not required.
ALTER TABLE public.bot_settings
  ALTER COLUMN tb_timeframes SET DEFAULT '1w,1d,4h,1h,30m,15m';

ALTER TABLE public.bot_settings
  ALTER COLUMN tb_pivot_strength SET DEFAULT 3;
ALTER TABLE public.bot_settings
  ALTER COLUMN tb_risk_pct SET DEFAULT 1;
ALTER TABLE public.bot_settings
  ALTER COLUMN tb_refresh_min SET DEFAULT 15;

ALTER TABLE public.bot_settings
  ALTER COLUMN btc_shock_enabled SET DEFAULT true;
ALTER TABLE public.bot_settings
  ALTER COLUMN btc_shock_pct SET DEFAULT 1.5;
ALTER TABLE public.bot_settings
  ALTER COLUMN btc_shock_window_min SET DEFAULT 240;

UPDATE public.bot_settings
SET tb_timeframes = '1w,1d,4h,1h,30m,15m',
    tb_pivot_strength = 3,
    tb_risk_pct = COALESCE(tb_risk_pct, 1),
    tb_refresh_min = 15,
    tb_position_size_pct = COALESCE(tb_position_size_pct, 5),
    btc_shock_enabled = true,
    btc_shock_pct = 1.5,
    btc_shock_window_min = 240,
    updated_at = now()
WHERE strategy_key = 'trendline-break';

NOTIFY pgrst, 'reload schema';
