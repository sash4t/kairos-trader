import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useBot } from "@/lib/botContext";
import { MODE_MIN_CONFIDENCE, TRENDLINE_STRATEGY_KEY } from "@/lib/strategy";
import { TRENDLINE_BREAK_KEY, TB_DEFAULTS, TB_TIMEFRAMES, parseTimeframes } from "@/lib/strategies/trendlineBreak";
import { INTRADAY_PULLBACK_KEY, INTRADAY_DEFAULTS } from "@/lib/strategies/intradayMomentumPullback";

export const Route = createFileRoute("/_authenticated/strategy")({ component: Strategy });

function NumField({ label, value, onChange, step = 1, suffix }: { label: string; value: number; onChange: (v: number) => void; step?: number; suffix?: string }) {
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
        <input type="number" inputMode="decimal" step={step} value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="w-full min-w-0 bg-transparent px-3 py-2 mono text-sm outline-none" />
        {suffix && <span className="pr-3 text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </label>
  );
}

function StrategyCard({ active, disabled, title, description, onClick }: { active: boolean; disabled?: boolean; title: string; description: string; onClick: () => void }) {
  return (
    <button disabled={disabled} onClick={onClick}
      className={`rounded-md border p-4 text-left transition ${active ? "border-primary bg-primary/10" : "border-panel-border bg-background hover:bg-accent"} ${disabled ? "cursor-not-allowed opacity-50" : ""}`}>
      <div className="text-sm font-semibold">{title}</div>
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
  const tf = parseTimeframes(s.tb_timeframes);
  const set = (patch: any) => saveSettings(patch);
  const paperOnly = settings.mode !== "paper";

  return (
    <div className="space-y-8 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-xl font-semibold sm:text-2xl">Strategy & risk</h1>
        <p className="text-sm text-muted-foreground">Three distinct models with risk-based sizing and tighter profit protection in the optimized paper engine.</p>
      </div>

      <section className="panel space-y-4 p-4 sm:p-5">
        <div>
          <div className="text-sm font-semibold">Selectable strategy</div>
          <p className="mt-1 text-xs text-muted-foreground">The optimized browser engine is paper-only. Live mode continues to use the existing server execution engine unchanged.</p>
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          <StrategyCard active={key === TRENDLINE_STRATEGY_KEY} title="Trendline Price Action"
            description="Daily → 4H → 1H directional structure. Optimized paper sizing uses the structural safety line when available, otherwise an ATR stop, with ~0.40% equity risk and 2.2R target."
            onClick={() => set({ strategy_key: TRENDLINE_STRATEGY_KEY })} />
          <StrategyCard active={isTb} title="Trendline Break"
            description="Multi-timeframe action-line breakout with opposing safety-line stop. Optimized paper sizing uses stop-distance risk sizing and R-based profit protection."
            onClick={() => set({ strategy_key: TRENDLINE_BREAK_KEY })} />
          <StrategyCard active={isIntraday} disabled={paperOnly} title="Intraday Momentum Pullback"
            description="4H → 1H → 15m trend pullbacks. Enters 15m EMA20 rejection/reclaim setups with structure + ATR stop, 0.40% default risk and 2.2R target. Paper mode only."
            onClick={() => set({ strategy_key: INTRADAY_PULLBACK_KEY, min_confidence: 65, trailing_enabled: true })} />
        </div>
        {paperOnly && <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">Switch to Paper mode to select Intraday Momentum Pullback. No new optimized strategy logic is connected to live order execution.</div>}
      </section>

      {isIntraday && (
        <section className="panel space-y-4 p-4 sm:p-5">
          <div className="text-sm font-semibold">Intraday optimized defaults</div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Risk / trade</span><div className="mt-1 mono text-base">{INTRADAY_DEFAULTS.riskPct}%</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Position cap</span><div className="mt-1 mono text-base">{INTRADAY_DEFAULTS.positionSizePct}% equity</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Target</span><div className="mt-1 mono text-base">{INTRADAY_DEFAULTS.takeProfitR}R</div></div>
            <div className="rounded-md border border-panel-border p-3"><span className="text-muted-foreground">Profit protection</span><div className="mt-1 mono text-base">BE ~1R / trail ~1.5R</div></div>
          </div>
          <p className="text-xs text-muted-foreground">Entries require aligned 4H/1H trend, a 15m pullback to EMA20, a rejection/reclaim candle and acceptable volatility. RSI, MACD and volume improve confidence instead of acting as absolute entry vetoes.</p>
        </section>
      )}

      {isTb && (
        <section className="panel space-y-5 p-4 sm:p-5">
          <div>
            <div className="text-sm font-semibold">Trendline cascade</div>
            <p className="mt-1 text-xs text-muted-foreground">Keep at least two timeframes. The last selected timeframe is the execution timeframe.</p>
          </div>
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
          <NumField label="Max positions" value={settings.max_positions} onChange={v => set({ max_positions: Math.min(10, Math.max(1, Math.round(v))) })} />
          <NumField label="Daily loss limit" value={settings.daily_loss_pct} onChange={v => set({ daily_loss_pct: Math.min(10, Math.max(0.5, v)) })} step={0.5} suffix="%" />
          <NumField label="Min signal confidence" value={settings.min_confidence} onChange={v => set({ min_confidence: Math.min(95, Math.max(55, v)) })} step={5} suffix="%" />
        </div>
        <div className="rounded-md border border-panel-border bg-muted/20 p-3 text-xs text-muted-foreground">
          Optimized paper defaults: risk is sized from the actual stop distance; leverage remains capped by your Max Leverage and the exchange asset limit; stops never loosen; at roughly +1R the stop moves toward breakeven and from roughly +1.5R it trails the best price.
        </div>
      </section>

      {key === TRENDLINE_STRATEGY_KEY && (
        <section className="panel space-y-4 p-4 sm:p-5">
          <div className="text-sm font-semibold">Trendline Price Action confidence mode</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {(["conservative", "balanced", "aggressive"] as const).map(m => (
              <button key={m} onClick={() => set({ strategy_mode: m, min_confidence: MODE_MIN_CONFIDENCE[m] })}
                className={`rounded-md border p-4 text-left ${settings.strategy_mode === m ? "border-primary bg-primary/10" : "border-panel-border bg-background hover:bg-accent"}`}>
                <div className="text-sm font-semibold capitalize">{m}</div>
                <div className="mt-1 text-xs text-muted-foreground">{MODE_MIN_CONFIDENCE[m]}% baseline confidence.</div>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
