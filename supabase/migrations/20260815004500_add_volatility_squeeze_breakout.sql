-- Fifth strategy: Volatility Squeeze Breakout.
-- Keep this migration idempotent so environments with earlier constraint repairs converge safely.
ALTER TABLE public.bot_settings
  DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_strategy_key_check
  CHECK (strategy_key IN (
    'trendline_price_action',
    'trendline-break',
    'intraday-momentum-pullback',
    'original-trend-price-action',
    'volatility-squeeze-breakout'
  ));

ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS partial_taken boolean NOT NULL DEFAULT false;
