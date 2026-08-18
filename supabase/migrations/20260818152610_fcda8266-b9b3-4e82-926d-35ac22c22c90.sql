ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS rsi_risk_pct numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS rsi_max_leverage integer NOT NULL DEFAULT 5;
NOTIFY pgrst, 'reload schema';