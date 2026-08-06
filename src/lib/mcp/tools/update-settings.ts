import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { errorResult, requireUser, textResult } from "../supabase";

export default defineTool({
  name: "update_settings",
  title: "Update bot settings",
  description:
    "Change the signed-in user's trading settings — enable/disable the bot, the 24/7 background agent, scanning, AI review, the kill switch, and risk/exit parameters. Only the fields you pass are changed.",
  inputSchema: {
    bot_enabled: z.boolean().describe("Master on/off for the bot.").optional(),
    server_agent_enabled: z.boolean().describe("Run the 24/7 background agent.").optional(),
    scalp_enabled: z.boolean().describe("Allow new entries; false = manage open trades only.").optional(),
    ai_review_enabled: z.boolean().describe("AI reviews every candidate entry before it is taken.").optional(),
    kill_switch_engaged: z.boolean().describe("Engage or reset the kill switch.").optional(),
    scalp_tp_pct: z.number().describe("Take-profit percent per trade.").optional(),
    scalp_sl_pct: z.number().describe("Stop-loss percent per trade.").optional(),
    trail_activate_pct: z.number().describe("Profit percent at which trailing arms.").optional(),
    trail_dist_pct: z.number().describe("Trailing stop distance in percent.").optional(),
    trailing_enabled: z.boolean().describe("Enable trailing stops.").optional(),
    max_positions: z.number().int().describe("Maximum concurrent open positions.").optional(),
    position_size_pct: z.number().describe("Percent of equity per position.").optional(),
    max_exposure_pct: z.number().describe("Maximum total exposure percent.").optional(),
    max_leverage: z.number().describe("Maximum leverage.").optional(),
    min_confidence: z.number().describe("Minimum signal confidence required to enter.").optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async (input, ctx) => {
    try {
      const { supabase, userId } = requireUser(ctx);
      const patch = Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      ) as Record<string, never>;
      if (Object.keys(patch).length === 0) return errorResult("No settings supplied.");


      const { data, error } = await supabase
        .from("bot_settings")
        .update(patch)
        .eq("user_id", userId)
        .select()
        .maybeSingle();
      if (error) return errorResult(error.message);
      if (!data) return errorResult("No bot settings row found for this account.");

      await supabase.from("bot_events").insert({
        user_id: userId,
        level: "info",
        message: `Settings updated via MCP: ${Object.keys(patch).join(", ")}`,
        meta: patch,
      });

      return textResult({ updated: Object.keys(patch), settings: data });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
});
