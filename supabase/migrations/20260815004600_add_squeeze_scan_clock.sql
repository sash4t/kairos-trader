ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS squeeze_last_scan_at timestamptz;
