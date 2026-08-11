-- Finalize the strategy selector: keep the existing Trendline Price Action
-- strategy and add the transcript-based Trendline Break engine.
ALTER TABLE public.bot_settings
  DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_strategy_key_check
  CHECK (strategy_key IN (
    'bollinger_breakout',
    'trendbot_momentum',
    'trendline_price_action',
    'trendline-break'
  ));

-- Existing installs should continue using the existing strategy rather than
-- silently switching to Trendline Break.
ALTER TABLE public.bot_settings
  ALTER COLUMN strategy_key SET DEFAULT 'trendline_price_action';

-- Transcript strategy defaults requested for Hyperliquid markets.
ALTER TABLE public.bot_settings
  ALTER COLUMN btc_shock_pct SET DEFAULT 1.5;
ALTER TABLE public.bot_settings
  ALTER COLUMN btc_shock_window_min SET DEFAULT 240;

-- Add the independent Trendline Break position-size cap if it is not already present.
ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS tb_position_size_pct numeric NOT NULL DEFAULT 5;
ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS tb_timeframes text NOT NULL DEFAULT '1w,1d,4h,1h,30m,15m';
ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS tb_pivot_strength integer NOT NULL DEFAULT 3;
ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS tb_risk_pct numeric NOT NULL DEFAULT 1;
ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS tb_refresh_min integer NOT NULL DEFAULT 15;

NOTIFY pgrst, 'reload schema';
