import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useBot } from "@/lib/botContext";
import { MODE_MIN_CONFIDENCE } from "@/lib/strategy";
import { TB_DEFAULTS, TB_TIMEFRAMES, parseTimeframes } from "@/lib/strategies/trendlineBreak";

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

function Strategy() {
  const { settings, saveSettings } = useBot();
  if (!settings) return <div className="p-8 text-sm text-muted-foreground">Loading strategy settings…</div>;
  const s = settings as any;
  const isTrendline = s.strategy_key === "trendline-break";
  const tf = parseTimeframes(s.tb_timeframes);
  const set = (patch: any) => saveSettings(patch);

  return (
    <div className="space-y-8 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-xl font-semibold sm:text-2xl">Strategy & risk</h1>
        <p className="text-sm text-muted-foreground">Select the trading model and configure its risk controls.</p>
      </div>

      <section className="panel space-y-4 p-4 sm:p-5">
        <div>
          <div className="text-sm font-semibold">Selectable strategy</div>
          <p className="mt-1 text-xs text-muted-foreground">Trendline Price Action is the transcript-based pure price-action strategy. Other legacy strategies remain available only if explicitly retained by your installation.</p>
        </div>
        <button onClick={() => set({ strategy_key: "trendline-break" })}
          className={`w-full rounded-md border p-4 text-left ${isTrendline ? "border-primary bg-primary/10" : "border-panel-border bg-background hover:bg-accent"}`}>
          <div className="text-sm font-semibold">Trendline Price Action</div>
          <div className="mt-1 text-xs text-muted-foreground">Weekly → Daily → 4H → 1H → 30m → 15m · action-line entries · opposing safety-line trailing stop · no indicators required.</div>
        </button>
      </section>

      {isTrendline && (
        <>
          <section className="panel space-y-5 p-4 sm:p-5">
            <div>
              <div className="text-sm font-semibold">Trendline cascade</div>
              <p className="mt-1 text-xs text-muted-foreground">Monthly is intentionally excluded because many Hyperliquid pairs do not have enough monthly history. The default execution timeframe is 15m.</p>
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
              <NumField label="Risk per trade" value={Number(s.tb_risk_pct ?? TB_DEFAULTS.riskPct)} onChange={v => set({ tb_risk_pct: Math.min(10, Math.max(0.05, v)) })} step={0.25} suffix="% equity" />
              <NumField label="Position size cap" value={Number(s.tb_position_size_pct ?? TB_DEFAULTS.positionSizePct)} onChange={v => set({ tb_position_size_pct: Math.min(100, Math.max(0.1, v)) } as any)} step={0.5} suffix="% equity" />
              <NumField label="Line refresh" value={Number(s.tb_refresh_min ?? TB_DEFAULTS.refreshMin)} onChange={v => set({ tb_refresh_min: Math.min(1440, Math.max(1, Math.round(v))) })} suffix="minutes" />
            </div>
            <div className="rounded-md border border-panel-border bg-muted/20 p-3 text-xs text-muted-foreground">
              <strong className="text-foreground">Position sizing:</strong> the bot calculates the size required to risk your configured risk % at the safety-line stop, then caps it at your configured position-size allocation and portfolio exposure limit. This keeps risk and size independently adjustable.
            </div>
          </section>

          <section className="panel space-y-5 p-4 sm:p-5">
            <div>
              <div className="text-sm font-semibold">BTC emergency protection</div>
              <p className="mt-1 text-xs text-muted-foreground">A BTC move against the position is treated as a high-priority portfolio risk event before normal strategy exits.</p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <label className="flex items-center gap-3 rounded-md border border-panel-border bg-background px-3 py-2">
                <input type="checkbox" checked={s.btc_shock_enabled !== false} onChange={e => set({ btc_shock_enabled: e.target.checked })} />
                <span className="text-sm">Enable BTC shock exit</span>
              </label>
              <NumField label="BTC shock threshold" value={Number(s.btc_shock_pct ?? 1.5)} onChange={v => set({ btc_shock_pct: Math.min(20, Math.max(0.1, v)) })} step={0.1} suffix="%" />
              <NumField label="BTC shock lookback" value={Number(s.btc_shock_window_min ?? 240)} onChange={v => set({ btc_shock_window_min: Math.min(1440, Math.max(1, Math.round(v))) })} suffix="minutes" />
            </div>
            <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
              Default: <strong>1.5% within 240 minutes (4 hours)</strong>. The detector uses rolling 1-minute highs/lows, so a 1.5% drop in 15 minutes, 1 hour, 2 hours, 3 hours, or 4 hours can trigger. BTC down closes longs; BTC up closes shorts. Aligned positions remain open.
            </div>
          </section>

          <section className="panel space-y-3 p-4 sm:p-5">
            <div className="text-sm font-semibold">Leverage</div>
            <div className="rounded-md border border-bear/40 bg-bear/5 p-3 text-xs">
              <strong>Trendline trades automatically use the maximum leverage supported by each Hyperliquid asset.</strong> The generic Max Leverage setting does not cap this strategy. Leverage changes buying power, not the configured risk budget.
            </div>
          </section>
        </>
      )}

      <section className="panel space-y-5 p-4 sm:p-5">
        <div className="text-sm font-semibold">Global risk limits</div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          <NumField label="Paper equity" value={settings.paper_equity} onChange={v => set({ paper_equity: v })} step={100} suffix="USDC" />
          <NumField label="Max exposure" value={settings.max_exposure_pct} onChange={v => set({ max_exposure_pct: Math.min(100, Math.max(5, v)) })} step={5} suffix="% equity" />
          <NumField label="Max positions" value={settings.max_positions} onChange={v => set({ max_positions: Math.min(10, Math.max(1, Math.round(v))) })} />
          <NumField label="Daily loss limit" value={settings.daily_loss_pct} onChange={v => set({ daily_loss_pct: Math.min(20, Math.max(1, v)) })} step={0.5} suffix="%" />
          <NumField label="Min signal confidence" value={settings.min_confidence} onChange={v => set({ min_confidence: Math.min(100, Math.max(50, v)) })} step={5} suffix="%" />
        </div>
      </section>

      {!isTrendline && (
        <section className="panel space-y-4 p-4 sm:p-5">
          <div className="text-sm font-semibold">Legacy strategy mode</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {(["conservative", "balanced", "aggressive"] as const).map(m => (
              <button key={m} onClick={() => set({ strategy_mode: m, min_confidence: MODE_MIN_CONFIDENCE[m] })}
                className={`rounded-md border p-4 text-left ${settings.strategy_mode === m ? "border-primary bg-primary/10" : "border-panel-border bg-background hover:bg-accent"}`}>
                <div className="text-sm font-semibold capitalize">{m}</div>
                <div className="mt-1 text-xs text-muted-foreground">{MODE_MIN_CONFIDENCE[m]}% minimum confidence.</div>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
