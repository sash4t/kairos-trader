-- 1. Close duplicate open positions (keep the oldest per coin)
WITH dups AS (
  SELECT id, row_number() OVER (PARTITION BY user_id, coin ORDER BY opened_at) AS rn
  FROM public.paper_positions WHERE status = 'open'
)
UPDATE public.paper_positions p
SET status = 'closed', exit_price = p.entry_price, exit_reason = 'duplicate', pnl = 0, closed_at = now()
FROM dups WHERE dups.id = p.id AND dups.rn > 1;

-- 2. Prevent two open positions in the same coin
CREATE UNIQUE INDEX IF NOT EXISTS paper_positions_one_open_per_coin
  ON public.paper_positions (user_id, coin) WHERE status = 'open';

-- 3. Always-on trading agent: run the cycle every minute
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.unschedule('kairos-trade-cycle') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'kairos-trade-cycle');

SELECT cron.schedule(
  'kairos-trade-cycle',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://kairos-trader.lovable.app/api/public/cron/trade-cycle',
    headers := '{"content-type":"application/json","apikey":"sb_publishable_oC2d3WicYYfSybVeY3eWmg_THUqYmG1"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);