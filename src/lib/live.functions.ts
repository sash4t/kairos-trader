import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface LiveStatus {
  configured: boolean;
  approved: boolean;
  accountAddress: string | null;
  agentAddress: string | null;
  detail: string;
  account: { accountValue: number; withdrawable: number; totalMarginUsed: number; positions: { coin: string; size: number; side: "long" | "short"; entryPrice: number; unrealizedPnl: number; leverage: number }[] } | null;
}

export const getLiveStatus = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async (): Promise<LiveStatus> => {
  const { readHlCreds, checkAgentApproved, fetchLiveAccount } = await import("./hyperliquidExchange.server");
  const creds = readHlCreds();
  if (!creds) return { configured: false, approved: false, accountAddress: null, agentAddress: null, detail: "Hyperliquid API credentials are not saved yet.", account: null };
  const check = await checkAgentApproved(creds);
  let account: LiveStatus["account"] = null;
  try { account = await fetchLiveAccount(creds.accountAddress); } catch {}
  return { configured: true, approved: check.ok, accountAddress: creds.accountAddress, agentAddress: check.agentAddress, detail: check.detail, account };
});

/** Close one LIVE Hyperliquid position, verify the exchange, then reconcile the local record. */
export const closeLivePosition = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { readHlCreds, fetchLiveAccount, loadAssetIndex, marketOrder, hlInfo } = await import("./hyperliquidExchange.server");
    const creds = readHlCreds();
    if (!creds) throw new Error("Hyperliquid credentials are not configured.");
    const { coin, side } = data as { coin: string; side: "long" | "short" };
    if (!coin || (side !== "long" && side !== "short")) throw new Error("Invalid live position.");

    const account = await fetchLiveAccount(creds.accountAddress);
    const live = account.positions.find((p) => p.coin === coin && p.side === side);
    if (!live || live.size <= 0) return { coin, side, requestedSize: 0, filledSize: 0, remainingSize: 0, closed: true, exitPrice: null };

    const assets = await loadAssetIndex();
    const asset = assets.get(coin);
    if (!asset) throw new Error(`${coin}: unknown Hyperliquid asset`);
    const mids = await hlInfo<Record<string, string>>({ type: "allMids" });
    const mark = mids[coin] ? +mids[coin] : live.entryPrice;
    if (!Number.isFinite(mark) || mark <= 0) throw new Error(`${coin}: invalid market price`);

    const fill = await marketOrder(creds, asset, { isBuy: live.side === "short", size: live.size, markPrice: mark, reduceOnly: true, slippagePct: 1 });
    if (fill.size <= 0) return { coin, side, requestedSize: live.size, filledSize: 0, remainingSize: live.size, closed: false, exitPrice: null, error: "Hyperliquid close order did not fill." };

    const after = await fetchLiveAccount(creds.accountAddress);
    const remaining = after.positions.find((p) => p.coin === coin && p.side === side)?.size ?? 0;
    const px = fill.avgPrice || mark;
    const filled = Math.min(fill.size, live.size);
    const pnl = live.side === "long" ? (px - live.entryPrice) * filled : (live.entryPrice - px) * filled;

    if (remaining <= 0) {
      const { error } = await context.supabase.from("paper_positions").update({ status: "closed", exit_price: px, exit_reason: "manual_live", pnl, closed_at: new Date().toISOString() }).eq("user_id", context.userId).eq("coin", coin).eq("side", side).eq("status", "open");
      if (error) throw new Error(`Exchange position closed, but local record update failed: ${error.message}`);
      return { coin, side, requestedSize: live.size, filledSize: filled, remainingSize: 0, closed: true, exitPrice: px };
    }

    const { error } = await context.supabase.from("paper_positions").update({ size: remaining, notional: remaining * px }).eq("user_id", context.userId).eq("coin", coin).eq("side", side).eq("status", "open");
    if (error) throw new Error(`Partial live close executed, but local size update failed: ${error.message}`);
    return { coin, side, requestedSize: live.size, filledSize: filled, remainingSize: remaining, closed: false, exitPrice: px };
  });

/** Emergency: market-close every live Hyperliquid position with reduce-only orders. */
export const flattenLive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ closed: number; errors: string[] }> => {
    const { readHlCreds, fetchLiveAccount, loadAssetIndex, marketOrder, hlInfo } = await import("./hyperliquidExchange.server");
    const creds = readHlCreds();
    if (!creds) throw new Error("Hyperliquid credentials are not configured.");
    const [account, assets, mids] = await Promise.all([fetchLiveAccount(creds.accountAddress), loadAssetIndex(), hlInfo<Record<string, string>>({ type: "allMids" })]);
    const errors: string[] = []; let closed = 0;
    for (const p of account.positions) {
      const asset = assets.get(p.coin); const mark = mids[p.coin] ? +mids[p.coin] : p.entryPrice;
      if (!asset) { errors.push(`${p.coin}: unknown asset`); continue; }
      try {
        const fill = await marketOrder(creds, asset, { isBuy: p.side === "short", size: p.size, markPrice: mark, reduceOnly: true, slippagePct: 1 });
        if (fill.size <= 0) { errors.push(`${p.coin}: order did not fill`); continue; }
        closed++;
        const px = fill.avgPrice || mark; const pnl = p.side === "long" ? (px - p.entryPrice) * fill.size : (p.entryPrice - px) * fill.size;
        const { error } = await context.supabase.from("paper_positions").update({ status: "closed", exit_price: px, exit_reason: "manual flatten", pnl, closed_at: new Date().toISOString() }).eq("user_id", context.userId).eq("coin", p.coin).eq("side", p.side).eq("status", "open");
        if (error) errors.push(`${p.coin}: record update failed (${error.message})`);
      } catch (err) { errors.push(`${p.coin}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    return { closed, errors };
  });
