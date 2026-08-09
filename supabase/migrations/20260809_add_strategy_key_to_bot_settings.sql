-- Add selectable strategy support to bot_settings.
-- Safe for existing installations: existing bots remain on Bollinger Breakout.
ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS strategy_key text NOT NULL DEFAULT 'bollinger_breakout';

ALTER TABLE public.bot_settings
  DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_strategy_key_check
  CHECK (strategy_key IN ('bollinger_breakout', 'trendbot_momentum'));

-- Ask PostgREST/Supabase to refresh its schema cache immediately when supported.
NOTIFY pgrst, 'reload schema';
