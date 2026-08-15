import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { fetchCandles, fetchMetaAndCtxs, type AssetCtx, type AssetMeta } from "@/lib/hyperliquid";
import { candlesToBars, getTrendlineState } from "@/lib/strategy";
import { atr, rsi } from "@/lib/indicators";
import { useBot } from "@/lib/botContext";
import { Loader2, RefreshCw, TrendingDown, TrendingUp, Zap } from "lucide-react";

export const Route = createFileRoute("/_authenticated/scanner")({ component: Scanner });

type SignalKind = "rsi_oversold" | "rsi_overbought" | "breakout_long" | "breakout_short" | "volume_surge";
type Direction = "bullish" | "bearish" | "neutral";

type SignalDetail = {
  kind: SignalKind;
  direction: Direction;
  score: number;
  label: string;
  reason: string;
  breakoutPct?: number;
};

type Opportunity = {
  meta: AssetMeta;
  ctx: AssetCtx;
  signals: SignalDetail[];
  score: number;
  direction: Direction;
  price: number;
  rsi: number;
  atrPct: number;
  volume24h: number;
  openInterest: number;
  volumeX: number;
  breakoutPct: number;
};

const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;
const VOLUME_SURGE_X = 1.5;
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
          const recentVolumes = volumes.slice(-21, -1);
          const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / Math.max(1, recentVolumes.length);
          const volumeX = volumes.at(-1)! / (avgVolume || 1);
          const trendState = getTrendlineState(bars.slice(0, -1));
          const resistancePrev = trendState.resistance?.valueAt(bars.length - 2);
          const resistanceNow = trendState.resistance?.valueAt(bars.length - 1);
          const supportPrev = trendState.support?.valueAt(bars.length - 2);
          const supportNow = trendState.support?.valueAt(bars.length - 1);
          const volume24h = Number(ctx.dayNtlVlm) || 0;
          const openInterest = Number(ctx.openInterest) || 0;
          const signals: SignalDetail[] = [];

          if (Number.isFinite(rsiValue) && rsiValue <= RSI_OVERSOLD) {
            const extremity = Math.min(25, RSI_OVERSOLD - rsiValue);
            const score = Math.min(100, 60 + extremity * 1.6 + Math.min(15, Math.max(0, volumeX - 1) * 10));
            signals.push({
              kind: "rsi_oversold",
              direction: "bullish",
              score,
              label: "RSI Oversold",
              reason: `RSI ${rsiValue.toFixed(1)} is deeply oversold.`,
            });
          }

          if (Number.isFinite(rsiValue) && rsiValue >= RSI_OVERBOUGHT) {
            const extremity = Math.min(25, rsiValue - RSI_OVERBOUGHT);
            const score = Math.min(100, 60 + extremity * 1.6 + Math.min(15, Math.max(0, volumeX - 1) * 10));
            signals.push({
              kind: "rsi_overbought",
              direction: "bearish",
              score,
              label: "RSI Overbought",
              reason: `RSI ${rsiValue.toFixed(1)} is deeply overbought.`,
            });
          }

          if (resistancePrev != null && resistanceNow != null && previousClose <= resistancePrev && currentPrice > resistanceNow) {
            const breakoutPct = ((currentPrice - resistanceNow) / resistanceNow) * 100;
            const score = Math.min(100, 72 + Math.min(12, breakoutPct * 12) + Math.min(12, Math.max(0, volumeX - 1) * 8));
            signals.push({
              kind: "breakout_long",
              direction: "bullish",
              score,
              label: "Bullish Breakout",
              breakoutPct,
              reason: `1H close broke above trendline resistance by ${breakoutPct.toFixed(2)}%.`,
            });
          }

          if (supportPrev != null && supportNow != null && previousClose >= supportPrev && currentPrice < supportNow) {
            const breakoutPct = ((supportNow - currentPrice) / supportNow) * 100;
            const score = Math.min(100, 72 + Math.min(12, breakoutPct * 12) + Math.min(12, Math.max(0, volumeX - 1) * 8));
            signals.push({
              kind: "breakout_short",
              direction: "bearish",
              score,
              label: "Bearish Breakout",
              breakoutPct,
              reason: `1H close broke below trendline support by ${breakoutPct.toFixed(2)}%.`,
            });
          }

          // Volume is a confirmation badge, not a standalone reason to surface a coin.
          if (signals.length > 0 && volumeX >= VOLUME_SURGE_X) {
            signals.push({
              kind: "volume_surge",
              direction: "neutral",
              score: Math.min(90, 55 + Math.min(35, (volumeX - VOLUME_SURGE_X) * 18)),
              label: `${volumeX.toFixed(2)}x Volume`,
              reason: `Current 1H volume is ${volumeX.toFixed(2)}x its recent 20-hour average.`,
            });
          }

          const directionalSignals = signals.filter((s) => s.direction !== "neutral");
          if (directionalSignals.length > 0) {
            const bullishCount = directionalSignals.filter((s) => s.direction === "bullish").length;
            const bearishCount = directionalSignals.filter((s) => s.direction === "bearish").length;
            const direction: Direction = bullishCount > bearishCount ? "bullish" : bearishCount > bullishCount ? "bearish" : "neutral";
            const strongestScore = Math.max(...directionalSignals.map((s) => s.score));
            const alignedConfluence = Math.max(bullishCount, bearishCount);
            const confluenceBonus = Math.max(0, alignedConfluence - 1) * 8 + (volumeX >= VOLUME_SURGE_X ? 4 : 0);
            const score = Math.min(100, strongestScore + confluenceBonus);
            const breakoutPct = Math.max(0, ...signals.map((s) => s.breakoutPct ?? 0));

            found.push({
              meta,
              ctx,
              signals,
              score,
              direction,
              price: currentPrice,
              rsi: rsiValue,
              atrPct,
              volume24h,
              openInterest,
              volumeX,
              breakoutPct,
            });
          }
        } catch {
          // Keep scanning the remaining markets if one candle request fails.
        }
        setScannedCount(i + 1);
      }

      setOpportunities(found.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS));
      setLastScannedAt(Date.now());
    } finally {
      setLoading(false);
    }
  };

  const stats = useMemo(() => ({
    bullish: opportunities.filter((o) => o.direction === "bullish").length,
    bearish: opportunities.filter((o) => o.direction === "bearish").length,
    breakouts: opportunities.filter((o) => o.signals.some((s) => s.kind === "breakout_long" || s.kind === "breakout_short")).length,
    confluence: opportunities.filter((o) => o.signals.filter((s) => s.direction !== "neutral").length >= 2).length,
  }), [opportunities]);

  const toneFor = (direction: Direction) =>
    direction === "bullish" ? "text-bull" : direction === "bearish" ? "text-bear" : "text-foreground";

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold">Signal scanner</h1>
          <p className="text-sm text-muted-foreground">Scans every Hyperliquid perp and only surfaces markets with notable RSI extremes or fresh 1H trendline breakouts. Multiple confirming signals stay grouped on the same coin.</p>
        </div>
        <button onClick={runScan} disabled={loading} className="w-full shrink-0 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:w-auto">
          {loading ? <><Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin" />Scanning {scannedCount}/{totalCount || "…"}</> : <><RefreshCw className="mr-2 inline h-3.5 w-3.5" />Scan Hyperliquid</>}
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="panel p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><TrendingUp className="h-4 w-4" />Bullish candidates</div><div className="mt-2 text-2xl font-semibold mono">{stats.bullish}</div></div>
        <div className="panel p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><TrendingDown className="h-4 w-4" />Bearish candidates</div><div className="mt-2 text-2xl font-semibold mono">{stats.bearish}</div></div>
        <div className="panel p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Zap className="h-4 w-4" />Fresh breakouts</div><div className="mt-2 text-2xl font-semibold mono">{stats.breakouts}</div></div>
        <div className="panel p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Zap className="h-4 w-4" />Confluence setups</div><div className="mt-2 text-2xl font-semibold mono">{stats.confluence}</div></div>
      </div>

      {lastScannedAt && !loading ? <div className="text-xs text-muted-foreground">Last scan: {new Date(lastScannedAt).toLocaleTimeString()} · showing up to {MAX_RESULTS} highest-scoring markets · confluence gets a ranking bonus</div> : null}

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
            const directionalCount = o.signals.filter((s) => s.direction !== "neutral").length;
            return (
              <div key={o.meta.name} className="panel p-4 sm:p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="mono text-lg font-semibold">{o.meta.name}</div>
                      {o.signals.map((signal) => (
                        <span key={signal.kind} className={`rounded-full border border-panel-border px-2 py-0.5 text-[11px] font-semibold ${toneFor(signal.direction)}`}>{signal.label}</span>
                      ))}
                      {directionalCount >= 2 ? <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">Confluence</span> : null}
                    </div>
                    <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                      {o.signals.map((signal) => <div key={`${signal.kind}-reason`}>• {signal.reason}</div>)}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Score</div>
                    <div className={`mono text-xl font-semibold ${toneFor(o.direction)}`}>{o.score.toFixed(0)}</div>
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
