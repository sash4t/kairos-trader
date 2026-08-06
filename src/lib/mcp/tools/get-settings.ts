import { defineTool } from "@lovable.dev/mcp-js";
import { errorResult, requireUser, textResult } from "../supabase";

export default defineTool({
  name: "get_settings",
  title: "Get bot settings",
  description:
    "Read every trading setting for the signed-in user: risk limits, leverage, stop/target configuration, trailing and strategy mode.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    try {
      const { supabase, userId } = requireUser(ctx);
      const { data, error } = await supabase
        .from("bot_settings")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) return errorResult(error.message);
      if (!data) return errorResult("No bot settings found for this account yet.");
      return textResult(data);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
});
