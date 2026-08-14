-- Final repair for strategy selection persistence.
-- Keep every historical Kairos strategy key valid so this migration cannot
-- fail while validating existing bot_settings rows, while explicitly allowing
-- the new Original Trend Price Action key.

ALTER TABLE public.bot_settings
  DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_strategy_key_check
  CHECK (
    strategy_key = ANY (
      ARRAY[
        'trendline_price_action'::text,
        'trendline_pure_price'::text,
        'adaptive_trend_momentum'::text,
        'trendbot_momentum'::text,
        'trendline-break'::text,
        'intraday-momentum-pullback'::text,
        'original-trend-price-action'::text,
        'bollinger_breakout'::text
      ]
    )
  ) NOT VALID;

-- Existing rows are allowed to remain untouched during creation; validate after
-- the complete historical key set is accepted so future writes are enforced.
ALTER TABLE public.bot_settings
  VALIDATE CONSTRAINT bot_settings_strategy_key_check;

NOTIFY pgrst, 'reload schema';
