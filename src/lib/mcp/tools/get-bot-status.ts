import { defineTool } from "@lovable.dev/mcp-js";
import { errorResult, requireUser, textResult } from "../supabase";

export default defineTool({
  name: "get_bot_status",
  title: "Get bot status",
  description:
    "Overall trading bot status for the signed-in user: enabled flags, kill switch, mode, paper equity, open position count and last agent cycle.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    try {
      const { supabase, userId } = requireUser(ctx);
      const [{ data: settings, error: sErr }, { count, error: pErr }] = await Promise.all([
        supabase.from("bot_settings").select("*").eq("user_id", userId).maybeSingle(),
        supabase
          .from("paper_positions")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("status", "open"),
      ]);
      if (sErr) return errorResult(sErr.message);
      if (pErr) return errorResult(pErr.message);
      if (!settings) return errorResult("No bot settings found for this account yet.");

      const lastCycleAt = settings.last_cycle_at;
      const ageSec = lastCycleAt ? Math.round((Date.now() - new Date(lastCycleAt).getTime()) / 1000) : null;

      return textResult({
        mode: settings.mode,
        strategy_mode: settings.strategy_mode,
        bot_enabled: settings.bot_enabled,
        server_agent_enabled: settings.server_agent_enabled,
        scalp_enabled: settings.scalp_enabled,
        ai_review_enabled: settings.ai_review_enabled,
        kill_switch_engaged: settings.kill_switch_engaged,
        paper_equity: settings.paper_equity,
        open_positions: count ?? 0,
        last_cycle_at: lastCycleAt,
        last_cycle_age_seconds: ageSec,
        last_cycle_note: settings.last_cycle_note,
        agent_healthy: ageSec != null && ageSec < 180 && settings.server_agent_enabled,
      });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
});
