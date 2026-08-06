import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { errorResult, fetchMids, requireUser, textResult } from "../supabase";

export default defineTool({
  name: "close_paper_position",
  title: "Close a paper position",
  description:
    "Close one open PAPER position at the current mark price, realize its PnL into paper equity and log the exit. Refuses when the account is in live mode — real Hyperliquid orders must be closed from the app.",
  inputSchema: {
    position_id: z.string().describe("Position id from list_open_positions.").optional(),
    coin: z.string().describe("Coin symbol, e.g. SOL. Used when position_id is not given.").optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  handler: async ({ position_id, coin }, ctx) => {
    try {
      const { supabase, userId } = requireUser(ctx);
      if (!position_id && !coin) return errorResult("Provide either position_id or coin.");

      const { data: settings, error: sErr } = await supabase
        .from("bot_settings")
        .select("mode, paper_equity")
        .eq("user_id", userId)
        .maybeSingle();
      if (sErr) return errorResult(sErr.message);
      if (!settings) return errorResult("No bot settings found for this account.");
      if (settings.mode === "live") {
        return errorResult("Account is in live mode — close live positions from the app, not over MCP.");
      }

      let query = supabase
        .from("paper_positions")
        .select("*")
        .eq("user_id", userId)
        .eq("status", "open");
      query = position_id ? query.eq("id", position_id) : query.eq("coin", coin!.toUpperCase());
      const { data: rows, error: pErr } = await query.limit(1);
      if (pErr) return errorResult(pErr.message);
      const position = rows?.[0];
      if (!position) return errorResult("No matching open position.");

      const mids = await fetchMids();
      const markStr = mids[position.coin];
      if (!markStr) return errorResult(`No mark price available for ${position.coin}.`);
      const mark = Number(markStr);

      const pnl =
        position.side === "long"
          ? (mark - position.entry_price) * position.size
          : (position.entry_price - mark) * position.size;

      const { error: uErr } = await supabase
        .from("paper_positions")
        .update({
          status: "closed",
          exit_price: mark,
          exit_reason: "manual (MCP)",
          pnl,
          closed_at: new Date().toISOString(),
        })
        .eq("id", position.id);
      if (uErr) return errorResult(uErr.message);

      const newEquity = Number(settings.paper_equity) + pnl;
      await supabase.from("bot_settings").update({ paper_equity: newEquity }).eq("user_id", userId);
      await supabase.from("bot_events").insert({
        user_id: userId,
        level: "trade",
        message: `CLOSE ${position.side.toUpperCase()} ${position.coin} @ ${mark.toFixed(6)} · PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDC · manual (MCP)`,
        meta: { source: "mcp", position_id: position.id },
      });

      return textResult({
        closed: { id: position.id, coin: position.coin, side: position.side },
        exit_price: mark,
        pnl: Number(pnl.toFixed(2)),
        paper_equity: Number(newEquity.toFixed(2)),
      });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
});
