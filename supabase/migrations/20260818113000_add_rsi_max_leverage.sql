ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS rsi_max_leverage integer NOT NULL DEFAULT 5;

ALTER TABLE public.bot_settings
  DROP CONSTRAINT IF EXISTS bot_settings_rsi_max_leverage_check;

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_rsi_max_leverage_check
  CHECK (rsi_max_leverage >= 1 AND rsi_max_leverage <= 10);
