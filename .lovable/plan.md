# Trend-Line Top-Down: single authoritative strategy engine

Replace the current partial trend-line code with one deterministic, pure price-action engine that drives both the browser paper engine and the always-on server agent. No indicators, no fixed take-profit — the Safety Line is the stop.

## What exists today (verified)

- `src/lib/strategy.ts` has a partial trendline implementation, but it forces Daily+4H directional alignment, applies an ATR volatility band, and adds EMA/MACD/RSI/volume confidence bumps.
- `src/lib/scalp.ts` wraps it next to `trendbot_momentum` and exposes generic `updateTrail` / `exitReasonFor` with a fixed TP.
- `src/lib/agent.server.ts` loads only 1h bars (`INTERVAL = "1h"`, 230 bars), calls `evaluateScalp`, and manages exits with the generic percentage trail plus a `take_profit` computed from `tp_rr`.
- `src/lib/paperEngine.ts` runs the same generic SL/TP/trail model in the browser.
- `paper_positions.take_profit` is `numeric NOT NULL`, so a TP is always written.
- No test runner is installed (no vitest in `package.json`).

## New engine: `src/lib/trendline/`

Pure, dependency-free modules so both paper and live import identical logic.

- `types.ts` — `Timeframe`, `Pivot`, `TrendLine { id, timeframe, type: "bullish"|"bearish", a, b, slope, touches, state: "active"|"broken", valueAt(t) }`, `TrendlineState`, `TrendlineSignal`.
- `pivots.ts` — confirmed swing pivots with configurable `leftStrength`/`rightStrength`. A pivot is only emitted once its right-side candles have closed; nothing reads bars after the evaluation index.
- `lines.ts` — construction per the transcript:
  - Seed: first bullish line on the highest timeframe anchors at the lowest significant pivot in available history and must slope up; first bearish anchors at the highest pivot and must slope down.
  - Chaining: point B of the previous line becomes point A of the next.
  - For each candidate B, maximise valid touches within `touchTolerance` (fraction of price, configurable — no ATR).
  - Reject a candidate if price meaningfully pokes through the line between A and B (`penetrationTolerance`).
  - Lines extend forward indefinitely; a close beyond the line marks it `broken` (retained in history, not deleted).
- `topdown.ts` — builds and refines the full ladder `1M → 1W → 1D → 4H → 1H` and, when the execution timeframe is lower, continues `30m → 15m → 10m → 5m`. Higher-timeframe lines are preserved; lower timeframes add finer lines around them ("magnifying glass"). Execution timeframe is configurable and defaults to `1h`.
- `signal.ts` — the decision:
  - Action Line = the execution-timeframe line whose break is confirmed by a **candle close** (never a wick). Bearish break up ⇒ LONG; bullish break down ⇒ SHORT. No higher-timeframe directional veto.
  - Break freshness: fire only when the break candle is the most recent confirmed close and the line was `active` in the previously persisted state. On restart the state is rebuilt and pre-existing breaks are marked `broken` without triggering.
  - Safety Line = the opposing line (long ⇒ nearest active bullish line below price; short ⇒ nearest active bearish line above price). Required — no Safety Line, no trade.
- `risk.ts` — `sizeFromRisk({ equity, riskPct, entry, stop, szDecimals, minSize, maxLeverage, feeBufferPct })`. Default risk 1%, clamped 0.25–2%. Size = riskUSD / |entry − stop|, rounded to `szDecimals`, then capped by leverage/exposure limits. Leverage never changes the account-risk percentage.
- `trail.ts` — `ratchetSafetyStop(side, currentStop, safetyLineValue, bufferPct)`: long stop may only rise, short may only fall; violation of the safety line ⇒ exit with reason `safety_line` (or `trailing_stop` once the stop has moved into profit; `stop_loss` only while still at the initial stop).

Deleted/retired: `evaluateSignal` / `evaluateMultiTimeframeSignal` internals in `strategy.ts` (file reduced to the correlation `bucket` helper + re-exports), and `evaluateScalp` for this strategy. `trendbotStrategy.ts` stays importable but is no longer the default and is removed from the active selector.

