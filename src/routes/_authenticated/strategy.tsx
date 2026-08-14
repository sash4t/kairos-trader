import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useBot } from "@/lib/botContext";
import { MODE_MIN_CONFIDENCE, TRENDLINE_STRATEGY_KEY } from "@/lib/strategy";
import { TRENDLINE_BREAK_KEY, TB_DEFAULTS, TB_TIMEFRAMES, parseTimeframes } from "@/lib/strategies/trendlineBreak";
import { INTRADAY_PULLBACK_KEY, INTRADAY_DEFAULTS } from "@/lib/strategies/intradayMomentumPullback";
import { strategySelectionPatch } from "@/lib/scalp";

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
  const tf = parseTimeframes(s.tb_timeframes);
  const set = (patch: any) => saveSettings(patch);

  return (
    <div className="space-y-8 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-xl font-semibold sm:text-2xl">Strategy & risk</h1>
        <p className="text-sm text-muted-foreground">
          Three genuinely different models. Trendline Price Action and Trendline Break trade structural
          breakouts on higher timeframes. Intraday Momentum Pullback trades pullbacks on the 15m inside
          an existing trend — giving the bot more opportunity without simply stacking more breakout filters.
        </p>
      </div>

      {/* ── Strategy selector ── */}
      <section className="panel space-y-4 p-4 sm:p-5">
        <div>
          <div className="text-sm font-semibold">Active strategy</div>
          <p className="mt-1 text-xs text-muted-foreground">
            All three strategies use risk-based position sizing: quantity is derived from equity × risk %
            divided by the actual stop distance, then capped by the global exposure limits.
          </p>
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          <StrategyCard
            active={key === TRENDLINE_STRATEGY_KEY}
            title="Trendline Price Action"
            description="Daily → 4H → 1H directional structure. Safety-line stop with ~0.40% equity risk and 2.2R target."
            onClick={() => set(strategySelectionPatch(TRENDLINE_STRATEGY_KEY))}
          />
          <StrategyCard
            active={isTb}
            title="Trendline Break"
            description="Multi-timeframe action-line breakout. Opposing safety-line stop; ATR volatility gate; RSI/MACD/volume improve confidence rather than blocking entry."
            onClick={() => set(strategySelectionPatch(TRENDLINE_BREAK_KEY))}
          />
          <StrategyCard
            active={isIntraday}
            badge="High frequency"
            title="Intraday Momentum Pullback"
            description="4H regime → 1H trend → 15m entry. Enters EMA20 pullback rejections inside an established trend. Structural + ATR stop sized to ~0.40% equity risk."
            onClick={() => set(strategySelectionPatch(INTRADAY_PULLBACK_KEY))}
          />
        </div>
      </section>

      {/* ── Intraday Momentum Pullback details ── */}
      {isIntraday && (
        <section className="panel space-y-4 p-4 sm:p-5">
          <div className="text-sm font-semibold">Intraday Momentum Pullback — how it works</div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
            <div className="rounded-md border border-panel-border p-3">
              <span className="text-muted-foreground">Risk / trade</span>
              <div className="mt-1 mono text-base">{INTRADAY_DEFAULTS.riskPct}%</div>
            </div>
            <div className="rounded-md border border-panel-border p-3">
              <span className="text-muted-foreground">Position cap</span>
              <div className="mt-1 mono text-base">{INTRADAY_DEFAULTS.positionSizePct}% equity</div>
            </div>
            <div className="rounded-md border border-panel-border p-3">
              <span className="text-muted-foreground">Target</span>
              <div className="mt-1 mono text-base">{INTRADAY_DEFAULTS.takeProfitR}R</div>
            </div>
            <div className="rounded-md border border-panel-border p-3">
              <span className="text-muted-foreground">Profit protection</span>
              <div className="mt-1 mono text-base">BE ~1R / trail ~1.5R</div>
            </div>
          </div>
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>
              <strong className="text-foreground">Stop model:</strong> the initial stop is placed beyond
              the most recent 8-bar swing extreme plus an ATR buffer — not a fixed 1% of price. Because
              the stop distance varies with market conditions, the quantity is always derived from
              equity × risk % ÷ stop distance, so every trade risks the same percentage of equity.
            </p>
            <p>
              <strong className="text-foreground">Profit trail:</strong> at ~1R the stop moves toward
              breakeven; from ~1.5R it switches to an ATR/price trailing stop. This adapts to crypto
              volatility instead of triggering at a fixed price gain on every asset.
            </p>
            <p>
              <strong className="text-foreground">Confirmations:</strong> RSI, MACD histogram, and
              volume contribute to the confidence score but do not veto structurally valid setups.
              Low volume or a MACD that hasn't turned yet reduces confidence; it does not kill the trade.
            </p>
          </div>
        </section>
      )}

      {/* ── Trendline Break cascade ── */}
      {isTb && (
        <section className="panel space-y-5 p-4 sm:p-5">
          <div>
            <div className="text-sm font-semibold">Trendline Break — cascade & risk</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Keep at least two timeframes. The last selected timeframe is the execution timeframe where
              the fresh action-line break is detected.
            </p>
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
            <NumField label="Pivot strength" value={Number(s.tb_pivot_strength ?? TB_DEFAULTS.pivotStrength)}
              onChange={v => set({ tb_pivot_strength: Math.min(10, Math.max(2, Math.round(v))) })} />
            <NumField label="Risk per trade" value={Number(s.tb_risk_pct ?? 0.4)}
              onChange={v => set({ tb_risk_pct: Math.min(2, Math.max(0.05, v)) })} step={0.05} suffix="% equity" />
            <NumField label="Position size cap" value={Number(s.tb_position_size_pct ?? 6)}
              onChange={v => set({ tb_position_size_pct: Math.min(25, Math.max(0.5, v)) })} step={0.5} suffix="% equity" />
            <NumField label="Line refresh" value={Number(s.tb_refresh_min ?? TB_DEFAULTS.refreshMin)}
              onChange={v => set({ tb_refresh_min: Math.min(1440, Math.max(1, Math.round(v))) })} suffix="minutes" />
          </div>
          <div className="rounded-md border border-panel-border bg-muted/20 p-3 text-xs text-muted-foreground">
            The ATR14 volatility gate (0.15–6%) is the only hard filter. EMA20/50/200 alignment, RSI,
            MACD histogram and volume all adjust the confidence score rather than blocking entry outright —
            so a clean structural break with weak momentum still trades, at a lower confidence.
          </div>
        </section>
      )}

      {/* ── Global risk limits ── */}
      <section className="panel space-y-5 p-4 sm:p-5">
        <div className="text-sm font-semibold">Global risk limits</div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          <NumField label="Paper equity" value={settings.paper_equity}
            onChange={v => set({ paper_equity: v })} step={100} suffix="USDC" />
          <NumField label="Max leverage" value={settings.max_leverage}
            onChange={v => set({ max_leverage: Math.min(20, Math.max(1, Math.round(v))) })} suffix="x" />
          <NumField label="Max exposure" value={settings.max_exposure_pct}
            onChange={v => set({ max_exposure_pct: Math.min(100, Math.max(5, v)) })} step={5} suffix="% equity" />
          <NumField label="Max positions" value={settings.max_positions}
            onChange={v => set({ max_positions: Math.min(10, Math.max(1, Math.round(v))) })} />
          <NumField label="Daily loss limit" value={settings.daily_loss_pct}
            onChange={v => set({ daily_loss_pct: Math.min(10, Math.max(0.5, v)) })} step={0.5} suffix="%" />
          <NumField label="Min signal confidence" value={settings.min_confidence}
            onChange={v => set({ min_confidence: Math.min(95, Math.max(55, v)) })} step={5} suffix="%" />
        </div>
        <div className="rounded-md border border-panel-border bg-muted/20 p-3 text-xs text-muted-foreground">
          <strong className="text-foreground">Leverage cap:</strong> your Max Leverage setting always
          caps the leverage applied to every position. The exchange asset limit provides a second ceiling —
          the effective leverage is <code>min(your max leverage, asset max leverage)</code>. No strategy
          bypasses this cap.
        </div>
        <div className="rounded-md border border-panel-border bg-muted/20 p-3 text-xs text-muted-foreground">
          Paper engine defaults: risk sized from the actual stop distance; stops never loosen; at ~1R
          the stop moves toward breakeven and from ~1.5R it trails the best price.
        </div>
      </section>

      {/* ── Trendline Price Action confidence mode ── */}
      {key === TRENDLINE_STRATEGY_KEY && (
        <section className="panel space-y-4 p-4 sm:p-5">
          <div className="text-sm font-semibold">Trendline Price Action — confidence mode</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {(["conservative", "balanced", "aggressive"] as const).map(m => (
              <button key={m}
                onClick={() => set({ strategy_mode: m, min_confidence: MODE_MIN_CONFIDENCE[m] })}
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
