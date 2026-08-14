UPDATE public.bot_settings
SET strategy_key = 'trendline_price_action'
WHERE strategy_key IN ('bollinger_breakout', 'trendbot_momentum');

ALTER TABLE public.bot_settings
  ALTER COLUMN strategy_key SET DEFAULT 'trendline_price_action';

ALTER TABLE public.bot_settings
  DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_strategy_key_check
  CHECK (
    strategy_key = ANY (
      ARRAY[
        'trendline_price_action'::text,
        'trendline-break'::text,
        'intraday-momentum-pullback'::text
      ]
    )
  );

NOTIFY pgrst, 'reload schema';