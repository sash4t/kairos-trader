import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type HlFill = {
  coin: string;
  px: string;
  sz: string;
  dir: string;
  time: number;
  closedPnl?: string;
  fee?: string;
  feeToken?: string;
};

type HlFunding = {
  time: number;
  delta?: { coin?: string; usdc?: string };
};

/**
 * Replace mark-price estimates on trades that Hyperliquid closed before the
 * server agent observed the close. Uses the exchange's actual closing fills,
 * fill fees and funding ledger so Trade History stores net realized PnL.
 */
export const reconcileExchangeClosedTrades = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { readHlCreds, hlInfo } = await import("./hyperliquidExchange.server");
    const creds = readHlCreds();
    if (!creds) return { reconciled: 0, skipped: 0 };

    const { data: rows, error } = await context.supabase
      .from("paper_positions")
      .select("id,coin,side,opened_at,closed_at")
      .eq("user_id", context.userId)
      .eq("status", "closed")
      .eq("exit_reason", "exchange_already_closed")
      .order("closed_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);

    let reconciled = 0;
    let skipped = 0;
    for (const row of rows ?? []) {
      const opened = Date.parse(row.opened_at ?? "");
      const closed = Date.parse(row.closed_at ?? "");
      if (!Number.isFinite(opened) || !Number.isFinite(closed)) { skipped++; continue; }

      // Small buffers cover clock/polling skew while keeping separate position
      // lifecycles on the same coin isolated.
      const startTime = Math.max(0, opened - 5_000);
      const endTime = closed + 60_000;
      const fills = await hlInfo<HlFill[]>({
        type: "userFillsByTime",
        user: creds.accountAddress,
        startTime,
        endTime,
        aggregateByTime: true,
      }).catch(() => []);

      const coinFills = fills.filter((f) => f.coin === row.coin && f.time >= startTime && f.time <= endTime);
      const closePattern = row.side === "long" ? /close long/i : /close short/i;
      const closing = coinFills.filter((f) => closePattern.test(f.dir ?? "") && +f.sz > 0 && +f.px > 0);
      if (!closing.length) { skipped++; continue; }

      const closedSize = closing.reduce((sum, f) => sum + +f.sz, 0);
      const exitPrice = closedSize > 0
        ? closing.reduce((sum, f) => sum + (+f.px * +f.sz), 0) / closedSize
        : 0;
      if (!(exitPrice > 0)) { skipped++; continue; }

      // Hyperliquid reports closedPnl on closing fills. Sum it rather than
      // reconstructing PnL from a sampled mark, then subtract actual USDC fees.
      const grossRealized = closing.reduce((sum, f) => {
        const value = +(f.closedPnl ?? 0);
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0);
      const feesPaid = coinFills.reduce((sum, f) => {
        if (f.feeToken && f.feeToken !== "USDC") return sum;
        const value = +(f.fee ?? 0);
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0);
      const funding = await hlInfo<HlFunding[]>({
        type: "userFunding",
        user: creds.accountAddress,
        startTime,
        endTime,
      }).catch(() => []);
      const fundingPnl = funding.reduce((sum, f) => {
        if (f.delta?.coin !== row.coin || f.time < startTime || f.time > endTime) return sum;
        const value = +(f.delta?.usdc ?? 0);
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0);
      const netPnl = grossRealized - feesPaid + fundingPnl;

      const { error: updateError } = await context.supabase
        .from("paper_positions")
        .update({
          exit_price: exitPrice,
          pnl: netPnl,
          exit_reason: "exchange_already_closed_reconciled",
        })
        .eq("id", row.id)
        .eq("user_id", context.userId)
        .eq("exit_reason", "exchange_already_closed");
      if (updateError) throw new Error(updateError.message);
      reconciled++;
    }

    return { reconciled, skipped };
  });
