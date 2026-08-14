-- Optimized paper-trading defaults only. Live execution settings are intentionally untouched.
UPDATE public.bot_settings
SET
  server_agent_enabled = false,
  min_confidence = 65,
  max_positions = LEAST(COALESCE(max_positions, 5), 5),
  max_leverage = LEAST(COALESCE(max_leverage, 5), 5),
  max_exposure_pct = LEAST(COALESCE(max_exposure_pct, 30), 30),
  daily_loss_pct = LEAST(COALESCE(daily_loss_pct, 3), 3),
  trailing_enabled = true,
  tb_risk_pct = 0.4,
  tb_position_size_pct = 6,
  tb_refresh_min = 15
WHERE mode = 'paper';
