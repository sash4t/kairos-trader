-- Allow the fourth, classic trend price-action strategy to be persisted.
ALTER TABLE public.bot_settings
  DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_strategy_key_check
  CHECK (
    strategy_key = ANY (
      ARRAY[
        'trendline_price_action'::text,
        'trendbot_momentum'::text,
        'trendline-break'::text,
        'intraday-momentum-pullback'::text,
        'original-trend-price-action'::text
      ]
    )
  );

NOTIFY pgrst, 'reload schema';
