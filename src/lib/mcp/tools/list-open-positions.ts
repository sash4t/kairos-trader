import { defineTool } from "@lovable.dev/mcp-js";
import { errorResult, fetchMids, requireUser, textResult } from "../supabase";

export default defineTool({
  name: "list_open_positions",
  title: "List open positions",
  description:
    "List the signed-in user's currently open paper positions with entry, stop loss, take profit and live unrealized PnL at the current mark price.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (_input, ctx) => {
    try {
      const { supabase, userId } = requireUser(ctx);
      const { data, error } = await supabase
        .from("paper_positions")
        .select("*")
        .eq("user_id", userId)
        .eq("status", "open")
        .order("opened_at", { ascending: false });
      if (error) return errorResult(error.message);

      let mids: Record<string, string> = {};
      try {
        mids = await fetchMids();
      } catch {
        // Price feed unavailable — still return positions without live PnL.
      }

      const positions = (data ?? []).map((p) => {
        const mark = mids[p.coin] ? Number(mids[p.coin]) : null;
        const dir = p.side === "long" ? 1 : -1;
        const pnl = mark == null ? null : (mark - p.entry_price) * p.size * dir;
        const margin = p.notional / (p.leverage || 1);
        return {
          id: p.id,
          coin: p.coin,
          side: p.side,
          size: p.size,
          leverage: p.leverage,
          notional: p.notional,
          entry_price: p.entry_price,
          mark_price: mark,
          stop_loss: p.stop_loss,
          take_profit: p.take_profit,
          trail_high: p.trail_high,
          unrealized_pnl: pnl == null ? null : Number(pnl.toFixed(2)),
          unrealized_pnl_pct_on_margin:
            pnl == null || margin === 0 ? null : Number(((pnl / margin) * 100).toFixed(2)),
          confidence: p.confidence,
          reason: p.reason,
          opened_at: p.opened_at,
        };
      });

      return textResult({ count: positions.length, positions });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
});
