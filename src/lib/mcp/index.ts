import { auth, defineMcp } from "@lovable.dev/mcp-js";
import getBotStatus from "./tools/get-bot-status";
import listOpenPositions from "./tools/list-open-positions";
import listRecentTrades from "./tools/list-recent-trades";
import listBotEvents from "./tools/list-bot-events";
import getSettings from "./tools/get-settings";
import updateSettings from "./tools/update-settings";
import closePaperPosition from "./tools/close-paper-position";

const projectRef = import.meta.env['VITE_SUPABASE_PROJECT_ID'] ?? "project-ref-unset";

export default defineMcp({
  name: "hyperwealth-bot",
  title: "Hyperwealth Bot",
  version: "0.1.0",
  instructions:
    "Tools for the Hyperwealth Hyperliquid trading bot. Use get_bot_status for a health check, list_open_positions and list_recent_trades to review performance, list_bot_events to see why the agent did or did not trade, get_settings/update_settings to change risk and exit parameters or flip the kill switch, and close_paper_position to exit a paper trade. All data is scoped to the signed-in user.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [
    getBotStatus,
    listOpenPositions,
    listRecentTrades,
    listBotEvents,
    getSettings,
    updateSettings,
    closePaperPosition,
  ],
});
