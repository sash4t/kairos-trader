ALTER TABLE public.bot_settings DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;
ALTER TABLE public.bot_settings ADD CONSTRAINT bot_settings_strategy_key_check CHECK (strategy_key = ANY (ARRAY['trendline_price_action'::text, 'trendbot_momentum'::text, 'trendline-break'::text]));

ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS tb_timeframes text NOT NULL DEFAULT '1d,4h,1h',
  ADD COLUMN IF NOT EXISTS tb_pivot_strength integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS tb_risk_pct numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS tb_refresh_min integer NOT NULL DEFAULT 60;

ALTER TABLE public.bot_settings DROP CONSTRAINT IF EXISTS bot_settings_tb_pivot_strength_check;
ALTER TABLE public.bot_settings ADD CONSTRAINT bot_settings_tb_pivot_strength_check CHECK (tb_pivot_strength BETWEEN 2 AND 10);
ALTER TABLE public.bot_settings DROP CONSTRAINT IF EXISTS bot_settings_tb_risk_pct_check;
ALTER TABLE public.bot_settings ADD CONSTRAINT bot_settings_tb_risk_pct_check CHECK (tb_risk_pct >= 0.25 AND tb_risk_pct <= 5);
ALTER TABLE public.bot_settings DROP CONSTRAINT IF EXISTS bot_settings_tb_refresh_min_check;
ALTER TABLE public.bot_settings ADD CONSTRAINT bot_settings_tb_refresh_min_check CHECK (tb_refresh_min BETWEEN 1 AND 1440);