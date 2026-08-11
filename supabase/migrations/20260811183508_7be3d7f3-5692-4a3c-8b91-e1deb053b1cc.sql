ALTER TABLE public.bot_settings ALTER COLUMN scalp_tp_pct SET DEFAULT 12;
ALTER TABLE public.bot_settings ALTER COLUMN scalp_sl_pct SET DEFAULT 1.5;
ALTER TABLE public.bot_settings ALTER COLUMN trail_activate_pct SET DEFAULT 1.5;
ALTER TABLE public.bot_settings ALTER COLUMN trail_dist_pct SET DEFAULT 1.2;

UPDATE public.bot_settings SET
  scalp_tp_pct = 12,
  scalp_sl_pct = 1.5,
  trail_activate_pct = 1.5,
  trail_dist_pct = 1.2,
  updated_at = now();

NOTIFY pgrst, 'reload schema';