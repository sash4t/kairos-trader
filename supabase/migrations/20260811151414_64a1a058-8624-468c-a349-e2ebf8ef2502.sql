ALTER TABLE public.bot_settings DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;
UPDATE public.bot_settings SET strategy_key = 'trendline_price_action' WHERE strategy_key IN ('trendline_pure_price','adaptive_trend_momentum');
ALTER TABLE public.bot_settings ALTER COLUMN strategy_key SET DEFAULT 'trendline_price_action';
ALTER TABLE public.bot_settings ADD CONSTRAINT bot_settings_strategy_key_check CHECK (strategy_key IN ('trendline_price_action','trendbot_momentum'));
NOTIFY pgrst, 'reload schema';