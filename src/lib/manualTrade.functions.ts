import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface ScannerTradeRequest {
  coin: string;
  side: "long" | "short";
  score: number;
  stage: "WATCH" | "CONFIRMED" | "RSI";
  reasons: string[];
  rsi?: number;
  atrPct?: number;
}

export interface ScannerTradeResult {
  coin: string;
  side: "long" | "short";
  status: "opened" | "skipped" | "error";
  message: string;
  size?: number;
  entryPrice?: number;
  leverage?: number;
}

export const placeScannerTrades = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { trades: ScannerTradeRequest[] }) => d)
  .handler(async ({ data, context }): Promise<{ opened: number; skipped: number; errors: number; results: ScannerTradeResult[] }> => {
    const trades = Array.isArray(data.trades) ? data.trades.slice(0, 50) : [];
    if (!trades.length) return { opened: 0, skipped: 0, errors: 0, results: [] };

    const { data: settings, error: settingsError } = await context.supabase
      .from("bot_settings")
      .select("*")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (settingsError || !settings) throw new Error(settingsError?.message ?? "Trading settings not found.");
    if (settings.kill_switch_engaged) throw new Error("Kill switch is engaged. Scanner trades are disabled.");

    const { data: existingRows, error: existingError } = await context.supabase
      .from("paper_positions")
      .select("coin,side,notional")
      .eq("user_id", context.userId)
      .eq("status", "open");
    if (existingError) throw new Error(existingError.message);

    const held = new Set((existingRows ?? []).map((p: any) => p.coin));
    const maxPositions = Math.max(1, Number(settings.max_positions ?? 5));
    const maxLeverage = Math.max(1, Number(settings.max_leverage ?? 1));
    const positionSizePct = Math.max(0.1, Number(settings.position_size_pct ?? 5));
    const maxExposurePct = Math.max(1, Number(settings.max_exposure_pct ?? 100));
    const configuredStop = Number(settings.scalp_sl_pct ?? 2);
    const hardStopPct = Number.isFinite(configuredStop) && configuredStop > 0 ? configuredStop : 2;
    const isLive = settings.mode === "live";

    const { hlInfo, loadAssetIndex, readHlCreds, fetchLiveAccount, setLeverage, marketOrder, ensureNativeStopLoss } = await import("./hyperliquidExchange.server");
    const [assets, mids] = await Promise.all([
      loadAssetIndex(),
      hlInfo<Record<string, string>>({ type: "allMids" }),
    ]);

    let equity = Number(settings.paper_equity ?? 10000);
    if (isLive) {
      const creds = readHlCreds();
      if (!creds) throw new Error("Hyperliquid live credentials are not configured.");
      const live = await fetchLiveAccount(creds.accountAddress);
      equity = live.accountValue;
    } else {
      const { data: closed } = await context.supabase
        .from("paper_positions")
        .select("pnl")
        .eq("user_id", context.userId)
        .eq("status", "closed");
      equity += (closed ?? []).reduce((sum: number, p: any) => sum + Number(p.pnl ?? 0), 0);
    }
    if (!(equity > 0)) throw new Error("Account equity is unavailable.");

    let totalNotional = (existingRows ?? []).reduce((sum: number, p: any) => sum + Math.abs(Number(p.notional ?? 0)), 0);
    const results: ScannerTradeResult[] = [];
    const unique = new Set<string>();

    for (const request of trades) {
      const coin = String(request.coin || "").trim().toUpperCase();
      const side = request.side;
      if (!coin || (side !== "long" && side !== "short")) continue;
      if (unique.has(coin)) continue;
      unique.add(coin);

      if (held.has(coin)) {
        results.push({ coin, side, status: "skipped", message: "An open position already exists for this coin." });
        continue;
      }
      if (held.size >= maxPositions) {
        results.push({ coin, side, status: "skipped", message: `Max positions limit reached (${maxPositions}).` });
        continue;
      }

      const asset = assets.get(coin);
      const mark = Number(mids[coin]);
      if (!asset || !Number.isFinite(mark) || mark <= 0) {
        results.push({ coin, side, status: "error", message: "Market metadata or price unavailable." });
        continue;
      }

      const leverage = Math.max(1, Math.floor(Math.min(maxLeverage, asset.maxLeverage)));
      // Exposure is an equity-allocation limit, independent of leverage.
      // 100% exposure means aggregate open notional may use up to 100% of account equity.
      const maxPortfolioNotional = equity * (maxExposurePct / 100);
      const remainingNotional = Math.max(0, maxPortfolioNotional - totalNotional);
      // Position size is also an equity-allocation percentage. Leverage affects margin required
      // by the exchange, but does not multiply the configured portfolio exposure budget.
      const targetNotional = equity * (positionSizePct / 100);
      const orderNotional = Math.min(targetNotional, remainingNotional);
      if (!(orderNotional > 0)) {
        results.push({ coin, side, status: "skipped", message: `Exposure limit reached (${maxExposurePct}% of equity).` });
        continue;
      }

      const requestedSize = orderNotional / mark;
      const stop = side === "long" ? mark * (1 - hardStopPct / 100) : mark * (1 + hardStopPct / 100);
      const confidence = Math.max(1, Math.min(100, Number(request.score ?? 0)));
      const reason = `${side.toUpperCase()} ${coin} [manual-scanner] — ${request.stage} · ${(request.reasons ?? []).join(" + ")}`;
      const indicators = {
        scannerScore: confidence,
        scannerStage: request.stage === "CONFIRMED" ? 2 : request.stage === "WATCH" ? 1 : 0,
        rsi: Number(request.rsi ?? Number.NaN),
        atrPct: Number(request.atrPct ?? Number.NaN),
      };

      try {
        let size = requestedSize;
        let entry = mark;
        if (isLive) {
          const creds = readHlCreds();
          if (!creds) throw new Error("Hyperliquid credentials are not configured.");
          await setLeverage(creds, asset, leverage, true);
          const fill = await marketOrder(creds, asset, { isBuy: side === "long", size: requestedSize, markPrice: mark, slippagePct: 0.75 });
          if (!(fill.size > 0)) throw new Error("Hyperliquid order did not fill.");
          size = fill.size;
          entry = fill.avgPrice || mark;
          const liveStop = side === "long" ? entry * (1 - hardStopPct / 100) : entry * (1 + hardStopPct / 100);
          await ensureNativeStopLoss(creds, asset, { positionSide: side, size, triggerPrice: liveStop });
        }

        const actualStop = side === "long" ? entry * (1 - hardStopPct / 100) : entry * (1 + hardStopPct / 100);
        const notional = size * entry;
        const { error: insertError } = await context.supabase.from("paper_positions").insert({
          user_id: context.userId,
          coin,
          side,
          size,
          notional,
          leverage,
          entry_price: entry,
          stop_loss: actualStop,
          take_profit: null,
          confidence,
          reason,
          indicators,
          initial_stop: actualStop,
          timeframe: "1h",
        });
        if (insertError) throw new Error(insertError.message);

        await context.supabase.from("bot_events").insert({
          user_id: context.userId,
          level: "trade",
          message: `${isLive ? "LIVE " : "PAPER "}MANUAL ${side.toUpperCase()} ${coin} @ ${entry.toFixed(6)} · size ${size} · ${leverage}x · scanner ${request.stage}`,
          meta: { coin, side, scanner: true, score: confidence, stage: request.stage, live: isLive },
        });

        totalNotional += notional;
        held.add(coin);
        results.push({ coin, side, status: "opened", message: "Position opened.", size, entryPrice: entry, leverage });
      } catch (err) {
        results.push({ coin, side, status: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      opened: results.filter((r) => r.status === "opened").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      errors: results.filter((r) => r.status === "error").length,
      results,
    };
  });
