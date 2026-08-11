import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useBot } from "@/lib/botContext";
import { supabase } from "@/integrations/supabase/client";
import { fetchUserState, type UserState } from "@/lib/hyperliquid";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AgentPanel } from "@/components/AgentPanel";
import { LiveTradingPanel } from "@/components/LiveTradingPanel";
import { resetPaperAccount } from "@/lib/paper.functions";
import { Loader2, RotateCcw } from "lucide-react";
import { MODE_MIN_CONFIDENCE } from "@/lib/strategy";
import { STRATEGY_OPTIONS, PURE_PRICE_STRATEGY_KEY, normalizeStrategyKey, type StrategyKey } from "@/lib/strategies";
import { TIMEFRAME_LADDER, type Timeframe } from "@/lib/trendline";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-bear">Settings failed to load: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-6 text-sm text-muted-foreground">Settings not found.</div>,
});

function NumField({ label, value, onChange, step = 1, suffix }: { label: string; value: number; onChange: (v: number) => void; step?: number; suffix?: string }) {
  // Local draft so mobile keyboards aren't clobbered by re-renders.
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
        <input type="number" inputMode="decimal" step={step} value={draft}
          onChange={e => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="w-full min-w-0 bg-transparent px-3 py-2 mono text-sm outline-none" />
        {suffix && <span className="shrink-0 pr-3 text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </label>
  );
}

function SettingsPage() {
  const { userId, syncPositions, settings, saveSettings } = useBot();
  const [wallet, setWallet] = useState("");
  const [saving, setSaving] = useState(false);
  const [userState, setUserState] = useState<UserState | null>(null);
  const [loadingWallet, setLoadingWallet] = useState(false);
  const [savingStrategy, setSavingStrategy] = useState(false);
  const resetFn = useServerFn(resetPaperAccount);
  const queryClient = useQueryClient();

  const strategyKey: StrategyKey = normalizeStrategyKey(settings?.strategy_key);
  const isPure = strategyKey === PURE_PRICE_STRATEGY_KEY;

  const reset = useMutation({
    mutationFn: () => resetFn({ data: undefined }),
    onSuccess: async (r) => { toast.success(`Paper account reset: ${r.closed} position(s) cleared, equity set to ${r.newEquity.toLocaleString()} USDC.`); await syncPositions(); await queryClient.invalidateQueries(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const { data: profile } = useQuery({
    queryKey: ["profile", userId], enabled: !!userId,
    queryFn: async () => (await supabase.from("profiles").select("*").eq("id", userId!).maybeSingle()).data,
  });

  const saveStrategy = async (next: StrategyKey) => {
    setSavingStrategy(true);
    try {
      await saveSettings({ strategy_key: next });
      toast.success(`Strategy changed to ${STRATEGY_OPTIONS.find(s => s.key === next)?.name}.`);
    } catch (e) { toast.error((e as Error).message); }
    finally { setSavingStrategy(false); }
  };

  const [walletTouched, setWalletTouched] = useState(false);
  useEffect(() => { if (!walletTouched) setWallet(profile?.wallet_address ?? ""); }, [profile, walletTouched]);
  const saveWallet = async () => {
    if (!userId) return; setSaving(true); const trimmed = wallet.trim();
    if (trimmed && !/^0x[a-fA-F0-9]{40}$/.test(trimmed)) { toast.error("Invalid Ethereum-style address"); setSaving(false); return; }
    const { error } = await supabase.from("profiles").upsert({ id: userId, wallet_address: trimmed || null }, { onConflict: "id" });
    setSaving(false); if (error) { toast.error(error.message); return; } setWalletTouched(false); await queryClient.invalidateQueries({ queryKey: ["profile", userId] }); toast.success("Wallet saved");
  };

  const loadHyperliquid = async () => {
    if (!wallet) return; setLoadingWallet(true);
    try { setUserState(await fetchUserState(wallet.trim())); } catch (e: any) { toast.error(e.message ?? "Failed to fetch Hyperliquid state"); } finally { setLoadingWallet(false); }
  };

  const modes = [
    { key: "conservative", label: "Conservative", desc: "80%+ confidence · lower frequency · smaller size" },
    { key: "balanced", label: "Balanced", desc: "70%+ confidence · moderate risk" },
    { key: "aggressive", label: "Aggressive", desc: "60%+ confidence · more trades" },
  ] as const;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-8 max-w-4xl">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Strategy, risk, exits, BTC shock protection, wallet and execution — all in one place.</p>
      </div>

      <div className="panel p-4 sm:p-5 space-y-4">
        <div>
          <div className="text-sm font-semibold">Trading strategy</div>
          <p className="mt-1 text-xs text-muted-foreground">Three independent strategies. The selection is per-user, persists across cycles and drives both the browser paper engine and the 24/7 server agent.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {STRATEGY_OPTIONS.map((option) => {
            const selected = strategyKey === option.key;
            return (
              <button key={option.key} type="button" onClick={() => saveStrategy(option.key)} disabled={savingStrategy || !settings}
                className={`rounded-lg border p-4 text-left transition ${selected ? "border-primary bg-primary/10" : "border-panel-border hover:bg-muted/40"}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold">{option.name}</span>
                  <span className={`h-3 w-3 shrink-0 rounded-full border ${selected ? "border-primary bg-primary" : "border-muted-foreground"}`} />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{option.description}</p>
                <div className="mt-2 mono text-[10px] uppercase tracking-widest text-primary">
                  {option.usesMaxLeverage ? "Exchange MAX leverage per market — not 1x" : "Long + Short · Hyperliquid Perps"}
                </div>
              </button>
            );
          })}
        </div>
        {savingStrategy && <div className="text-xs text-muted-foreground">Saving strategy…</div>}
      </div>

      {!settings ? (
        <div className="space-y-4">
          <div className="h-32 animate-pulse rounded-md bg-muted" />
          <div className="h-56 animate-pulse rounded-md bg-muted" />
        </div>
      ) : (
        <>
          {isPure && (
            <div className="panel p-4 sm:p-5 space-y-5">
              <div>
                <div className="text-sm font-semibold">Pure Price settings</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Positions open at each market&apos;s <strong>maximum available Hyperliquid leverage</strong> (not 1x, not a fixed % of equity risked).
                  Exposure limits, max positions, daily-loss protection and the kill switch still apply. The Safety Line is the protective stop.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block">
                  <div className="mb-1.5 text-xs uppercase tracking-widest text-muted-foreground">Execution timeframe</div>
                  <select value={settings.execution_timeframe ?? "1h"} onChange={e => saveSettings({ execution_timeframe: e.target.value as Timeframe })}
                    className="w-full rounded-md border border-panel-border bg-background px-3 py-2 text-sm mono">
                    {TIMEFRAME_LADDER.filter(tf => tf !== "1M" && tf !== "1w").map(tf => <option key={tf} value={tf}>{tf}</option>)}
                  </select>
                  <p className="mt-1.5 text-xs text-muted-foreground">Ladder always runs Monthly → Weekly → Daily → 4H → 1H, continuing down to this timeframe.</p>
                </label>
                <NumField label="Safety Line buffer" value={+(settings.safety_buffer_pct ?? 0.15)} onChange={v => saveSettings({ safety_buffer_pct: Math.min(2, Math.max(0, v)) })} step={0.05} suffix="%" />
              </div>
            </div>
          )}

          <div className="panel p-4 sm:p-5 space-y-4">
            <div>
              <div className="text-sm font-semibold">BTC shock protection</div>
              <p className="mt-1 text-xs text-muted-foreground">
                A sudden BTC drop immediately closes every open <strong>long</strong>; a sudden BTC spike closes every open <strong>short</strong>.
                Runs before ordinary stop processing and uses reduce-only orders in live mode.
              </p>
            </div>
            <label className="flex items-center gap-3">
              <input type="checkbox" checked={settings.btc_shock_enabled !== false} onChange={e => saveSettings({ btc_shock_enabled: e.target.checked })} />
              <span className="text-sm font-medium">Enable BTC shock flattening</span>
            </label>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <NumField label="Shock threshold" value={+(settings.btc_shock_pct ?? 1.5)} onChange={v => saveSettings({ btc_shock_pct: Math.min(20, Math.max(0.1, v)) })} step={0.1} suffix="%" />
              <NumField label="Look-back window" value={+(settings.btc_shock_window_min ?? 15)} onChange={v => saveSettings({ btc_shock_window_min: Math.min(240, Math.max(5, Math.round(v))) })} step={5} suffix="min" />
            </div>
          </div>

          <div className="panel p-4 sm:p-5">
            <div className="text-sm font-semibold">Trading mode</div>
            <div className="mt-1 text-xs text-muted-foreground">Sets the baseline signal confidence bar for the indicator strategies.</div>
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
            {isPure && <p className="text-xs text-muted-foreground">Max leverage and position size % do not size Pure Price trades — that strategy uses each market&apos;s exchange maximum leverage — but exposure, position count and daily-loss limits still bind it.</p>}
          </div>

          <div className="panel p-4 sm:p-5 space-y-5">
            <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
              ⚠️ These exit rules apply to the <strong>indicator strategies in the browser paper engine</strong> (active when the server agent is off).
              When the 24/7 server agent is running, configure exits in the Autonomous agent panel below. Pure Price ignores them entirely — its Safety Line is the stop and it has no fixed take-profit.
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
                  <div className="text-xs text-muted-foreground">Ratchet stop-loss up when the trade moves in profit</div>
                </div>
              </label>
            </div>
          </div>
        </>
      )}

      <div className="panel p-4 sm:p-5 space-y-4">
        <div className="text-sm font-semibold">Hyperliquid wallet address (read-only)</div>
        <div className="text-xs text-muted-foreground">Your public address. Used to read live balance & positions.</div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input placeholder="0x…" value={wallet} onChange={e => { setWalletTouched(true); setWallet(e.target.value); }} className="w-full min-w-0 flex-1 rounded-md border border-panel-border bg-background px-3 py-2 mono text-sm" />
          <button onClick={saveWallet} disabled={saving} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">Save</button>
          <button onClick={loadHyperliquid} disabled={!wallet || loadingWallet} className="rounded-md border border-panel-border px-4 py-2 text-sm">Fetch live state</button>
        </div>
        {userState && <div className="mt-4 space-y-3"><div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><div className="rounded-md bg-background p-3"><div className="text-[10px] uppercase tracking-widest text-muted-foreground">Account value</div><div className="mono text-lg">{(+userState.marginSummary.accountValue).toFixed(2)} USDC</div></div><div className="rounded-md bg-background p-3"><div className="text-[10px] uppercase tracking-widest text-muted-foreground">Withdrawable</div><div className="mono text-lg">{(+userState.withdrawable).toFixed(2)}</div></div><div className="rounded-md bg-background p-3"><div className="text-[10px] uppercase tracking-widest text-muted-foreground">Margin used</div><div className="mono text-lg">{(+userState.marginSummary.totalMarginUsed).toFixed(2)}</div></div></div><div className="rounded-md bg-background p-3"><div className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">Live positions ({userState.assetPositions.length})</div>{userState.assetPositions.length === 0 && <div className="text-sm text-muted-foreground">None</div>}{userState.assetPositions.map(ap => <div key={ap.position.coin} className="mono flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-panel-border/50 py-1.5 text-xs sm:text-sm"><span>{ap.position.coin}</span><span className={+ap.position.szi >= 0 ? "text-bull" : "text-bear"}>{+ap.position.szi >= 0 ? "LONG" : "SHORT"} {Math.abs(+ap.position.szi)}</span><span>{(+ap.position.entryPx).toFixed(6)}</span><span className={+ap.position.unrealizedPnl >= 0 ? "text-bull" : "text-bear"}>{(+ap.position.unrealizedPnl).toFixed(2)}</span></div>)}</div></div>}
      </div>

      <AgentPanel />
      <LiveTradingPanel />
      <div className="panel p-4 sm:p-5 space-y-4"><div className="text-sm font-semibold">Reset paper account</div><p className="text-xs text-muted-foreground">Close every open paper position at the current mark price and reset paper equity back to 10,000 USDC. This only affects paper trading — it does not touch live Hyperliquid positions or real funds.</p><button onClick={() => reset.mutate()} disabled={reset.isPending} className="inline-flex items-center gap-2 rounded-md border border-panel-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">{reset.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}{reset.isPending ? "Resetting…" : "Reset paper account"}</button></div>
    </div>
  );
}
