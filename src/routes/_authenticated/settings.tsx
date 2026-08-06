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

export const Route = createFileRoute("/_authenticated/settings")({ component: SettingsPage });

function SettingsPage() {
  const { userId, syncPositions } = useBot();
  const [wallet, setWallet] = useState("");
  const [saving, setSaving] = useState(false);
  const [userState, setUserState] = useState<UserState | null>(null);
  const [loadingWallet, setLoadingWallet] = useState(false);
  const resetFn = useServerFn(resetPaperAccount);
  const queryClient = useQueryClient();
  const reset = useMutation({
    mutationFn: () => resetFn({ data: undefined }),
    onSuccess: async (r) => {
      toast.success(`Paper account reset: ${r.closed} position(s) cleared, equity set to ${r.newEquity.toLocaleString()} USDC.`);
      await syncPositions();
      await queryClient.invalidateQueries();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const { data: profile } = useQuery({
    queryKey: ["profile", userId],
    enabled: !!userId,
    queryFn: async () => (await supabase.from("profiles").select("*").eq("id", userId!).maybeSingle()).data,
  });

  useEffect(() => { if (profile?.wallet_address) setWallet(profile.wallet_address); }, [profile]);

  const saveWallet = async () => {
    setSaving(true);
    const trimmed = wallet.trim();
    if (trimmed && !/^0x[a-fA-F0-9]{40}$/.test(trimmed)) { toast.error("Invalid Ethereum-style address"); setSaving(false); return; }
    await supabase.from("profiles").update({ wallet_address: trimmed || null }).eq("id", userId!);
    toast.success("Wallet saved");
    setSaving(false);
  };

  const loadHyperliquid = async () => {
    if (!wallet) return;
    setLoadingWallet(true);
    try {
      const state = await fetchUserState(wallet.trim());
      setUserState(state);
    } catch (e: any) { toast.error(e.message ?? "Failed to fetch Hyperliquid state"); }
    finally { setLoadingWallet(false); }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-8 max-w-4xl">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold">Settings & wallet</h1>
        <p className="text-sm text-muted-foreground">Read-only Hyperliquid account view. No private keys are ever stored server-side.</p>
      </div>

      <div className="panel p-4 sm:p-5 space-y-4">
        <div className="text-sm font-semibold">Hyperliquid wallet address (read-only)</div>
        <div className="text-xs text-muted-foreground">Your public address. Used to read live balance & positions. Signing (for real order execution) is out of scope here — use the executor service.</div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input placeholder="0x…" value={wallet} onChange={e => setWallet(e.target.value)}
            className="w-full min-w-0 flex-1 rounded-md border border-panel-border bg-background px-3 py-2 mono text-sm" />
          <button onClick={saveWallet} disabled={saving} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">Save</button>
          <button onClick={loadHyperliquid} disabled={!wallet || loadingWallet} className="rounded-md border border-panel-border px-4 py-2 text-sm">Fetch live state</button>
        </div>

        {userState && (
          <div className="mt-4 space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-md bg-background p-3">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Account value</div>
                <div className="mono text-lg">{(+userState.marginSummary.accountValue).toFixed(2)} USDC</div>
              </div>
              <div className="rounded-md bg-background p-3">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Withdrawable</div>
                <div className="mono text-lg">{(+userState.withdrawable).toFixed(2)}</div>
              </div>
              <div className="rounded-md bg-background p-3">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Margin used</div>
                <div className="mono text-lg">{(+userState.marginSummary.totalMarginUsed).toFixed(2)}</div>
              </div>
            </div>
            <div className="rounded-md bg-background p-3">
              <div className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">Live positions ({userState.assetPositions.length})</div>
              {userState.assetPositions.length === 0 && <div className="text-sm text-muted-foreground">None</div>}
              {userState.assetPositions.map(ap => (
                <div key={ap.position.coin} className="mono flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-panel-border/50 py-1.5 text-xs sm:text-sm">
                  <span>{ap.position.coin}</span>
                  <span className={+ap.position.szi >= 0 ? "text-bull" : "text-bear"}>{+ap.position.szi >= 0 ? "LONG" : "SHORT"} {Math.abs(+ap.position.szi)}</span>
                  <span>{(+ap.position.entryPx).toFixed(6)}</span>
                  <span className={+ap.position.unrealizedPnl >= 0 ? "text-bull" : "text-bear"}>{(+ap.position.unrealizedPnl).toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <AgentPanel />
      <LiveTradingPanel />

      <div className="panel p-4 sm:p-5 space-y-4">
        <div className="text-sm font-semibold">Reset paper account</div>
        <p className="text-xs text-muted-foreground">
          Close every open paper position at the current mark price and reset paper equity back to 10,000 USDC.
          This only affects paper trading — it does not touch live Hyperliquid positions or real funds.
        </p>
        <button
          onClick={() => reset.mutate()}
          disabled={reset.isPending}
          className="inline-flex items-center gap-2 rounded-md border border-panel-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {reset.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
          {reset.isPending ? "Resetting…" : "Reset paper account"}
        </button>
      </div>

      <div className="panel p-4 sm:p-5 space-y-2">
        <div className="text-sm font-semibold">Real-money execution</div>
        <p className="text-xs text-muted-foreground">
          The background agent trades the paper account only. Placing real Hyperliquid orders needs a signing service holding an
          agent private key; run it on your own machine so the key never leaves your control:
        </p>
        <ol className="ml-5 list-decimal space-y-1 text-xs text-muted-foreground">
          <li>Generate a Hyperliquid <span className="mono">agent wallet</span> from your account.</li>
          <li>Run the executor with the agent private key in a local env var.</li>
          <li>The executor reads your <span className="mono">bot_settings</span> and <span className="mono">paper_positions</span> from this app and mirrors decisions on-chain, respecting every risk limit.</li>
          <li>The kill switch here flips <span className="mono">bot_enabled = false</span> and the executor immediately flattens.</li>
        </ol>
        <p className="text-xs text-muted-foreground">Ask for the executor scaffold as a separate deliverable when your forward-test results justify it.</p>
      </div>
    </div>
  );
}
