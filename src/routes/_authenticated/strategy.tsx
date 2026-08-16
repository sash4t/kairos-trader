import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useBot } from "@/lib/botContext";
import { MODE_MIN_CONFIDENCE, TRENDLINE_STRATEGY_KEY } from "@/lib/strategy";
import { TRENDLINE_BREAK_KEY, TB_DEFAULTS, TB_TIMEFRAMES, parseTimeframes } from "@/lib/strategies/trendlineBreak";
import { INTRADAY_PULLBACK_KEY, INTRADAY_DEFAULTS } from "@/lib/strategies/intradayMomentumPullback";
import { ORIGINAL_TREND_PRICE_ACTION_KEY, ORIGINAL_TPA_DEFAULTS } from "@/lib/strategies/originalTrendPriceAction";
import { VOLATILITY_SQUEEZE_BREAKOUT_KEY, SQUEEZE_DEFAULTS } from "@/lib/strategies/volatilitySqueezeBreakout";
import { RSI_EXTREMES_KEY, RSI_EXTREMES_DEFAULTS } from "@/lib/strategies/rsiExtremes";
import { MAX_OPEN_POSITIONS, strategySelectionPatch } from "@/lib/scalp";

export const Route = createFileRoute("/_authenticated/strategy")({ component: Strategy });

