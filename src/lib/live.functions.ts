import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface LiveStatus {
  configured: boolean;
  approved: boolean;
  accountAddress: string | null;
  agentAddress: string | null;
  detail: string;
  account: {
    accountValue: number;
    withdrawable: number;
    totalMarginUsed: number;
    positions: { coin: string; size: number; side: "long" | "short"; entryPrice: number; unrealizedPnl: number; leverage: number }[];
  } | null;
}

/** Reports whether the Hyperliquid API wallet is configured, approved, and funded. */
export const getLiveStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<LiveStatus> => {
    const { readHlCreds, checkAgentApproved, fetchLiveAccount } = await import("./hyperliquidExchange.server");
    const creds = readHlCreds();
    if (!creds) {
      return {
        configured: false, approved: false, accountAddress: null, agentAddress: null,
        detail: "Hyperliquid API credentials are not saved yet.", account: null,
      };
    }
    const check = await checkAgentApproved(creds);
    let account: LiveStatus["account"] = null;
    try {
      account = await fetchLiveAccount(creds.accountAddress);
    } catch { /* account read is best-effort */ }
    return {
      configured: true,
      approved: check.ok,
      accountAddress: creds.accountAddress,
      agentAddress: check.agentAddress,
      detail: check.detail,
      account,
    };
  });

/**
 * Close one live Hyperliquid position and reconcile the local record.
 * The exchange is authoritative: a local position is never marked closed
 * unless the reduce-only order actually fills and the exchange confirms
 * that no position remains (or records the remaining partial size).
 */
export const closeLivePosition = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }): Promise<{
    coin: string;
    side: "long" | "short";
    requestedSize: number;
    filledSize: number;
    remainingSize: number;
    closed: boolean;
    exitPrice: number | null;
    error?: string;
  }> => {
    const { readHlCreds, fetchLiveAccount, loadAssetIndex, marketOrder, hlInfo } =
      await import("./hyperliquidExchange.server");
    const creds = readHlCreds();
    if (!creds) throw new Error("Hyperliquid credentials are not configured.");

    const { coin, side } = data as { coin: string; side: "long" | "short" };
    if (!coin || (side !== "long" && side !== "short")) throw new Error("Invalid live position.");

    // Never trust the stale/local size. Read the actual exchange position first.
    const account = await fetchLiveAccount(creds.accountAddress);
    const live = account.positions.find((p) => p.coin === coin && p.side === side);
    if (!live || live.size <= 0) {
      return { coin, side, requestedSize: 0, filledSize: 0, remainingSize: 0, closed: true, exitPrice: null };
    }

    const assets = await loadAssetIndex();
    const asset = assets.get(coin);
    if (!asset) throw new Error(`${coin}: unknown Hyperliquid asset`);

    const mids = await hlInfo<Record<string, string>>({ type: "allMids" });
    const mark = mids[coin] ? +mids[coin] : live.entryPrice;
    if (!Number.isFinite(mark) || mark <= 0) throw new Error(`${coin}: invalid market price`);

    const fill = await marketOrder(creds, asset, {
      isBuy: live.side === "short",
      size: live.size,
      markPrice: mark,
      reduceOnly: true,
      slippagePct: 1,
    });

    // Zero-fill means the exchange did not close anything. Do not mutate the
    // local position to CLOSED in that case.
    if (fill.size <= 0) {
      return {
        coin, side, requestedSize: live.size, filledSize: 0, remainingSize: live.size,
        closed: false, exitPrice: null, error: "Hyperliquid close order did not fill.",
      };
    }

    // Exchange state is authoritative after the order. This also catches
    // partial fills and avoids reporting a local close that did not happen.
    const after = await fetchLiveAccount(creds.accountAddress);
    const remaining = after.positions.find((p) => p.coin === coin && p.side === side)?.size ?? 0;
    const px = fill.avgPrice || mark;
    const filled = Math.min(fill.size, live.size);
    const pnl = live.side === "long"
      ? (px - live.entryPrice) * filled
      : (live.entryPrice - px) * filled;

    if (remaining <= 0) {
      const { error } = await context.supabase
        .from("paper_positions")
        .update({
          status: "closed",
          exit_price: px,
          exit_reason: "manual_live",
          pnl,
          closed_at: new Date().toISOString(),
        })
        .eq("user_id", context.userId)
        .eq("coin", coin)
        .eq("side", side)
        .eq("status", "open");
      if (error) throw new Error(`Exchange position closed, but local record update failed: ${error.message}`);
      return { coin, side, requestedSize: live.size, filledSize: filled, remainingSize: 0, closed: true, exitPrice: px };
    }

    // Partial fill: keep the local record OPEN and reflect the exchange size.
    const { error } = await context.supabase
      .from("paper_positions")
      .update({ size: remaining, notional: remaining * px })
      .eq("user_id", context.userId)
      .eq("coin", coin)
      .eq("side", side)
      .eq("status", "open");
    if (error) throw new Error(`Partial live close executed, but local size update failed: ${error.message}`);

    return { coin, side, requestedSize: live.size, filledSize: filled, remainingSize: remaining, closed: false, exitPrice: px };
  });

/** Emergency: market-close every live Hyperliquid position with reduce-only orders. */
export const flattenLive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ closed: number; errors: string[] }> => {
    const { readHlCreds, fetchLiveAccount, loadAssetIndex, marketOrder, hlInfo } =
      await import("./hyperliquidExchange.server");
    const creds = readHlCreds();
    if (!creds) throw new Error("Hyperliquid credentials are not configured.");

    const [account, assets, mids] = await Promise.all([
      fetchLiveAccount(creds.accountAddress),
      loadAssetIndex(),
      hlInfo<Record<string, string>>({ type: "allMids" }),
    ]);

    const errors: string[] = [];
    let closed = 0;
    for (const p of account.positions) {
      const asset = assets.get(p.coin);
      const mark = mids[p.coin] ? +mids[p.coin] : p.entryPrice;
      if (!asset) { errors.push(`${p.coin}: unknown asset`); continue; }
      try {
        const fill = await marketOrder(creds, asset, {
          isBuy: p.side === "short", size: p.size, markPrice: mark, reduceOnly: true, slippagePct: 1,
        });
        if (fill.size <= 0) { errors.push(`${p.coin}: order did not fill`); continue; }
        closed++;

        // Keep the app's records in step with the exchange.
        const px = fill.avgPrice || mark;
        const pnl = p.side === "long" ? (px - p.entryPrice) * fill.size : (p.entryPrice - px) * fill.size;
        const { error } = await context.supabase
          .from("paper_positions")
          .update({
            status: "closed", exit_price: px, exit_reason: "manual flatten",
            pnl, closed_at: new Date().toISOString(),
          })
          .eq("user_id", context.userId)
          .eq("coin", p.coin)
          .eq("side", p.side)
          .eq("status", "open");
        if (error) errors.push(`${p.coin}: record update failed (${error.message})`);
      } catch (err) {
        errors.push(`${p.coin}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { closed, errors };
  });
