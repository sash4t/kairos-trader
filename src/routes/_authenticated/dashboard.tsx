import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getLiveStatus } from "@/lib/live.functions";
import { supabase } from "@/integrations/supabase/client";
import { useBot } from "@/lib/botContext";
import { KillSwitch } from "@/components/KillSwitch";

export const Route = createFileRoute("/_authenticated/dashboard")({ component: Dashboard });

function fmt(n: number, d = 2) {
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function ageLabel(date: string) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ${mins % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function holdLabel(ms: number) {
  if (!ms) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = mins / 60;
  return hours < 24 ? `${hours.toFixed(1)}h` : `${(hours / 24).toFixed(1)}d`;
}

function Dashboard() {
  const { userId, settings, mids, positionsVersion } = useBot();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(x => x + 1), 1500); return () => clearInterval(t); }, []);

  const { data: openPos = [] } = useQuery({
    queryKey: ["positions-open", userId, positionsVersion], enabled: !!userId,
    queryFn: async () => (await supabase.from("paper_positions").select("*").eq("user_id", userId!).eq("status", "open").order("opened_at", { ascending: false })).data ?? [],
    refetchInterval: 3000,
  });
  const { data: closed = [] } = useQuery({
    queryKey: ["positions-closed", userId, positionsVersion], enabled: !!userId,
    queryFn: async () => (await supabase.from("paper_positions").select("*").eq("user_id", userId!).eq("status", "closed").order("closed_at", { ascending: false }).limit(500)).data ?? [],
    refetchInterval: 10000,
  });
  const { data: events = [] } = useQuery({
    queryKey: ["dashboard-events", userId], enabled: !!userId,
    queryFn: async () => (await supabase.from("bot_events").select("*").eq("user_id", userId!).order("ts", { ascending: false }).limit(30)).data ?? [],
    refetchInterval: 5000,
  });

  const startEquity = settings?.paper_equity ?? 10000;
  const realizedPnl = closed.reduce((s, p) => s + +(p.pnl ?? 0), 0);
  const unrealizedPnl = openPos.reduce((s, p: any) => {
    const mark = +(mids[p.coin] ?? p.entry_price);
    return s + (p.side === "long" ? (mark - +p.entry_price) * +p.size : (+p.entry_price - mark) * +p.size);
  }, 0);
  const paperEquity = startEquity + realizedPnl + unrealizedPnl;
  const wins = closed.filter(p => +(p.pnl ?? 0) > 0);
  const winRate = closed.length ? wins.length / closed.length * 100 : 0;
  const completedHolds = closed.filter(p => p.closed_at && p.opened_at);
  const avgHoldMs = completedHolds.length ? completedHolds.reduce((sum, p) => sum + (new Date(p.closed_at!).getTime() - new Date(p.opened_at).getTime()), 0) / completedHolds.length : 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayRealized = closed.filter(p => p.closed_at && new Date(p.closed_at).getTime() >= today.getTime()).reduce((s, p) => s + +(p.pnl ?? 0), 0);

  const isLive = settings?.mode === "live";
  const statusFn = useServerFn(getLiveStatus);
  const { data: live } = useQuery({
    queryKey: ["live-status", userId], enabled: !!isLive,
    queryFn: () => statusFn({ data: undefined }), refetchInterval: 15000,
  });
  const liveAcct = live?.account ?? null;
  const displayEquity = isLive && liveAcct ? liveAcct.accountValue : paperEquity;
  const displayUnrealized = isLive && liveAcct ? liveAcct.positions.reduce((s, p) => s + p.unrealizedPnl, 0) : unrealizedPnl;
  const todayPnl = todayRealized + displayUnrealized;
  const todayPct = displayEquity ? todayPnl / (displayEquity - todayPnl || displayEquity) * 100 : 0;
  const positions: any[] = isLive && liveAcct ? liveAcct.positions.map(p => ({
    id: `live-${p.coin}`, coin: p.coin, side: p.side, entry_price: p.entryPrice, size: p.size,
    opened_at: openPos.find((x: any) => x.coin === p.coin)?.opened_at ?? new Date().toISOString(), livePnl: p.unrealizedPnl,
  })) : openPos;

  return (
    <div className="dashboard-v2 min-h-full bg-[#0A0B0E] p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1500px] overflow-hidden border border-[#1C2030] bg-[#0A0B0E]">
        <header className="flex min-h-16 flex-wrap items-center justify-between gap-4 border-b border-[#1C2030] px-5 py-4 sm:px-6">
          <div className="flex items-center gap-4">
            <span className="mono text-base font-semibold tracking-[0.14em] text-[#E8EAF0]">KAIROS</span>
            <span className="h-5 w-px bg-[#1C2030]" />
            <div className="flex items-center gap-2 text-xs text-[#6B7280]">
              <span className={`live-pulse ${settings?.bot_enabled && !settings?.kill_switch_engaged ? "is-live" : ""}`} />
              <span>{isLive ? "LIVE" : "PAPER"} · Hyperliquid</span>
            </div>
          </div>
          <div className="flex items-center gap-4 sm:gap-6">
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-[0.16em] text-[#6B7280]">Equity</div>
              <div className="mono mt-0.5 text-sm font-semibold text-[#E8EAF0]">${fmt(displayEquity)}</div>
            </div>
            <div className="w-36"><KillSwitch /></div>
          </div>
        </header>

        {isLive && !liveAcct && <div className="border-b border-[#1C2030] bg-[#22100F] px-5 py-2 text-xs text-[#F04040]">Live account data unavailable{live?.detail ? ` · ${live.detail}` : ""}</div>}

        <section className="grid grid-cols-2 border-b border-[#1C2030] lg:grid-cols-4">
          {[
            ["TODAY'S P&L", `${todayPnl >= 0 ? "+" : "-"}$${fmt(Math.abs(todayPnl))}`, `${todayPct >= 0 ? "+" : ""}${todayPct.toFixed(2)}% of equity`, todayPnl >= 0 ? "text-[#00C896]" : "text-[#F04040]"],
            ["OPEN POSITIONS", `${positions.length}`, `${positions.length} of ${settings?.max_positions ?? "—"} max`, "text-[#E8EAF0]"],
            ["WIN RATE", `${winRate.toFixed(0)}%`, `${wins.length} of ${closed.length} trades`, "text-[#E8EAF0]"],
            ["AVG HOLD", holdLabel(avgHoldMs), completedHolds.length ? `${completedHolds.length} closed trades` : "No closed trades", "text-[#E8EAF0]"],
          ].map(([label, value, sub, color], i) => (
            <div key={label} className={`bg-[#111420] px-5 py-5 sm:px-6 ${i % 2 ? "border-l border-[#1C2030]" : ""} ${i > 1 ? "border-t border-[#1C2030] lg:border-t-0" : ""} ${i === 2 ? "lg:border-l lg:border-[#1C2030]" : ""}`}>
              <div className="text-[10px] uppercase tracking-[0.16em] text-[#6B7280]">{label}</div>
              <div className={`mono mt-2 text-xl font-semibold sm:text-2xl ${color}`}>{value}</div>
              <div className="mt-1 text-[11px] text-[#6B7280]">{sub}</div>
            </div>
          ))}
        </section>

        <section className="grid min-h-[520px] lg:grid-cols-[1.35fr_0.85fr]">
          <div className="min-w-0 border-b border-[#1C2030] lg:border-b-0 lg:border-r">
            <div className="flex items-center justify-between border-b border-[#1C2030] px-5 py-3.5">
              <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[#E8EAF0]">Active Positions</h2>
              <span className="mono text-[10px] text-[#6B7280]">{positions.length} OPEN</span>
            </div>
            {positions.length === 0 ? <div className="flex h-48 items-center justify-center text-sm text-[#6B7280]">No active positions.</div> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs">
                <thead><tr className="border-b border-[#1C2030] text-[9px] uppercase tracking-[0.14em] text-[#6B7280]">
                  <th className="px-5 py-3 font-medium">Market</th><th className="px-3 py-3 font-medium">Entry price</th><th className="px-3 py-3 font-medium">Current price</th><th className="px-3 py-3 font-medium">Size</th><th className="px-3 py-3 font-medium">Unrealized P&L</th><th className="px-5 py-3 font-medium">Age</th>
                </tr></thead>
                <tbody>{positions.map((p: any) => {
                  const mark = +(mids[p.coin] ?? p.entry_price);
                  const pnl = p.livePnl ?? (p.side === "long" ? (mark - +p.entry_price) * +p.size : (+p.entry_price - mark) * +p.size);
                  return <tr key={p.id} className="border-b border-[#1C2030] transition-colors hover:bg-[#0F1118]">
                    <td className="px-5 py-4"><div className="flex items-center gap-2"><span className="mono font-semibold text-[#E8EAF0]">{p.coin}</span><span className={`mono px-1.5 py-0.5 text-[9px] font-semibold ${p.side === "long" ? "bg-[#0D2420] text-[#00C896]" : "bg-[#22100F] text-[#F04040]"}`}>{p.side.toUpperCase()}</span></div></td>
                    <td className="mono px-3 py-4 text-[#A7ADBA]">${fmt(+p.entry_price, +p.entry_price < 10 ? 4 : 2)}</td>
                    <td className="mono px-3 py-4 text-[#E8EAF0]">${fmt(mark, mark < 10 ? 4 : 2)}</td>
                    <td className="mono px-3 py-4 text-[#A7ADBA]">{fmt(+p.size, 4)}</td>
                    <td className={`mono px-3 py-4 font-semibold ${pnl >= 0 ? "text-[#00C896]" : "text-[#F04040]"}`}>{pnl >= 0 ? "+" : "-"}${fmt(Math.abs(pnl))}</td>
                    <td className="mono px-5 py-4 text-[#6B7280]">{ageLabel(p.opened_at)}</td>
                  </tr>;
                })}</tbody>
              </table></div>
            )}
          </div>

          <div className="min-w-0">
            <div className="flex items-center justify-between border-b border-[#1C2030] px-5 py-3.5"><h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[#E8EAF0]">Signal Feed</h2><span className="text-[10px] text-[#6B7280]">auto-scroll</span></div>
            <div className="max-h-[620px] overflow-y-auto">
              {events.length === 0 ? <div className="flex h-48 items-center justify-center text-sm text-[#6B7280]">Waiting for bot events…</div> : events.map((event: any) => {
                const meta = event.meta && typeof event.meta === "object" ? event.meta as any : {};
                const confidence = Number(meta.confidence ?? meta.score ?? 0);
                const negative = event.level === "error" || /closed|stop|loss|short/i.test(event.message);
                const skipped = /skip|threshold|no signal/i.test(event.message);
                const dot = skipped ? "bg-[#47739B]" : negative ? "bg-[#F04040]" : "bg-[#00C896]";
                return <div key={event.id} className="border-b border-[#1C2030] px-5 py-3.5 hover:bg-[#0F1118]">
                  <div className="grid grid-cols-[44px_8px_1fr] gap-2.5">
                    <span className="mono text-[10px] text-[#4D5565]">{new Date(event.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                    <span className={`mt-1 h-1.5 w-1.5 rounded-full ${dot}`} />
                    <div className="min-w-0"><div className="text-[11px] leading-4 text-[#C7CBD4]">{event.message}</div>
                      {confidence > 0 && <div className="mt-2 flex items-center gap-2"><div className="h-0.5 w-20 bg-[#1C2030]"><div className="h-full bg-[#00C896]" style={{ width: `${Math.min(100, confidence)}%` }} /></div><span className="mono text-[9px] text-[#6B7280]">CONF {confidence.toFixed(0)}%</span></div>}
                    </div>
                  </div>
                </div>;
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
