ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS strategy_key text NOT NULL DEFAULT 'bollinger_breakout';

UPDATE public.bot_settings SET strategy_key = 'bollinger_breakout' WHERE strategy_key IS NULL OR strategy_key NOT IN ('bollinger_breakout','trendbot_momentum');

ALTER TABLE public.bot_settings DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;
ALTER TABLE public.bot_settings ADD CONSTRAINT bot_settings_strategy_key_check CHECK (strategy_key IN ('bollinger_breakout','trendbot_momentum'));

NOTIFY pgrst, 'reload schema';