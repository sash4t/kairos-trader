CREATE TABLE public.trendline_broken_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  coin text NOT NULL,
  strategy_key text NOT NULL,
  timeframe text NOT NULL,
  line_id text NOT NULL,
  broken_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT trendline_broken_lines_unique UNIQUE (user_id, coin, strategy_key, timeframe, line_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.trendline_broken_lines TO authenticated;
GRANT ALL ON public.trendline_broken_lines TO service_role;

ALTER TABLE public.trendline_broken_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own broken lines" ON public.trendline_broken_lines
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX trendline_broken_lines_lookup_idx
  ON public.trendline_broken_lines (user_id, coin, strategy_key, timeframe);