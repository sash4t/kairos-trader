import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getLiveStatus } from "@/lib/live.functions";
import { supabase } from "@/integrations/supabase/client";
import { useBot } from "@/lib/botContext";
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { TrendingUp, TrendingDown, Wallet, Activity, ShieldAlert } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

function fmt(n: number, d = 2) { return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); }

function Metric({ label, value, sub, color, icon: Icon }: any) {
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
      </div>
      <div className={`mono mt-2 text-2xl font-semibold ${color ?? ""}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Dashboard() {
  const { userId, settings, mids, positionsVersion } = useBot();
  const [_, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(x => x + 1), 1500); return () => clearInterval(t); }, []);

  const { data: openPos = [] } = useQuery({
    queryKey: ["positions-open", userId, positionsVersion],
    enabled: !!userId,
    queryFn: async () => (await supabase.from("paper_positions").select("*").eq("user_id", userId!).eq("status", "open").order("opened_at", { ascending: false })).data ?? [],
    refetchInterval: 3000,
  });

  const { data: closed = [] } = useQuery({
    queryKey: ["positions-closed", userId, positionsVersion],
    enabled: !!userId,
    queryFn: async () => (await supabase.from("paper_positions").select("*").eq("user_id", userId!).eq("status", "closed").order("closed_at", { ascending: false }).limit(500)).data ?? [],
    refetchInterval: 10000,
  });

  const { data: equitySeries = [] } = useQuery({
    queryKey: ["equity", userId],
    enabled: !!userId,
    queryFn: async () => (await supabase.from("equity_snapshots").select("ts, equity").eq("user_id", userId!).order("ts", { ascending: true }).limit(500)).data ?? [],
    refetchInterval: 30000,
  });

  const startEquity = settings?.paper_equity ?? 10000;
  const realizedPnl = closed.reduce((s, p) => s + (+(p.pnl ?? 0)), 0);
  const unrealizedPnl = openPos.reduce((s, p: any) => {
    const m = mids[p.coin]; if (!m) return s;
    const mk = +m;
    return s + (p.side === "long" ? (mk - +p.entry_price) * +p.size : (+p.entry_price - mk) * +p.size);
  }, 0);
  const equity = startEquity + realizedPnl + unrealizedPnl;
  const usedNotional = openPos.reduce((s, p: any) => s + +p.notional, 0);

  const wins = closed.filter(c => +(c.pnl ?? 0) > 0);
  const losses = closed.filter(c => +(c.pnl ?? 0) <= 0);
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
  const avgWin = wins.length ? wins.reduce((s, c) => s + +(c.pnl ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, c) => s + +(c.pnl ?? 0), 0) / losses.length : 0;
  const profitFactor = losses.length && avgLoss !== 0
    ? Math.abs((wins.reduce((s, c) => s + +(c.pnl ?? 0), 0)) / (losses.reduce((s, c) => s + +(c.pnl ?? 0), 0)))
    : wins.length ? Infinity : 0;

  // Max drawdown from equity snapshots
  let peak = startEquity, maxDD = 0;
  for (const p of equitySeries) { peak = Math.max(peak, +p.equity); maxDD = Math.min(maxDD, +p.equity - peak); }
  const maxDDpct = (maxDD / peak) * 100;

  const chartData = equitySeries.length
    ? equitySeries.map(p => ({ t: new Date(p.ts).getTime(), v: +p.equity }))
    : [{ t: Date.now() - 60_000, v: startEquity }, { t: Date.now(), v: equity }];

  const isLive = settings?.mode === "live";
  const statusFn = useServerFn(getLiveStatus);
  const { data: live } = useQuery({
    queryKey: ["live-status", userId],
    enabled: !!isLive,
    queryFn: () => statusFn({ data: undefined }),
    refetchInterval: 15000,
  });
  const liveAcct = live?.account ?? null;
  const displayEquity = isLive && liveAcct ? liveAcct.accountValue : equity;
  const displayUnrealized = isLive && liveAcct
    ? liveAcct.positions.reduce((s, p) => s + p.unrealizedPnl, 0)
    : unrealizedPnl;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold">Portfolio</h1>
          <p className="text-sm text-muted-foreground">
            {isLive ? "Live trading · real Hyperliquid account" : "Paper trading · Hyperliquid USDC perpetuals"}
          </p>
        </div>
        <div className="mono text-xs text-muted-foreground sm:text-right">
          <div>Bot: <span className={settings?.bot_enabled ? "text-bull" : "text-warning"}>{settings?.bot_enabled ? "RUNNING" : "STOPPED"}</span></div>
          <div>Mode: <span className={isLive ? "text-bear" : "text-foreground"}>{isLive ? "LIVE" : "PAPER"}</span> · <span className="text-foreground">{settings?.strategy_mode?.toUpperCase()}</span></div>
        </div>
      </div>

      {isLive && !liveAcct && (
        <div className="panel border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          Live mode is on but the real account balance couldn’t be read
          {live?.detail ? ` — ${live.detail}` : ""}. Check the API wallet in Settings → Hyperliquid live trading.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
        <Metric
          label={isLive ? "Live account equity" : "Account equity"}
          value={fmt(displayEquity)}
          sub={isLive ? `Withdrawable ${fmt(liveAcct?.withdrawable ?? 0)} USDC` : `Start ${fmt(startEquity)} USDC`}
          icon={Wallet}
        />
        <Metric label="Unrealized PnL" value={`${displayUnrealized >= 0 ? "+" : ""}${fmt(displayUnrealized)}`} color={displayUnrealized >= 0 ? "text-bull" : "text-bear"} icon={displayUnrealized >= 0 ? TrendingUp : TrendingDown} />
        <Metric label="Realized PnL" value={`${realizedPnl >= 0 ? "+" : ""}${fmt(realizedPnl)}`} color={realizedPnl >= 0 ? "text-bull" : "text-bear"} icon={Activity} />
        <Metric
          label={isLive ? "Margin used" : "Used notional"}
          value={fmt(isLive ? (liveAcct?.totalMarginUsed ?? 0) : usedNotional)}
          sub={isLive
            ? `Allocation cap ${settings && +settings.live_max_alloc_usd > 0 ? `$${fmt(+settings.live_max_alloc_usd, 0)}` : "full account"}`
            : `${((usedNotional / (equity * (settings?.max_leverage ?? 5))) * 100).toFixed(1)}% of cap`}
          icon={ShieldAlert}
        />
      </div>

      {isLive && liveAcct && (
        <div className="panel p-4 sm:p-5">
          <div className="mb-3 text-sm font-semibold">Live Hyperliquid positions ({liveAcct.positions.length})</div>
          {liveAcct.positions.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No live positions open on your account.</div>
          ) : (
            <div className="space-y-2">
              {liveAcct.positions.map(p => (
                <div key={p.coin} className="mono flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-panel-border/50 py-2 text-xs sm:text-sm">
                  <span className="font-semibold">{p.coin}</span>
                  <span className={p.side === "long" ? "text-bull" : "text-bear"}>{p.side.toUpperCase()} {p.size}</span>
                  <span>@ {p.entryPrice}</span>
                  <span>{p.leverage}x</span>
                  <span className={p.unrealizedPnl >= 0 ? "text-bull" : "text-bear"}>
                    {p.unrealizedPnl >= 0 ? "+" : ""}{fmt(p.unrealizedPnl)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="panel p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">Equity curve</div>
            <div className="text-xs text-muted-foreground">Updated every minute</div>
          </div>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid stroke="var(--panel-border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="t" type="number" domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickFormatter={t => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} />
              <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} domain={["auto", "auto"]} width={60} />
              <Tooltip contentStyle={{ background: "var(--panel)", border: "1px solid var(--panel-border)", fontSize: 12 }}
                labelFormatter={t => new Date(Number(t)).toLocaleString()} formatter={(v: any) => [fmt(+v), "Equity"]} />
              <Line dataKey="v" type="monotone" stroke="var(--primary)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-5">
        <Metric label="Win rate" value={`${winRate.toFixed(1)}%`} sub={`${wins.length}W / ${losses.length}L`} />
        <Metric label="Avg winner" value={fmt(avgWin)} color="text-bull" />
        <Metric label="Avg loser" value={fmt(avgLoss)} color="text-bear" />
        <Metric label="Profit factor" value={isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞"} />
        <Metric label="Max drawdown" value={`${maxDDpct.toFixed(2)}%`} color="text-bear" />
      </div>

      <div className="panel p-4 sm:p-5">
        <div className="mb-3 text-sm font-semibold">Open positions ({openPos.length})</div>
        {openPos.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">No open positions. The bot will open positions when a high-confidence signal appears.</div>
        ) : (
          <><div className="space-y-3 md:hidden">
            {openPos.map((p: any) => {
              const mark = +(mids[p.coin] ?? p.entry_price);
              const pnl = p.side === "long" ? (mark - +p.entry_price) * +p.size : (+p.entry_price - mark) * +p.size;
              const margin = +p.notional / Math.max(1, +p.leverage);
              return (
                <div key={p.id} className="rounded-md border border-panel-border p-3">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                    <div className="min-w-0">
                      <span className="mono truncate text-sm font-semibold">{p.coin}</span>
                      <span className={`mono ml-2 text-xs font-semibold ${p.side === "long" ? "text-bull" : "text-bear"}`}>{p.side.toUpperCase()}</span>
                    </div>
                    <div className={`mono shrink-0 text-sm font-semibold ${pnl >= 0 ? "text-bull" : "text-bear"}`}>
                      {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
                      <span className="ml-1 text-xs opacity-70">({pnl >= 0 ? "+" : ""}{(margin > 0 ? (pnl / margin) * 100 : 0).toFixed(1)}%)</span>
                    </div>
                  </div>
                  <div className="mono mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <div className="flex justify-between"><span className="text-muted-foreground">Entry</span><span>{(+p.entry_price).toFixed(6)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Mark</span><span>{mark.toFixed(6)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">SL</span><span className="text-bear">{(+p.stop_loss).toFixed(4)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">TP</span><span className="text-bull">{(+p.take_profit).toFixed(4)}</span></div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[720px] text-sm">
            <thead className="text-xs uppercase tracking-widest text-muted-foreground">
              <tr className="border-b border-panel-border"><th className="py-2 text-left">Coin</th><th className="text-right">PnL</th><th>Side</th><th className="text-right">Entry</th><th className="text-right">Mark</th><th className="text-right">Size</th><th className="text-right">SL / TP</th></tr>
            </thead>
            <tbody>
              {openPos.map((p: any) => {
                const mark = +(mids[p.coin] ?? p.entry_price);
                const pnl = p.side === "long" ? (mark - +p.entry_price) * +p.size : (+p.entry_price - mark) * +p.size;
                const margin = +p.notional / Math.max(1, +p.leverage);
                return (
                  <tr key={p.id} className="border-b border-panel-border/50 mono">
                    <td className="py-2">{p.coin}</td>
                    <td className={`text-right ${pnl >= 0 ? "text-bull" : "text-bear"}`}>
                      <span className="font-semibold">{pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}</span>
                      <span className="ml-1 text-xs opacity-70">({pnl >= 0 ? "+" : ""}{(margin > 0 ? (pnl / margin) * 100 : 0).toFixed(1)}%)</span>
                    </td>
                    <td className={p.side === "long" ? "text-bull" : "text-bear"}>{p.side.toUpperCase()}</td>
                    <td className="text-right">{(+p.entry_price).toFixed(6)}</td>
                    <td className="text-right">{mark.toFixed(6)}</td>
                    <td className="text-right">{(+p.size).toFixed(4)}</td>
                    <td className="text-right text-xs text-muted-foreground">{(+p.stop_loss).toFixed(4)} / {(+p.take_profit).toFixed(4)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div></>
        )}
      </div>
    </div>
  );
}
