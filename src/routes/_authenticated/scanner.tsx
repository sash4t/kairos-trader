import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { fetchCandles, fetchMetaAndCtxs, type AssetCtx, type AssetMeta } from "@/lib/hyperliquid";
import { candlesToBars, getTrendlineState } from "@/lib/strategy";
import { atr, rsi } from "@/lib/indicators";
import { useBot } from "@/lib/botContext";
import { Loader2, RefreshCw, TrendingDown, TrendingUp, Zap } from "lucide-react";

export const Route = createFileRoute("/_authenticated/scanner")({ component: Scanner });

type SignalKind = "rsi_oversold" | "rsi_overbought" | "breakout_long" | "breakout_short";

type Opportunity = {
  meta: AssetMeta;
  ctx: AssetCtx;
  kind: SignalKind;
  score: number;
  price: number;
  rsi: number;
  atrPct: number;
  volume24h: number;
  openInterest: number;
  volumeX: number;
  breakoutPct: number;
  reason: string;
};

const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;
const MAX_RESULTS = 30;

function Scanner() {
  const { mids } = useBot();
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(false);
  const [scannedCount, setScannedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [lastScannedAt, setLastScannedAt] = useState<number | null>(null);

  const runScan = async () => {
    setLoading(true);
    setOpportunities([]);
    setScannedCount(0);

    try {
      const [m, ctxs] = await fetchMetaAndCtxs();
      const markets = m.universe
        .map((meta, i) => ({ meta, ctx: ctxs[i] }))
        .filter((r): r is { meta: AssetMeta; ctx: AssetCtx } => Boolean(r.ctx));

      setTotalCount(markets.length);
      const found: Opportunity[] = [];

      for (let i = 0; i < markets.length; i++) {
        const { meta, ctx } = markets[i];
        const now = Date.now();
        try {
          const cs = await fetchCandles(meta.name, "1h", now - 220 * 60 * 60_000, now);
          const bars = candlesToBars(cs);
          if (bars.length < 80) {
            setScannedCount(i + 1);
            continue;
          }

          const closes = bars.map((b) => b.c);
          const volumes = bars.map((b) => b.v);
          const currentPrice = bars.at(-1)!.c;
          const previousClose = bars.at(-2)!.c;
          const rsiValue = rsi(closes, 14).at(-1) ?? NaN;
          const atrValue = atr(bars, 14).at(-1) ?? 0;
          const atrPct = currentPrice ? (atrValue / currentPrice) * 100 : 0;
          const avgVolume = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.max(1, volumes.slice(-21, -1).length);
          const volumeX = volumes.at(-1)! / (avgVolume || 1);
          const trendState = getTrendlineState(bars.slice(0, -1));
          const resistancePrev = trendState.resistance?.valueAt(bars.length - 2);
          const resistanceNow = trendState.resistance?.valueAt(bars.length - 1);
          const supportPrev = trendState.support?.valueAt(bars.length - 2);
          const supportNow = trendState.support?.valueAt(bars.length - 1);
          const volume24h = Number(ctx.dayNtlVlm) || 0;
          const openInterest = Number(ctx.openInterest) || 0;

          if (Number.isFinite(rsiValue) && rsiValue <= RSI_OVERSOLD) {
            const extremity = Math.min(25, RSI_OVERSOLD - rsiValue);
            const score = Math.min(100, 60 + extremity * 1.6 + Math.min(15, Math.max(0, volumeX - 1) * 10));
            found.push({
              meta, ctx, kind: "rsi_oversold", score, price: currentPrice, rsi: rsiValue, atrPct,
              volume24h, openInterest, volumeX, breakoutPct: 0,
              reason: `RSI ${rsiValue.toFixed(1)} is deeply oversold${volumeX > 1.2 ? ` with ${volumeX.toFixed(2)}x hourly volume` : ""}.`,
            });
          }

          if (Number.isFinite(rsiValue) && rsiValue >= RSI_OVERBOUGHT) {
            const extremity = Math.min(25, rsiValue - RSI_OVERBOUGHT);
            const score = Math.min(100, 60 + extremity * 1.6 + Math.min(15, Math.max(0, volumeX - 1) * 10));
            found.push({
              meta, ctx, kind: "rsi_overbought", score, price: currentPrice, rsi: rsiValue, atrPct,
              volume24h, openInterest, volumeX, breakoutPct: 0,
              reason: `RSI ${rsiValue.toFixed(1)} is deeply overbought${volumeX > 1.2 ? ` with ${volumeX.toFixed(2)}x hourly volume` : ""}.`,
            });
          }

          if (resistancePrev != null && resistanceNow != null && previousClose <= resistancePrev && currentPrice > resistanceNow) {
            const breakoutPct = ((currentPrice - resistanceNow) / resistanceNow) * 100;
            const score = Math.min(100, 72 + Math.min(12, breakoutPct * 12) + Math.min(12, Math.max(0, volumeX - 1) * 8));
            found.push({
              meta, ctx, kind: "breakout_long", score, price: currentPrice, rsi: rsiValue, atrPct,
              volume24h, openInterest, volumeX, breakoutPct,
              reason: `1H close broke above trendline resistance by ${breakoutPct.toFixed(2)}%${volumeX > 1.1 ? ` on ${volumeX.toFixed(2)}x volume` : ""}.`,
            });
          }

          if (supportPrev != null && supportNow != null && previousClose >= supportPrev && currentPrice < supportNow) {
            const breakoutPct = ((supportNow - currentPrice) / supportNow) * 100;
            const score = Math.min(100, 72 + Math.min(12, breakoutPct * 12) + Math.min(12, Math.max(0, volumeX - 1) * 8));
            found.push({
              meta, ctx, kind: "breakout_short", score, price: currentPrice, rsi: rsiValue, atrPct,
              volume24h, openInterest, volumeX, breakoutPct,
              reason: `1H close broke below trendline support by ${breakoutPct.toFixed(2)}%${volumeX > 1.1 ? ` on ${volumeX.toFixed(2)}x volume` : ""}.`,
            });
          }
        } catch {
          // Keep scanning the remaining markets if one candle request fails.
        }
        setScannedCount(i + 1);
      }

      const deduped = new Map<string, Opportunity>();
      for (const item of found) {
        const existing = deduped.get(item.meta.name);
        if (!existing || item.score > existing.score) deduped.set(item.meta.name, item);
      }
      setOpportunities([...deduped.values()].sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS));
      setLastScannedAt(Date.now());
    } finally {
      setLoading(false);
    }
  };

  const stats = useMemo(() => ({
    bullish: opportunities.filter((o) => o.kind === "rsi_oversold" || o.kind === "breakout_long").length,
    bearish: opportunities.filter((o) => o.kind === "rsi_overbought" || o.kind === "breakout_short").length,
    breakouts: opportunities.filter((o) => o.kind === "breakout_long" || o.kind === "breakout_short").length,
  }), [opportunities]);

  const labelFor = (kind: SignalKind) => {
    if (kind === "rsi_oversold") return "RSI Oversold";
    if (kind === "rsi_overbought") return "RSI Overbought";
    if (kind === "breakout_long") return "Bullish Breakout";
    return "Bearish Breakout";
  };

  const toneFor = (kind: SignalKind) =>
    kind === "rsi_oversold" || kind === "breakout_long" ? "text-bull" : "text-bear";

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold">Signal scanner</h1>
          <p className="text-sm text-muted-foreground">Scans every Hyperliquid perp and only surfaces markets with notable RSI extremes or fresh 1H trendline breakouts.</p>
        </div>
        <button onClick={runScan} disabled={loading} className="w-full shrink-0 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:w-auto">
          {loading ? <><Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin" />Scanning {scannedCount}/{totalCount || "…"}</> : <><RefreshCw className="mr-2 inline h-3.5 w-3.5" />Scan Hyperliquid</>}
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="panel p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><TrendingUp className="h-4 w-4" />Bullish candidates</div><div className="mt-2 text-2xl font-semibold mono">{stats.bullish}</div></div>
        <div className="panel p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><TrendingDown className="h-4 w-4" />Bearish candidates</div><div className="mt-2 text-2xl font-semibold mono">{stats.bearish}</div></div>
        <div className="panel p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Zap className="h-4 w-4" />Fresh breakouts</div><div className="mt-2 text-2xl font-semibold mono">{stats.breakouts}</div></div>
      </div>

      {lastScannedAt && !loading ? <div className="text-xs text-muted-foreground">Last scan: {new Date(lastScannedAt).toLocaleTimeString()} · showing up to {MAX_RESULTS} highest-scoring markets</div> : null}

      {!loading && opportunities.length === 0 ? (
        <div className="panel p-8 text-center">
          <div className="font-medium">No signal list yet</div>
          <div className="mt-1 text-sm text-muted-foreground">Run a scan to check all Hyperliquid perp pairs. Quiet markets stay hidden.</div>
        </div>
      ) : null}

      {opportunities.length > 0 ? (
        <div className="grid gap-3 xl:grid-cols-2">
          {opportunities.map((o) => {
            const livePrice = Number(mids[o.meta.name] ?? o.price);
            return (
              <div key={o.meta.name} className="panel p-4 sm:p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="mono text-lg font-semibold">{o.meta.name}</div>
                      <span className={`rounded-full border border-panel-border px-2 py-0.5 text-[11px] font-semibold ${toneFor(o.kind)}`}>{labelFor(o.kind)}</span>
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">{o.reason}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Score</div>
                    <div className={`mono text-xl font-semibold ${toneFor(o.kind)}`}>{o.score.toFixed(0)}</div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">Price</div><div className="mono mt-1">{livePrice.toPrecision(7)}</div></div>
                  <div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">RSI 14</div><div className="mono mt-1">{Number.isFinite(o.rsi) ? o.rsi.toFixed(1) : "—"}</div></div>
                  <div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">1H vol</div><div className="mono mt-1">{o.volumeX.toFixed(2)}x</div></div>
                  <div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">ATR</div><div className="mono mt-1">{o.atrPct.toFixed(2)}%</div></div>
                  <div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">24h volume</div><div className="mono mt-1">${(o.volume24h / 1e6).toFixed(1)}M</div></div>
                  <div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">Open interest</div><div className="mono mt-1">{o.openInterest.toFixed(0)}</div></div>
                  <div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">Funding</div><div className="mono mt-1">{(Number(o.ctx.funding) * 100).toFixed(4)}%</div></div>
                  <div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">Break distance</div><div className="mono mt-1">{o.breakoutPct ? `${o.breakoutPct.toFixed(2)}%` : "—"}</div></div>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
