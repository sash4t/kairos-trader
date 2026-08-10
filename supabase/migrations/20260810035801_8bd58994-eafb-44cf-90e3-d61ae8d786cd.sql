ALTER TABLE public.paper_positions ALTER COLUMN take_profit DROP NOT NULL;
ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS safety_line numeric,
  ADD COLUMN IF NOT EXISTS action_line numeric,
  ADD COLUMN IF NOT EXISTS timeframe text,
  ADD COLUMN IF NOT EXISTS initial_stop numeric,
  ADD COLUMN IF NOT EXISTS risk_pct numeric;

ALTER TABLE public.bot_settings DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;
ALTER TABLE public.bot_settings ALTER COLUMN strategy_key SET DEFAULT 'trendline_price_action';
UPDATE public.bot_settings SET strategy_key = 'trendline_price_action' WHERE strategy_key IS DISTINCT FROM 'trendbot_momentum';
ALTER TABLE public.bot_settings ADD CONSTRAINT bot_settings_strategy_key_check CHECK (strategy_key = ANY (ARRAY['trendline_price_action'::text, 'trendbot_momentum'::text]));

ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS trendline_risk_pct numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS execution_timeframe text NOT NULL DEFAULT '1h',
  ADD COLUMN IF NOT EXISTS safety_buffer_pct numeric NOT NULL DEFAULT 0.15;

ALTER TABLE public.bot_settings DROP CONSTRAINT IF EXISTS bot_settings_execution_timeframe_check;
ALTER TABLE public.bot_settings ADD CONSTRAINT bot_settings_execution_timeframe_check CHECK (execution_timeframe = ANY (ARRAY['1d'::text,'4h'::text,'1h'::text,'30m'::text,'15m'::text,'5m'::text]));
ALTER TABLE public.bot_settings DROP CONSTRAINT IF EXISTS bot_settings_trendline_risk_pct_check;
ALTER TABLE public.bot_settings ADD CONSTRAINT bot_settings_trendline_risk_pct_check CHECK (trendline_risk_pct >= 0.25 AND trendline_risk_pct <= 2);

NOTIFY pgrst, 'reload schema';