import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { errorResult, requireUser, textResult } from "../supabase";

export default defineTool({
  name: "list_recent_trades",
  title: "List recent closed trades",
  description:
    "List the signed-in user's most recently closed paper trades with realized PnL, exit reason and the explanation logged at entry.",
  inputSchema: {
    limit: z.number().int().describe("How many trades to return (1-100, default 20).").optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ limit }, ctx) => {
    try {
      const { supabase, userId } = requireUser(ctx);
      const take = Math.min(Math.max(limit ?? 20, 1), 100);
      const { data, error } = await supabase
        .from("paper_positions")
        .select("*")
        .eq("user_id", userId)
        .eq("status", "closed")
        .order("closed_at", { ascending: false })
        .limit(take);
      if (error) return errorResult(error.message);

      const trades = (data ?? []).map((p) => ({
        id: p.id,
        coin: p.coin,
        side: p.side,
        entry_price: p.entry_price,
        exit_price: p.exit_price,
        pnl: p.pnl,
        exit_reason: p.exit_reason,
        reason: p.reason,
        confidence: p.confidence,
        opened_at: p.opened_at,
        closed_at: p.closed_at,
      }));
      const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
      const total = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

      return textResult({
        count: trades.length,
        win_rate_pct: trades.length ? Number(((wins / trades.length) * 100).toFixed(1)) : null,
        net_pnl: Number(total.toFixed(2)),
        trades,
      });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
});
