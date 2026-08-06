import { createFileRoute, Link } from "@tanstack/react-router";
import { Activity, ShieldCheck, LineChart, Zap } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-panel-border">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded bg-primary" />
            <span className="mono text-sm font-semibold tracking-tight">ALETHEIA</span>
            <span className="text-xs text-muted-foreground">/ hyperliquid terminal</span>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/auth" className="text-sm text-muted-foreground hover:text-foreground">Sign in</Link>
            <Link to="/auth" className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">Launch terminal</Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-14 sm:px-6 sm:py-24">
        <div className="max-w-3xl">
          <div className="mono text-xs uppercase tracking-widest text-primary">Hyperliquid · USDC Perpetuals</div>
          <h1 className="mt-4 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl lg:text-5xl">
            An algorithmic trading terminal built for <span className="text-primary">disciplined execution</span>.
          </h1>
          <p className="mt-6 text-base text-muted-foreground sm:text-lg">
            Real-time scanner across every Hyperliquid perpetual market. Multi-confirmation trend/momentum strategy with strict risk limits, correlation guards, and a one-click kill switch. Paper trade first — every decision fully transparent.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link to="/auth" className="rounded-md bg-primary px-6 py-3 text-center text-sm font-medium text-primary-foreground hover:opacity-90">Open terminal</Link>
            <a href="#features" className="rounded-md border border-panel-border px-6 py-3 text-center text-sm font-medium hover:bg-panel">How it works</a>
          </div>
        </div>

        <div id="features" className="mt-16 grid sm:mt-24 grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: Activity, title: "Live market scanner", body: "WebSocket feed across all Hyperliquid USDC perps. EMA/RSI/MACD/ATR computed in real time." },
            { icon: LineChart, title: "Multi-confirmation strategy", body: "Trades only fire when trend, momentum and volatility filters all agree above your confidence threshold." },
            { icon: ShieldCheck, title: "Institutional risk engine", body: "Leverage caps, position sizing, portfolio exposure, correlation guard, daily loss circuit breaker." },
            { icon: Zap, title: "Kill switch", body: "One click halts automation and flattens every position with reduce-only orders." },
          ].map(({ icon: I, title, body }) => (
            <div key={title} className="panel p-5">
              <I className="h-5 w-5 text-primary" />
              <div className="mt-3 text-sm font-semibold">{title}</div>
              <div className="mt-1.5 text-sm text-muted-foreground">{body}</div>
            </div>
          ))}
        </div>

        <div className="panel mt-12 p-4 text-sm text-muted-foreground sm:p-6">
          <div className="mono text-xs uppercase tracking-widest text-warning">Disclaimer</div>
          <p className="mt-2">
            This software is provided for research and educational purposes. Leveraged perpetual futures carry substantial risk of loss, including full liquidation. Nothing here is financial advice. Paper trade until you understand every decision the engine makes. Automated 24/7 execution requires running the executor service on your own always-on infrastructure — see the docs after signing in.
          </p>
        </div>
      </main>
    </div>
  );
}
