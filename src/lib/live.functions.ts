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

/** Emergency: market-close every live Hyperliquid position with reduce-only orders. */
export const flattenLive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ closed: number; errors: string[] }> => {
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
        await marketOrder(creds, asset, {
          isBuy: p.side === "short", size: p.size, markPrice: mark, reduceOnly: true, slippagePct: 1,
        });
        closed++;
      } catch (err) {
        errors.push(`${p.coin}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { closed, errors };
  });