function NumField({ label, value, onChange, step = 1, suffix }: {
  label: string; value: number; onChange: (v: number) => void; step?: number; suffix?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === "" || Number.isNaN(n)) return setDraft(String(value));
    if (n !== value) onChange(n);
  };
  return (
    <label className="block">
      <div className="mb-1.5 text-xs uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="flex items-center rounded-md border border-panel-border bg-background">
        <input type="number" inputMode="decimal" step={step} value={draft}
          onChange={e => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="w-full min-w-0 bg-transparent px-3 py-2 mono text-sm outline-none" />
        {suffix && <span className="pr-3 text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </label>
  );
}

function StrategyCard({ active, title, description, badge, onClick }: {
  active: boolean; title: string; description: string; badge?: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className={`rounded-md border p-4 text-left transition ${active ? "border-primary bg-primary/10" : "border-panel-border bg-background hover:bg-accent"}`}>
      <div className="flex items-center gap-2">
        <div className="text-sm font-semibold">{title}</div>
        {badge && <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-primary/15 text-primary">{badge}</span>}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{description}</div>
    </button>
  );
}

function Strategy() {
  const { settings, saveSettings } = useBot();
  if (!settings) return <div className="p-8 text-sm text-muted-foreground">Loading strategy settings…</div>;
  const s = settings as any;
  const key = s.strategy_key || TRENDLINE_STRATEGY_KEY;
  const isTb = key === TRENDLINE_BREAK_KEY;
  const isIntraday = key === INTRADAY_PULLBACK_KEY;
  const isOriginal = key === ORIGINAL_TREND_PRICE_ACTION_KEY;
  const isSqueeze = key === VOLATILITY_SQUEEZE_BREAKOUT_KEY;
  const isRsi = key === RSI_EXTREMES_KEY;
  const tf = parseTimeframes(s.tb_timeframes);
  const set = (patch: any) => saveSettings(patch);

  return (
    <div className="space-y-8 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-xl font-semibold sm:text-2xl">Strategy & risk</h1>
        <p className="text-sm text-muted-foreground">
          Six strategy models are available. Choose the market behavior you want Kairos to trade, while global leverage,
          exposure, position-count and daily-loss controls remain in force.
        </p>
      </div>

      <section className="panel space-y-4 p-4 sm:p-5">
        <div>
          <div className="text-sm font-semibold">Active strategy</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Every strategy is still capped by the global leverage, exposure, position-count and daily-loss limits.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <StrategyCard
            active={key === TRENDLINE_STRATEGY_KEY}
            title="Trendline Price Action"
            description="Daily → 4H → 1H directional structure. Safety-line stop with ~0.40% equity risk and 2.2R target."
            onClick={() => set(strategySelectionPatch(TRENDLINE_STRATEGY_KEY))}
          />
          <StrategyCard
            active={isTb}
            title="Trendline Break"
            description="Multi-timeframe action-line breakout. Opposing safety-line stop; ATR volatility gate; momentum inputs improve confidence."
            onClick={() => set(strategySelectionPatch(TRENDLINE_BREAK_KEY))}
          />
          <StrategyCard
            active={isIntraday}
            badge="High frequency"
            title="Intraday Momentum Pullback"
            description="4H regime → 1H trend → 15m entry. Enters EMA20 pullback rejections inside an established trend."
            onClick={() => set(strategySelectionPatch(INTRADAY_PULLBACK_KEY))}
          />
          <StrategyCard
            active={isOriginal}
            badge="Classic"
            title="Original Trend Price Action"
            description="1H trend-line break + EMA20/50, RSI, MACD, volume and ATR confidence. 4H drives direction; Daily cannot oppose."
            onClick={() => set(strategySelectionPatch(ORIGINAL_TREND_PRICE_ACTION_KEY))}
          />
          <StrategyCard
            active={isSqueeze}
            badge="Rotation"
            title="Volatility Squeeze Breakout"
            description="15m momentum breakout: 4-candle range break + ≥1.2x volume + non-extreme 1H RSI. A recent squeeze boosts confidence but is not required."
            onClick={() => set(strategySelectionPatch(VOLATILITY_SQUEEZE_BREAKOUT_KEY))}
          />
          <StrategyCard
            active={isRsi}
            badge="Mean reversion"
            title="1H RSI Trail"
            description="Trail completed 1H RSI above 70 or below 30, enter on the first reversal, then close at the configured percentage take profit."
            onClick={() => set(strategySelectionPatch(RSI_EXTREMES_KEY))}
          />
        </div>
      </section>

      {isRsi && (
        <section className="panel space-y-4 p-4 sm:p-5">
          <div className="text-sm font-semibold">1H RSI Extremes — model</div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Entry long</span><div className="mt-1 mono text-base">Trail ≤{RSI_EXTREMES_DEFAULTS.oversold} → reverse up</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Entry short</span><div className="mt-1 mono text-base">Trail ≥{RSI_EXTREMES_DEFAULTS.overbought} → reverse down</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Profit exit</span><div className="mt-1 mono text-base">Configured {Number(s.scalp_tp_pct ?? 1)}% TP</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Price stop</span><div className="mt-1 mono text-base">None</div></div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs">
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Scanner</span><div className="mt-1 mono text-base">All eligible / every 1m</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">RSI period</span><div className="mt-1 mono text-base">1H RSI({RSI_EXTREMES_DEFAULTS.period})</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Leverage cap</span><div className="mt-1 mono text-base">{RSI_EXTREMES_DEFAULTS.maxLeverage}x</div></div>
          </div>
          <div className="max-w-sm">
            <NumField
              label="Position size"
              value={Number(s.position_size_pct ?? 5)}
              onChange={v => set({ position_size_pct: Math.min(100, Math.max(0.1, v)) })}
              step={0.5}
              suffix="% equity"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            This strategy deliberately uses RSI only for the trading thesis. It trails the RSI peak above 70 or trough below 30 and enters on the first reversal confirmed by a completed 1H candle,
            then exits at the configured percentage take profit. Deeper extremes and faster RSI reversals increase confidence. EMA, MACD, volume, ATR,
            trendlines and higher-timeframe direction do not gate entries or exits. It has no price stop; global exposure and daily-loss controls still apply.
          </p>
        </section>
      )}

      {isSqueeze && (
        <section className="panel space-y-4 p-4 sm:p-5">
          <div className="text-sm font-semibold">Volatility Squeeze Breakout — model</div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Scanner</span><div className="mt-1 mono text-base">Top {SQUEEZE_DEFAULTS.scanLimit} / every 5m</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Breakout</span><div className="mt-1 mono text-base">Prior {SQUEEZE_DEFAULTS.breakoutLookback} bars</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Risk / stop</span><div className="mt-1 mono text-base">{SQUEEZE_DEFAULTS.riskPct}% / {SQUEEZE_DEFAULTS.stopPct}%</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Breakout volume</span><div className="mt-1 mono text-base">≥ {SQUEEZE_DEFAULTS.minVolumeRatio}x avg</div></div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Breakeven</span><div className="mt-1 mono text-base">+{SQUEEZE_DEFAULTS.breakevenAtPct}%</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Scale out</span><div className="mt-1 mono text-base">50% @ +{SQUEEZE_DEFAULTS.partialAtPct}%</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Runner trail</span><div className="mt-1 mono text-base">Peak - {SQUEEZE_DEFAULTS.trailPct}%</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Time exits</span><div className="mt-1 mono text-base">{SQUEEZE_DEFAULTS.staleMinutes}m stale / {SQUEEZE_DEFAULTS.maxMinutes}m max</div></div>
          </div>
          <p className="text-xs text-muted-foreground">
            A completed 15m close beyond the prior {SQUEEZE_DEFAULTS.breakoutLookback}-candle high/low with at least {SQUEEZE_DEFAULTS.minVolumeRatio}x the prior 20-candle average volume is the core gate.
            The 1H RSI must be non-extreme. A recent BB/KC squeeze, EMA20 directional agreement, BB expansion and stronger volume add confidence but do not block an otherwise valid breakout.
          </p>
          <p className="text-xs text-muted-foreground">
            At +{SQUEEZE_DEFAULTS.breakevenAtPct}% the stop moves to entry. At +{SQUEEZE_DEFAULTS.partialAtPct}% the engine closes 50% and trails the remaining half by {SQUEEZE_DEFAULTS.trailPct}% from the best price.
            A trade that never travels {SQUEEZE_DEFAULTS.staleMovePct}% in either direction by {SQUEEZE_DEFAULTS.staleMinutes} minutes is closed; every trade is force-closed after {SQUEEZE_DEFAULTS.maxMinutes} minutes.
          </p>
        </section>
      )}

      {isOriginal && (
        <section className="panel space-y-4 p-4 sm:p-5">
          <div className="text-sm font-semibold">Original Trend Price Action — model</div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Execution</span><div className="mt-1 mono text-base">1H trend line</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Volatility gate</span><div className="mt-1 mono text-base">ATR14 {ORIGINAL_TPA_DEFAULTS.atrMinPct}–{ORIGINAL_TPA_DEFAULTS.atrMaxPct}%</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Risk / trade</span><div className="mt-1 mono text-base">{Number(s.trendline_risk_pct ?? ORIGINAL_TPA_DEFAULTS.riskPct)}%</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Target</span><div className="mt-1 mono text-base">{ORIGINAL_TPA_DEFAULTS.takeProfitR}R</div></div>
          </div>
          <div className="max-w-sm">
            <NumField
              label="Risk per trade"
              value={Number(s.trendline_risk_pct ?? ORIGINAL_TPA_DEFAULTS.riskPct)}
              onChange={v => set({ trendline_risk_pct: Math.min(5, Math.max(0.05, v)) })}
              step={0.05}
              suffix="% equity"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            4H direction drives the setup. Daily may agree or be neutral, but a clearly opposing Daily trend blocks the trade. Recent 1H trend-line crossings remain actionable with confidence decay.
            EMA20/50, RSI, MACD histogram, relative volume and trend-line touch quality then raise or lower confidence. ATR is the hard volatility filter. Risk per trade is user-configurable from 0.05% to 5% of equity.
          </p>
        </section>
      )}

      {isIntraday && (
        <section className="panel space-y-4 p-4 sm:p-5">
          <div className="text-sm font-semibold">Intraday Momentum Pullback — how it works</div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Risk / trade</span><div className="mt-1 mono text-base">{INTRADAY_DEFAULTS.riskPct}%</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Position cap</span><div className="mt-1 mono text-base">{INTRADAY_DEFAULTS.positionSizePct}% equity</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Target</span><div className="mt-1 mono text-base">{INTRADAY_DEFAULTS.takeProfitR}R</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Profit protection</span><div className="mt-1 mono text-base">BE ~1R / trail ~1.5R</div></div>
          </div>
        </section>
      )}

      {isTb && (
        <section className="panel space-y-5 p-4 sm:p-5">
          <div><div className="text-sm font-semibold">Trendline Break — cascade & risk</div><p className="mt-1 text-xs text-muted-foreground">Keep at least two timeframes. The last selected timeframe is the execution timeframe.</p></div>
          <div className="flex flex-wrap gap-2">
            {TB_TIMEFRAMES.map(t => (
              <button key={t} type="button" onClick={() => {
                const next = tf.includes(t) ? tf.filter((x: string) => x !== t) : [...tf, t];
                if (next.length >= 2) set({ tb_timeframes: parseTimeframes(next.join(",")).join(",") });
              }} className={`rounded-md border px-3 py-1.5 mono text-xs ${tf.includes(t) ? "border-primary bg-primary/10" : "border-panel-border hover:bg-muted/40"}`}>
                {t}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
            <NumField label="Pivot strength" value={Number(s.tb_pivot_strength ?? TB_DEFAULTS.pivotStrength)} onChange={v => set({ tb_pivot_strength: Math.min(10, Math.max(2, Math.round(v))) })} />
            <NumField label="Risk per trade" value={Number(s.tb_risk_pct ?? 0.4)} onChange={v => set({ tb_risk_pct: Math.min(2, Math.max(0.05, v)) })} step={0.05} suffix="% equity" />
            <NumField label="Position size cap" value={Number(s.tb_position_size_pct ?? 6)} onChange={v => set({ tb_position_size_pct: Math.min(25, Math.max(0.5, v)) })} step={0.5} suffix="% equity" />
            <NumField label="Line refresh" value={Number(s.tb_refresh_min ?? TB_DEFAULTS.refreshMin)} onChange={v => set({ tb_refresh_min: Math.min(1440, Math.max(1, Math.round(v))) })} suffix="minutes" />
          </div>
        </section>
      )}

      <section className="panel space-y-5 p-4 sm:p-5">
        <div className="text-sm font-semibold">Global risk limits</div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          <NumField label="Paper equity" value={settings.paper_equity} onChange={v => set({ paper_equity: v })} step={100} suffix="USDC" />
          <NumField label="Max leverage" value={settings.max_leverage} onChange={v => set({ max_leverage: Math.min(20, Math.max(1, Math.round(v))) })} suffix="x" />
          <NumField label="Max exposure" value={settings.max_exposure_pct} onChange={v => set({ max_exposure_pct: Math.min(100, Math.max(5, v)) })} step={5} suffix="% equity" />
          <NumField label="Max positions" value={settings.max_positions} onChange={v => set({ max_positions: Math.min(MAX_OPEN_POSITIONS, Math.max(1, Math.round(v))) })} />
          <NumField label="Daily loss limit" value={settings.daily_loss_pct} onChange={v => set({ daily_loss_pct: Math.min(10, Math.max(0.5, v)) })} step={0.5} suffix="%" />
          <NumField label="Min signal confidence" value={settings.min_confidence} onChange={v => set({ min_confidence: Math.min(95, Math.max(55, v)) })} step={5} suffix="%" />
        </div>
      </section>

      {key === TRENDLINE_STRATEGY_KEY && (
        <section className="panel space-y-4 p-4 sm:p-5">
          <div className="text-sm font-semibold">Trendline Price Action — confidence mode</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {(["conservative", "balanced", "aggressive"] as const).map(m => (
              <button key={m} onClick={() => set({ strategy_mode: m, min_confidence: MODE_MIN_CONFIDENCE[m] })}
                className={`rounded-md border p-4 text-left ${settings.strategy_mode === m ? "border-primary bg-primary/10" : "border-panel-border bg-background hover:bg-accent"}`}>
                <div className="text-sm font-semibold capitalize">{m}</div><div className="mt-1 text-xs text-muted-foreground">{MODE_MIN_CONFIDENCE[m]}% baseline confidence.</div>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
