import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getLiveStatus, flattenLive, type LiveStatus } from "@/lib/live.functions";
import { useBot } from "@/lib/botContext";
import { toast } from "sonner";
import { CircleCheck, Loader2, OctagonAlert, Radio, TriangleAlert } from "lucide-react";

export function LiveTradingPanel() {
  const { settings, saveSettings } = useBot();
  const statusFn = useServerFn(getLiveStatus);
  const flattenFn = useServerFn(flattenLive);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [armed, setArmed] = useState(false);

  const check = useMutation({
    mutationFn: () => statusFn({ data: undefined }),
    onSuccess: (s) => {
      setStatus(s);
      if (!s.configured) toast.error("No API wallet saved yet");
      else if (!s.approved) toast.warning(s.detail);
      else toast.success("Hyperliquid API wallet connected");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const flat = useMutation({
    mutationFn: () => flattenFn({ data: undefined }),
    onSuccess: (r) => {
      toast.success(`Closed ${r.closed} live position(s)`);
      if (r.errors.length) toast.error(r.errors.join(" · "));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const isLive = settings?.mode === "live";

  return (
    <div className="panel space-y-4 p-4">
      <div className="flex items-center gap-2">
        <Radio className={`h-4 w-4 ${isLive ? "text-bear" : "text-muted-foreground"}`} />
        <h2 className="text-sm font-semibold uppercase tracking-widest">Hyperliquid live trading</h2>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Trading uses an <span className="text-foreground">API wallet (agent key)</span> — it can place orders but
        can never withdraw funds. Create one at{" "}
        <a href="https://app.hyperliquid.xyz/API" target="_blank" rel="noreferrer" className="text-primary underline">
          app.hyperliquid.xyz/API
        </a>
        , authorize it, and save the key plus your main account address in the backend.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          onClick={() => check.mutate()}
          disabled={check.isPending}
          className="rounded-md border border-panel-border px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          {check.isPending ? <><Loader2 className="mr-2 inline h-3 w-3 animate-spin" />Checking…</> : "Test connection"}
        </button>
        <button
          onClick={() => flat.mutate()}
          disabled={flat.isPending}
          className="rounded-md border border-bear/50 bg-bear/10 px-3 py-2 text-xs font-semibold text-bear hover:bg-bear/20 disabled:opacity-50"
        >
          {flat.isPending ? "Closing…" : "Close all live positions"}
        </button>
      </div>

      {status && (
        <div className="space-y-2 rounded-md border border-panel-border bg-muted/30 p-3 text-xs">
          <div className="flex items-start gap-2">
            {status.approved
              ? <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bull" />
              : <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />}
            <span className={status.approved ? "text-bull" : "text-warning"}>{status.detail}</span>
          </div>
          {status.accountAddress && (
            <div className="mono break-all text-muted-foreground">Account {status.accountAddress}</div>
          )}
          {status.agentAddress && (
            <div className="mono break-all text-muted-foreground">Agent {status.agentAddress}</div>
          )}
          {status.account && (
            <div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-3">
              <Stat label="Account value" value={`$${status.account.accountValue.toFixed(2)}`} />
              <Stat label="Withdrawable" value={`$${status.account.withdrawable.toFixed(2)}`} />
              <Stat label="Margin used" value={`$${status.account.totalMarginUsed.toFixed(2)}`} />
              <Stat label="Open positions" value={String(status.account.positions.length)} />
            </div>
          )}
          {status.configured && !status.account && (
            <div className="text-warning">
              Couldn’t read the account balance from Hyperliquid. Double-check that the saved account address is your
              <span className="text-foreground"> main account</span> (the one holding the perps balance), not the API/agent wallet address.
            </div>
          )}
        </div>
      )}

      <div className="space-y-2 rounded-md border border-panel-border bg-background p-3">
        <div className="text-xs font-semibold">Max live allocation</div>
        <p className="text-xs text-muted-foreground">
          Cap the dollar amount of your real account the bot may size from. Position size is{" "}
          <span className="mono">{settings?.position_size_pct ?? 0}%</span> of this. Set 0 to use the whole account.
        </p>
        <div className="flex items-center gap-1 rounded-md border border-panel-border px-2">
          <span className="text-xs text-muted-foreground">$</span>
          <input
            type="number" min="0" step="10"
            value={settings ? +settings.live_max_alloc_usd : 0}
            onChange={(e) => saveSettings({ live_max_alloc_usd: Number(e.target.value) })}
            className="mono w-full bg-transparent py-2 text-sm outline-none"
          />
          <span className="text-xs text-muted-foreground">USDC</span>
        </div>
      </div>

      <div className="space-y-2 rounded-md border border-bear/40 bg-bear/5 p-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-bear">
          <OctagonAlert className="h-3.5 w-3.5" />
          {isLive ? "Live mode is ON — real money at risk" : "Paper mode"}
        </div>
        {isLive ? (
          <button
            onClick={() => { saveSettings({ mode: "paper" }); setArmed(false); toast.success("Switched back to paper"); }}
            className="w-full rounded-md bg-muted px-3 py-2 text-xs font-medium"
          >Switch back to paper trading</button>
        ) : !armed ? (
          <button
            onClick={() => setArmed(true)}
            disabled={!status?.approved}
            className="w-full rounded-md border border-bear/50 px-3 py-2 text-xs font-semibold text-bear disabled:opacity-40"
          >{status?.approved ? "Enable live trading…" : "Test the connection first"}</button>
        ) : (
          <div className="flex gap-2">
            <button onClick={() => setArmed(false)} className="flex-1 rounded bg-muted px-2 py-2 text-xs">Cancel</button>
            <button
              onClick={() => { saveSettings({ mode: "live" }); setArmed(false); toast.warning("LIVE trading enabled"); }}
              className="flex-1 rounded bg-bear px-2 py-2 text-xs font-bold text-white"
            >Confirm live</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mono text-sm">{value}</div>
    </div>
  );
}
