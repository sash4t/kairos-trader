-- Allow intraday-momentum-pullback strategy for both paper and live modes.
-- Previously the UI gated IMP to paper-only; that restriction is removed.
-- No schema change needed — strategy_key is already a free-text column.
-- This migration documents the intent and clears any stale paper-only setting
-- for users who had IMP selected when they switch to live mode.

-- If a user had IMP selected and then switches mode, we preserve their choice.
-- Nothing to migrate in data — the code now handles IMP in both modes.
SELECT 1; -- no-op migration, documents the UI policy change
