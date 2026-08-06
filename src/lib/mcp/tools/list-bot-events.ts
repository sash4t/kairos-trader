import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { errorResult, requireUser, textResult } from "../supabase";

export default defineTool({
  name: "list_bot_events",
  title: "List bot events",
  description:
    "Read the signed-in user's trading event log — scan results, entries, exits, AI verdicts and errors — newest first.",
  inputSchema: {
    limit: z.number().int().describe("How many events to return (1-200, default 30).").optional(),
    level: z.string().describe("Optional level filter, e.g. info, warn, error, ai, trade.").optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ limit, level }, ctx) => {
    try {
      const { supabase, userId } = requireUser(ctx);
      const take = Math.min(Math.max(limit ?? 30, 1), 200);
      let query = supabase
        .from("bot_events")
        .select("*")
        .eq("user_id", userId)
        .order("ts", { ascending: false })
        .limit(take);
      if (level) query = query.eq("level", level);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      return textResult({ count: data?.length ?? 0, events: data ?? [] });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
});
