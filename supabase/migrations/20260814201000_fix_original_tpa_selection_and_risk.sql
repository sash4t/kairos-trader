-- Ensure the fourth strategy can be persisted in every environment, including
-- databases whose earlier strategy-key constraint migration was already applied.
ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS trendline_risk_pct numeric NOT NULL DEFAULT 0.4;

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
        'original-trend-price-action'::text,
        'bollinger_breakout'::text
      ]
    )
  );

NOTIFY pgrst, 'reload schema';
