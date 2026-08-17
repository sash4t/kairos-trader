CREATE OR REPLACE FUNCTION public.update_paper_squeeze_trail(
  p_id uuid,
  p_stop numeric,
  p_peak numeric,
  p_indicators jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.paper_positions
  SET
    stop_loss = CASE
      WHEN side = 'long' THEN GREATEST(stop_loss, p_stop)
      ELSE LEAST(stop_loss, p_stop)
    END,
    trail_high = CASE
      WHEN side = 'long' THEN GREATEST(COALESCE(trail_high, entry_price), p_peak)
      ELSE LEAST(COALESCE(trail_high, entry_price), p_peak)
    END,
    indicators = COALESCE(indicators, '{}'::jsonb) || COALESCE(p_indicators, '{}'::jsonb)
  WHERE id = p_id AND status = 'open';
$$;

REVOKE ALL ON FUNCTION public.update_paper_squeeze_trail(uuid, numeric, numeric, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_paper_squeeze_trail(uuid, numeric, numeric, jsonb) TO service_role;

SELECT cron.unschedule('kairos-position-monitor')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'kairos-position-monitor');

SELECT cron.schedule(
  'kairos-position-monitor',
  '10 seconds',
  $$
  SELECT net.http_post(
    url := 'https://kairos-trader.lovable.app/api/public/cron/position-monitor',
    headers := '{"content-type":"application/json","apikey":"sb_publishable_oC2d3WicYYfSybVeY3eWmg_THUqYmG1"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 8000
  );
  $$
);
