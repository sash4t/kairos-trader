import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { Activity, BarChart3, History, LayoutDashboard, Radar, Settings, LogOut, Power, Menu, X } from "lucide-react";
import { useBot } from "@/lib/botContext";
import { supabase } from "@/integrations/supabase/client";
import { KillSwitch } from "./KillSwitch";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/positions", label: "Positions", icon: BarChart3 },
  { to: "/scanner", label: "Scanner", icon: Radar },
  { to: "/trades", label: "Trades", icon: History },
  { to: "/strategy", label: "Strategy", icon: Activity },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const nav = useNavigate();
  const { settings, saveSettings } = useBot();
  const [open, setOpen] = useState(false);

  useEffect(() => { setOpen(false); }, [loc.pathname]);

  const signOut = async () => { await supabase.auth.signOut(); nav({ to: "/auth" }); };

  const statusLabel = settings?.kill_switch_engaged ? "KILL SWITCH" : settings?.bot_enabled ? "RUNNING" : "STOPPED";

  const sidebar = (
    <>
      <div className="flex items-center gap-2 border-b border-panel-border px-5 py-4">
        <div className="h-6 w-6 shrink-0 rounded bg-primary" />
        <div className="min-w-0">
          <div className="mono truncate text-sm font-semibold">ALETHEIA</div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Hyperliquid</div>
        </div>
        <button onClick={() => setOpen(false)} className="ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-accent lg:hidden" aria-label="Close menu">
          <X className="h-4 w-4" />
        </button>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {NAV.map(({ to, label, icon: Icon }) => {
          const active = loc.pathname === to;
          return (
            <Link key={to} to={to}
              className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors ${active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
              <Icon className="h-4 w-4 shrink-0" />{label}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-2 border-t border-panel-border p-3">
        <div className="flex items-center justify-between gap-2 rounded-md bg-background px-3 py-2">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Bot</div>
            <div className={`truncate text-xs font-semibold ${settings?.bot_enabled ? "text-bull" : "text-muted-foreground"}`}>{statusLabel}</div>
          </div>
          <button
            disabled={!settings || settings.kill_switch_engaged}
            onClick={() => saveSettings({ bot_enabled: !settings?.bot_enabled })}
            className={`shrink-0 rounded-md p-2 transition ${settings?.bot_enabled ? "bg-bull/20 text-bull" : "bg-muted text-muted-foreground hover:bg-accent"} disabled:opacity-50`}
            title={settings?.bot_enabled ? "Stop bot" : "Start bot"}
          >
            <Power className="h-4 w-4" />
          </button>
        </div>
        <KillSwitch />
        <button onClick={signOut} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
          <LogOut className="h-4 w-4" /> Sign out
        </button>
        <div className="text-center text-[10px] text-muted-foreground">Paper trading mode</div>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-panel-border bg-panel lg:flex">{sidebar}</aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-[17rem] max-w-[85vw] flex-col border-r border-panel-border bg-panel">{sidebar}</aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-panel-border bg-panel/95 px-4 py-3 backdrop-blur lg:hidden">
          <button onClick={() => setOpen(true)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent" aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex min-w-0 items-center gap-2">
            <div className="h-5 w-5 shrink-0 rounded bg-primary" />
            <span className="mono truncate text-sm font-semibold">ALETHEIA</span>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className={`mono text-[10px] font-semibold uppercase tracking-widest ${settings?.kill_switch_engaged ? "text-bear" : settings?.bot_enabled ? "text-bull" : "text-muted-foreground"}`}>{statusLabel}</span>
            <button
              disabled={!settings || settings.kill_switch_engaged}
              onClick={() => saveSettings({ bot_enabled: !settings?.bot_enabled })}
              className={`rounded-md p-2 transition ${settings?.bot_enabled ? "bg-bull/20 text-bull" : "bg-muted text-muted-foreground"} disabled:opacity-50`}
              aria-label="Toggle bot"
            >
              <Power className="h-4 w-4" />
            </button>
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
