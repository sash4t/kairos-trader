ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS rsi_risk_pct numeric NOT NULL DEFAULT 1;

ALTER TABLE public.bot_settings
  DROP CONSTRAINT IF EXISTS bot_settings_rsi_risk_pct_check;

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_rsi_risk_pct_check
  CHECK (rsi_risk_pct >= 0.05 AND rsi_risk_pct <= 5);
