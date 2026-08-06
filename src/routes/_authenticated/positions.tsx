import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBot } from "@/lib/botContext";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/positions")({ component: Positions });

function Positions() {
  const { userId, mids, engine, positionsVersion } = useBot();
  const [busy, setBusy] = useState<string | null>(null);

  const { data = [], refetch } = useQuery({
    queryKey: ["positions", userId, positionsVersion],
    enabled: !!userId,
    queryFn: async () => (await supabase.from("paper_positions").select("*").eq("user_id", userId!).eq("status", "open").order("opened_at", { ascending: false })).data ?? [],
    refetchInterval: 3000,
  });

  const close = async (p: any) => {
    setBusy(p.id);
    const mark = +(mids[p.coin] ?? p.entry_price);
    const pnl = p.side === "long" ? (mark - +p.entry_price) * +p.size : (+p.entry_price - mark) * +p.size;
    await supabase.from("paper_positions").update({ status: "closed", exit_price: mark, exit_reason: "manual", pnl, closed_at: new Date().toISOString() }).eq("id", p.id);
    // Remove from engine's in-memory list
    (engine as any)?.["positions"] && ((engine as any).positions = (engine as any).positions.filter((x: any) => x.id !== p.id));
    toast.success(`Closed ${p.coin} @ ${mark.toFixed(6)}`);
    setBusy(null); refetch();
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-4">
      <h1 className="text-xl sm:text-2xl font-semibold">Open positions</h1>
      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {data.length === 0 && <div className="panel py-12 text-center text-sm text-muted-foreground">No open positions</div>}
        {data.map((p: any) => {
          const mark = +(mids[p.coin] ?? p.entry_price);
          const pnl = p.side === "long" ? (mark - +p.entry_price) * +p.size : (+p.entry_price - mark) * +p.size;
          const margin = +p.notional / Math.max(1, +p.leverage);
          return (
            <div key={p.id} className="panel p-4">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="mono truncate text-base font-semibold">{p.coin}</span>
                    <span className={`mono text-xs font-semibold ${p.side === "long" ? "text-bull" : "text-bear"}`}>{p.side.toUpperCase()} {(+p.leverage).toFixed(0)}x</span>
                  </div>
                  <div className={`mono mt-1 text-lg font-semibold ${pnl >= 0 ? "text-bull" : "text-bear"}`}>
                    {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
                    <span className="ml-1 text-xs opacity-70">({pnl >= 0 ? "+" : ""}{(margin > 0 ? (pnl / margin) * 100 : 0).toFixed(1)}%)</span>
                  </div>
                </div>
                <button disabled={busy === p.id} onClick={() => close(p)} className="shrink-0 rounded bg-bear/20 px-3 py-2 text-xs font-semibold text-bear disabled:opacity-50">Close</button>
              </div>
              <div className="mono mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">Entry</span><span>{(+p.entry_price).toFixed(6)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Mark</span><span>{mark.toFixed(6)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">SL</span><span className="text-bear">{(+p.stop_loss).toFixed(6)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">TP</span><span className="text-bull">{(+p.take_profit).toFixed(6)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Size</span><span>{(+p.size).toFixed(4)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Conf</span><span>{(+p.confidence).toFixed(0)}</span></div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="panel hidden overflow-hidden md:block">
        <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-panel-border text-xs uppercase tracking-widest text-muted-foreground">
            <tr><th className="p-3 text-left">Coin</th><th className="text-right">PnL</th><th>Side</th><th className="text-right">Size</th><th className="text-right">Lev</th><th className="text-right">Entry</th><th className="text-right">Mark</th><th className="text-right">SL</th><th className="text-right">TP</th><th className="text-right">Conf</th><th></th></tr>
          </thead>
          <tbody>
            {data.length === 0 && <tr><td colSpan={11} className="py-16 text-center text-sm text-muted-foreground">No open positions</td></tr>}
            {data.map((p: any) => {
              const mark = +(mids[p.coin] ?? p.entry_price);
              const pnl = p.side === "long" ? (mark - +p.entry_price) * +p.size : (+p.entry_price - mark) * +p.size;
              const margin = +p.notional / Math.max(1, +p.leverage);
              return (
                <tr key={p.id} className="border-b border-panel-border/50 mono">
                  <td className="p-3">{p.coin}</td>
                  <td className={`text-right ${pnl >= 0 ? "text-bull" : "text-bear"}`}>
                    <span className="font-semibold">{pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}</span>
                    <span className="ml-1 text-xs opacity-70">({pnl >= 0 ? "+" : ""}{(margin > 0 ? (pnl / margin) * 100 : 0).toFixed(1)}%)</span>
                  </td>
                  <td className={p.side === "long" ? "text-bull" : "text-bear"}>{p.side.toUpperCase()}</td>
                  <td className="text-right">{(+p.size).toFixed(4)}</td>
                  <td className="text-right">{(+p.leverage).toFixed(0)}x</td>
                  <td className="text-right">{(+p.entry_price).toFixed(6)}</td>
                  <td className="text-right">{mark.toFixed(6)}</td>
                  <td className="text-right text-bear">{(+p.stop_loss).toFixed(6)}</td>
                  <td className="text-right text-bull">{(+p.take_profit).toFixed(6)}</td>
                  <td className="text-right">{(+p.confidence).toFixed(0)}</td>
                  <td className="p-3 text-right">
                    <button disabled={busy === p.id} onClick={() => close(p)} className="rounded bg-bear/20 px-2 py-1 text-xs font-semibold text-bear hover:bg-bear/30 disabled:opacity-50">Close</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </div>
    </div>
  );
}