## Wiring

**Server agent (`src/lib/agent.server.ts`)**
- Replace the single-interval loader with a multi-timeframe loader that fetches `1M/1W/1D/4h/1h` (plus sub-hour when configured) per coin via `candleSnapshot`, dropping the in-progress candle for each.
- Cache higher timeframes across cycles keyed by `coin:interval:barOpen` so they refetch only on their own candle close; only the execution timeframe refetches every cycle. Reduce `SCAN_PER_CYCLE` and rotate the universe so the added request volume stays inside the cycle budget.
- Entry: use `signal.ts`; write `stop_loss` from the safety line + buffer, `take_profit` NULL, size from `risk.ts`.
- Exit management: ratchet the stop from the *current* safety line each cycle, close on safety-line violation. No `tp_rr`, no `updateTrail`, no percentage TP for this strategy.
- AI review, correlation bucket cap, exposure cap, max positions, daily-loss breaker, kill switch, live reconciliation, order fills/retries and paper/live separation all stay exactly as they are.

**Browser paper engine (`src/lib/paperEngine.ts`)**
- Fetch the same timeframe ladder, call the same `signal.ts`/`risk.ts`/`trail.ts`. No duplicated decision logic.

## Database

One migration:
- `ALTER TABLE public.paper_positions ALTER COLUMN take_profit DROP NOT NULL;`
- Add nullable `safety_line numeric`, `action_line numeric`, `timeframe text`, `initial_stop numeric`, `risk_pct numeric` for logging.
- Backfill `bot_settings.strategy_key` rows that are not `trendbot_momentum` to `trendline_price_action` and change the column default; keep the existing check constraint updated to the two valid keys.
- Add `trendline_risk_pct` (default 1) and `execution_timeframe` (default `1h`) to `bot_settings`, plus a `safety_buffer_pct`.

## UI

- `src/routes/_authenticated/strategy.tsx`: rewrite the copy for the real rules — Monthly→Weekly→Daily→4H→1H top-down, Action Line break gives direction (bearish break = long, bullish break = short), Safety Line is the dynamic trailing stop, 1% default risk, no indicators and no fixed TP. Remove the Bollinger/EMA/RSI/MACD/ATR summary and the ATR/fixed-SL/TP-ratio fields for this strategy (they remain only under TrendBot). Show current strategy key, execution timeframe, risk %, pivot strength, touch tolerance.
- Selector: `Trendline Price Action` is canonical and default; Bollinger option removed; TrendBot kept as a clearly-marked legacy option.
- Positions/dashboard: show Safety Line as the stop, drop the TP column for trendline trades.
- If the chart supports line overlays, draw bullish lines green, bearish red, and label Action / Safety line.

## Logging

Each signal and trade event records: timeframe, action line type+value, safety line type+value, direction, entry, initial stop, current trailing stop, risk %, size, and exit reason — into `bot_events.meta` and the position `reason`/`indicators` columns, so it surfaces in the trade log.

## Tests and validation

- Add `vitest` as a dev dependency and `src/lib/trendline/__tests__/`, covering: bullish line creation, bearish line creation, point-B chaining, intersection rejection, touch counting, confirmed-pivot non-repainting, bearish break ⇒ LONG, bullish break ⇒ SHORT, opposing safety-line selection, long stop ratchets up only, short stop ratchets down only, old break does not re-trigger after restart, and 1%-risk position sizing.
- A deterministic replay test feeds a synthetic series bar-by-bar and asserts that signals produced at index *i* are unchanged when future bars are appended (no look-ahead).
- Run `tsgo --noEmit`, `eslint`, and a production build.

## Assumptions

- Monthly/weekly history from Hyperliquid is short for newer perps; symbols without enough history for a timeframe simply contribute no lines at that level rather than being skipped entirely.
- Execution timeframe defaults to `1h`, matching the current cron cadence; sub-hour execution is supported by the engine but needs a faster cron to be useful.
- The AI review step stays in place as a veto only (it can never flip direction).
