import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useBot } from "@/lib/botContext";
import { MODE_MIN_CONFIDENCE } from "@/lib/strategy";

export const Route = createFileRoute("/_authenticated/strategy")({
  component: Strategy,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-bear">Strategy failed to load: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-6 text-sm text-muted-foreground">Strategy not found.</div>,
});

function NumField({ label, value, onChange, step = 1, suffix }: { label: string; value: number; onChange: (v: number) => void; step?: number; suffix?: string }) {
  // Keep a local draft so typing on mobile keyboards isn't clobbered by re-renders.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === "" || Number.isNaN(n)) { setDraft(String(value)); return; }
    if (n !== value) onChange(n);
  };

  return (
    <label className="block">
      <div className="mb-1.5 text-xs uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="flex items-center rounded-md border border-panel-border bg-background">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="w-full min-w-0 bg-transparent px-3 py-2 mono text-sm outline-none"
        />
        {suffix && <span className="shrink-0 pr-3 text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </label>
  );
}

function Strategy() {
  const { settings, saveSettings } = useBot();
  if (!settings) {
    return (
      <div className="space-y-4 p-4 sm:p-6 lg:p-8">
        <div className="h-6 w-48 animate-pulse rounded bg-muted" />
        <div className="h-32 animate-pulse rounded-md bg-muted" />
        <div className="h-56 animate-pulse rounded-md bg-muted" />
      </div>
    );
  }

  const modes = [
    { key: "conservative", label: "Conservative", desc: "80%+ confidence · lower frequency · smaller size" },
    { key: "balanced", label: "Balanced", desc: "70%+ confidence · moderate risk" },
    { key: "aggressive", label: "Aggressive", desc: "60%+ confidence · more trades" },
  ] as const;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-8">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold">Strategy & risk</h1>
        <p className="text-sm text-muted-foreground">All limits enforced by the paper engine on every trade evaluation.</p>
      </div>

      <div className="panel p-4 sm:p-5">
        <div className="text-sm font-semibold">Trading mode</div>
        <div className="mt-1 text-xs text-muted-foreground">Only paper trading is available in the browser. Live 24/7 execution requires the standalone executor service.</div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {modes.map(m => (
            <button key={m.key} onClick={() => saveSettings({ strategy_mode: m.key, min_confidence: MODE_MIN_CONFIDENCE[m.key] })}
              className={`rounded-md border p-4 text-left ${settings.strategy_mode === m.key ? "border-primary bg-primary/10" : "border-panel-border bg-background hover:bg-accent"}`}>
              <div className="text-sm font-semibold">{m.label}</div>
              <div className="mt-1 text-xs text-muted-foreground">{m.desc}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="panel p-4 sm:p-5 space-y-5">
        <div className="text-sm font-semibold">Risk limits</div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          <NumField label="Paper equity" value={settings.paper_equity} onChange={v => saveSettings({ paper_equity: v })} step={100} suffix="USDC" />
          <NumField label="Max leverage" value={settings.max_leverage} onChange={v => saveSettings({ max_leverage: Math.min(20, Math.max(1, v)) })} step={1} suffix="x" />
          <NumField label="Position size" value={settings.position_size_pct} onChange={v => saveSettings({ position_size_pct: Math.min(10, Math.max(0.5, v)) })} step={0.5} suffix="% equity" />
          <NumField label="Max exposure" value={settings.max_exposure_pct} onChange={v => saveSettings({ max_exposure_pct: Math.min(100, Math.max(5, v)) })} step={5} suffix="% equity" />
          <NumField label="Max positions" value={settings.max_positions} onChange={v => saveSettings({ max_positions: Math.min(10, Math.max(1, Math.round(v))) })} step={1} />
          <NumField label="Daily loss limit" value={settings.daily_loss_pct} onChange={v => saveSettings({ daily_loss_pct: Math.min(20, Math.max(1, v)) })} step={0.5} suffix="%" />
          <div className="space-y-1.5">
            <NumField label="Min signal confidence" value={settings.min_confidence} onChange={v => saveSettings({ min_confidence: Math.min(100, Math.max(50, v)) })} step={5} suffix="%" />
            <p className="text-xs text-muted-foreground">Works together with the trading mode above — the higher of the two values is used.</p>
          </div>
        </div>
      </div>

      <div className="panel p-4 sm:p-5 space-y-5">
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          ⚠️ These exit rules apply to the <strong>browser paper engine only</strong> (active when the server agent is off).
          When the 24/7 server agent is running, configure exits in Settings → Autonomous agent panel instead.
        </div>
        <div className="text-sm font-semibold">Exit rules</div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
          <label className="block">
            <div className="mb-1.5 text-xs uppercase tracking-widest text-muted-foreground">Stop-loss type</div>
            <select value={settings.sl_type} onChange={e => saveSettings({ sl_type: e.target.value as any })}
              className="w-full rounded-md border border-panel-border bg-background px-3 py-2 text-sm mono">
              <option value="atr">ATR-based</option><option value="fixed">Fixed %</option>
            </select>
          </label>
          <NumField label="ATR multiplier" value={settings.sl_atr_mult} onChange={v => saveSettings({ sl_atr_mult: v })} step={0.1} />
          <NumField label="Fixed SL %" value={settings.sl_fixed_pct} onChange={v => saveSettings({ sl_fixed_pct: v })} step={0.1} suffix="%" />
          <NumField label="TP / SL ratio" value={settings.tp_rr} onChange={v => saveSettings({ tp_rr: v })} step={0.25} suffix=":1" />
          <label className="flex items-center gap-3 sm:col-span-2">
            <input type="checkbox" checked={settings.trailing_enabled} onChange={e => saveSettings({ trailing_enabled: e.target.checked })} />
            <div>
              <div className="text-sm font-medium">Trailing stop</div>
              <div className="text-xs text-muted-foreground">Ratchet stop-loss up when trade moves 1R in profit</div>
            </div>
          </label>
        </div>
      </div>

      <div className="panel p-4 sm:p-5 text-xs text-muted-foreground space-y-2">
        <div className="mono uppercase tracking-widest text-warning">Strategy summary</div>
        <p>
          <strong>Bollinger breakout in trend</strong> on <strong>1-hour</strong> Hyperliquid perp bars, long and short.
          Entry when price closes beyond the <strong>2.0σ Bollinger band (period 20)</strong> on the trend side of the
          <strong> SMA 200</strong>, with RSI confirming direction, inside an ATR band of <strong>0.5%–6%</strong>.
          Exits: fixed <strong>12% take-profit</strong>, <strong>1.5% stop</strong>, and a <strong>1.2% trailing stop</strong>
          armed once the trade is <strong>1.5%</strong> in profit — the trail supplies most of the edge.
          Max hold <strong>24 bars</strong>. Correlation guard caps 3 positions per sector.
          Leverage is always <strong>min(your max leverage, exchange max leverage)</strong>.
        </p>
        <p className="mono text-warning">
          BTC rapid-move safeguard: a BTC move of <strong>2.0%+ over 15 minutes</strong> (1m candles) instantly flattens
          positions fighting the move — a drop closes longs, a spike closes shorts — and blocks new entries on that side.
        </p>
        <p className="mono text-bull">
          Historical backtest — top 20 Hyperliquid perps, ~40 days of 1h bars, taker fees and slippage
          included (0.16% round trip), no intrabar lookahead: <strong>329 trades · 80% win rate ·
          profit factor 1.72 · +10.3% · 0.9% max drawdown</strong>.
        </p>
        <p>
          Historical context only, not a guarantee: one month of data across a single market regime is a
          short sample. Forward-test on paper before committing size.
        </p>

      </div>



    </div>
  );
}
