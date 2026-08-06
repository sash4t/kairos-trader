import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PaperEngine, type Settings } from "./paperEngine";
import { subscribeAllMids } from "./hyperliquid";
import { toast } from "sonner";
import { flattenLive } from "./live.functions";

interface BotCtx {
  userId: string | null;
  settings: Settings | null;
  mids: Record<string, string>;
  positionsVersion: number;      // bumped when engine mutates
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  killSwitch: () => Promise<void>;
  syncPositions: () => Promise<void>;
  engine: PaperEngine | null;
}

const Ctx = createContext<BotCtx | null>(null);

export function BotProvider({ children }: { children: React.ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mids, setMids] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0);
  const engineRef = useRef<PaperEngine | null>(null);

  // Get user
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  // Live mark prices — independent of the engine, which stays idle in live mode.
  useEffect(() => {
    let pending: Record<string, string> = {};
    const unsub = subscribeAllMids(m => { pending = { ...pending, ...m }; });
    const t = setInterval(() => {
      if (Object.keys(pending).length) setMids(prev => ({ ...prev, ...pending }));
    }, 1000);
    return () => { unsub(); clearInterval(t); };
  }, []);


  // Load + poll settings (the server agent mutates them too)
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const load = async () => {
      let { data } = await supabase.from("bot_settings").select("*").eq("user_id", userId).maybeSingle();
      if (!data) {
        // No settings row yet (new or reset account) — create defaults so the UI can render.
        const ins = await supabase.from("bot_settings").insert({ user_id: userId }).select().maybeSingle();
        if (ins.error) { if (!cancelled) toast.error(ins.error.message); return; }
        data = ins.data;
      }
      if (!cancelled && data) setSettings(prev => (prev && JSON.stringify(prev) === JSON.stringify(data) ? prev : (data as any)));
    };

    load();
    const t = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, [userId]);

  // Start/stop engine
  useEffect(() => {
    if (!userId || !settings) return;
    if (!engineRef.current) {
      engineRef.current = new PaperEngine(userId, settings, (level, message, meta) => {
        supabase.from("bot_events").insert({ user_id: userId, level, message, meta }).then(() => {});
        if (level === "trade") toast.success(message);
        else if (level === "warn") toast.warning(message);
        else if (level === "error") toast.error(message);
        setVersion(v => v + 1);
      });
      engineRef.current.start().catch(err => toast.error(err.message));
    } else {
      engineRef.current.updateSettings(settings);
    }
    // Mark prices are published by the dedicated allMids subscription above.

    return () => { /* keep engine alive across renders */ };
  }, [userId, settings]);

  useEffect(() => () => {
    engineRef.current?.stop(); engineRef.current = null;
  }, []);

  const saveSettings = async (patch: Partial<Settings>) => {
    if (!userId || !settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    const { error } = await supabase.from("bot_settings").update(patch).eq("user_id", userId);
    if (error) toast.error(error.message);
  };

  const killSwitch = async () => {
    if (settings?.mode === "live") {
      // Live positions exist on the exchange — only real reduce-only orders can flatten them.
      const res = await flattenLive();
      await saveSettings({ bot_enabled: false, kill_switch_engaged: true });
      if (res.errors.length) toast.error(`Closed ${res.closed} live position(s); errors: ${res.errors.join("; ")}`);
      else toast.warning(`Kill switch engaged. ${res.closed} live position(s) market-closed.`);
      return;
    }
    if (!engineRef.current) return;
    await engineRef.current.flattenAll("kill_switch");
    await saveSettings({ bot_enabled: false, kill_switch_engaged: true });
    toast.warning("Kill switch engaged. All paper positions flattened.");
  };

  const syncPositions = async () => {
    if (!engineRef.current) return;
    await engineRef.current.syncPositions();
    setVersion(v => v + 1);
  };

  const value = useMemo(() => ({
    userId, settings, mids, positionsVersion: version, saveSettings, killSwitch, syncPositions, engine: engineRef.current,
  }), [userId, settings, mids, version]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBot() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useBot must be used within BotProvider");
  return v;
}
