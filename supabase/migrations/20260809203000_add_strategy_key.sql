alter table public.bot_settings
  add column if not exists strategy_key text not null default 'bollinger_breakout';

alter table public.bot_settings
  add constraint bot_settings_strategy_key_check
  check (strategy_key in ('bollinger_breakout', 'trendbot_momentum'));
