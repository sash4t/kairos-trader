-- Allow up to 30 concurrent positions and apply the new RSI strategy default
-- to users who currently have that strategy selected.
ALTER TABLE public.bot_settings
  ALTER COLUMN max_positions SET DEFAULT 30;

UPDATE public.bot_settings
SET max_positions = 30
WHERE strategy_key = 'rsi-extremes-1h';
