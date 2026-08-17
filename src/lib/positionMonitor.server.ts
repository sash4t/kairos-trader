import {
  VOLATILITY_SQUEEZE_BREAKOUT_KEY,
  adverseAbsPct,
  favorablePct,
  squeezeProfitLockStop,
} from "./strategies/volatilitySqueezeBreakout";

const HL_INFO = "https://api.hyperliquid.xyz/info";

export interface PositionMonitorReport {
  positions: number;
  updated: number;
  closed: number;
  errors: string[];
}

export async function runPositionMonitor(): Promise<PositionMonitorReport> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const report: PositionMonitorReport = { positions: 0, updated: 0, closed: 0, errors: [] };
  const { data: users, error: usersError } = await supabaseAdmin
    .from("bot_settings")
    .select("user_id")
    .eq("server_agent_enabled", true)
    .eq("bot_enabled", true)
    .eq("kill_switch_engaged", false)
    .eq("mode", "paper");
  if (usersError) throw new Error(usersError.message);
  const userIds = (users ?? []).map((row) => row.user_id);
  if (userIds.length === 0) return report;

  const { data: rawPositions, error: positionsError } = await supabaseAdmin
    .from("paper_positions")
    .select("id,user_id,coin,side,size,entry_price,stop_loss,trail_high,pnl,indicators")
    .in("user_id", userIds)
    .eq("status", "open")
    .ilike("reason", `%[${VOLATILITY_SQUEEZE_BREAKOUT_KEY}]%`);
  if (positionsError) throw new Error(positionsError.message);
  if (!rawPositions?.length) return report;
  report.positions = rawPositions.length;

  const response = await fetch(HL_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
  });
  if (!response.ok) throw new Error(`Hyperliquid ${response.status}`);
  const mids = (await response.json()) as Record<string, string>;

  await Promise.all(rawPositions.map(async (raw) => {
    try {
      const mark = Number(mids[raw.coin]);
      const entry = Number(raw.entry_price);
      const currentStop = Number(raw.stop_loss);
      const size = Number(raw.size);
      if (![mark, entry, currentStop, size].every(Number.isFinite) || !(size > 0)) return;
      const side = raw.side as "long" | "short";
      const breached = side === "long" ? mark <= currentStop : mark >= currentStop;

      if (breached) {
        const remainingPnl = side === "long" ? (currentStop - entry) * size : (entry - currentStop) * size;
        const totalPnl = Number(raw.pnl ?? 0) + remainingPnl;
        const protectedProfit = side === "long" ? currentStop >= entry : currentStop <= entry;
        const { data, error } = await supabaseAdmin
          .from("paper_positions")
          .update({
            status: "closed",
            exit_price: currentStop,
            exit_reason: protectedProfit ? "squeeze_breakeven_or_trail" : "squeeze_stop_loss",
            pnl: totalPnl,
            closed_at: new Date().toISOString(),
          })
          .eq("id", raw.id)
          .eq("status", "open")
          .select("id");
        if (error) throw error;
        if (data?.length) report.closed++;
        return;
      }

      const previousPeak = raw.trail_high == null ? entry : Number(raw.trail_high);
      const best = side === "long" ? Math.max(previousPeak, mark) : Math.min(previousPeak, mark);
      const nextStop = squeezeProfitLockStop(side, entry, best, currentStop);
      const move = favorablePct(side, entry, mark);
      const indicators = { ...((raw.indicators ?? {}) as Record<string, number>) };
      indicators.maxAbsMovePct = Math.max(Number(indicators.maxAbsMovePct ?? 0), adverseAbsPct(entry, mark));
      indicators.maxFavorablePct = Math.max(Number(indicators.maxFavorablePct ?? 0), move);
      indicators.maxAdversePct = Math.max(Number(indicators.maxAdversePct ?? 0), -move);

      if (best !== previousPeak || nextStop !== currentStop || move !== 0) {
        const { error } = await (supabaseAdmin as any).rpc("update_paper_squeeze_trail", {
          p_id: raw.id,
          p_stop: nextStop,
          p_peak: best,
          p_indicators: indicators,
        });
        if (error) throw error;
        report.updated++;
      }
    } catch (error) {
      report.errors.push(`${raw.coin}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));

  return report;
}
