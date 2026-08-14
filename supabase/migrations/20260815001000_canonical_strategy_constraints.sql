-- Canonical strategy schema for the four strategies exposed by the application.
-- This mirrors the production repair and prevents future environments from
-- retaining an older strategy-key/risk constraint.
ALTER TABLE public.bot_settings
  DROP CONSTRAINT IF EXISTS bot_settings_strategy_key_check;

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_strategy_key_check
  CHECK (strategy_key IN (
    'trendline_price_action',
    'trendline-break',
    'intraday-momentum-pullback',
    'original-trend-price-action'
  ));

ALTER TABLE public.bot_settings
  DROP CONSTRAINT IF EXISTS bot_settings_trendline_risk_pct_check;

ALTER TABLE public.bot_settings
  ADD CONSTRAINT bot_settings_trendline_risk_pct_check
  CHECK (trendline_risk_pct >= 0.05 AND trendline_risk_pct <= 5);

NOTIFY pgrst, 'reload schema';
