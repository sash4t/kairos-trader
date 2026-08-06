// Hyperliquid public API + WebSocket client (browser-side, no auth required for reads).
// Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api

export const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
export const HL_WS_URL = "wss://api.hyperliquid.xyz/ws";

export interface AssetMeta { name: string; szDecimals: number; maxLeverage: number }
export interface AssetCtx {
  funding: string; openInterest: string; prevDayPx: string;
  dayNtlVlm: string; premium: string | null; oraclePx: string; markPx: string;
  midPx: string | null; impactPxs: [string, string] | null;
}
export interface UserState {
  marginSummary: { accountValue: string; totalMarginUsed: string; totalNtlPos: string; totalRawUsd: string };
  crossMarginSummary: { accountValue: string; totalMarginUsed: string; totalNtlPos: string; totalRawUsd: string };
  withdrawable: string;
  assetPositions: Array<{
    position: { coin: string; szi: string; entryPx: string; leverage: { type: string; value: number }; unrealizedPnl: string; positionValue: string; liquidationPx: string | null }
  }>;
}

async function post<T>(body: unknown): Promise<T> {
  const res = await fetch(HL_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid ${res.status}`);
  return res.json();
}

export async function fetchMetaAndCtxs(): Promise<[{ universe: AssetMeta[] }, AssetCtx[]]> {
  return post({ type: "metaAndAssetCtxs" });
}

export async function fetchUserState(user: string): Promise<UserState> {
  return post({ type: "clearinghouseState", user });
}

export interface Candle { t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number }

export async function fetchCandles(coin: string, interval: string, startMs: number, endMs: number): Promise<Candle[]> {
  return post({ type: "candleSnapshot", req: { coin, interval, startTime: startMs, endTime: endMs } });
}

// -------- WebSocket manager --------
type Handler = (msg: any) => void;

class HLWebSocket {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private subs = new Set<string>();
  private reconnectTimer: any = null;

  private key(sub: any): string { return JSON.stringify(sub); }

  private ensureOpen() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.ws = new WebSocket(HL_WS_URL);
    this.ws.onopen = () => {
      // re-subscribe
      for (const s of this.subs) this.ws?.send(JSON.stringify({ method: "subscribe", subscription: JSON.parse(s) }));
    };
    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        const channel = msg.channel;
        if (!channel) return;
        const set = this.handlers.get(channel);
        if (set) for (const h of set) h(msg);
      } catch {}
    };
    this.ws.onclose = () => {
      this.ws = null;
      if (this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.ensureOpen(); }, 2000);
    };
    this.ws.onerror = () => this.ws?.close();
  }

  subscribe(sub: any, channel: string, h: Handler): () => void {
    this.ensureOpen();
    const k = this.key(sub);
    if (!this.subs.has(k)) {
      this.subs.add(k);
      const send = () => this.ws?.send(JSON.stringify({ method: "subscribe", subscription: sub }));
      if (this.ws?.readyState === WebSocket.OPEN) send();
    }
    if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
    this.handlers.get(channel)!.add(h);
    return () => {
      this.handlers.get(channel)?.delete(h);
    };
  }
}

let _ws: HLWebSocket | null = null;
export function hlWs(): HLWebSocket {
  if (!_ws) _ws = new HLWebSocket();
  return _ws;
}

// Subscribe to allMids for all coins (map coin -> mid)
export function subscribeAllMids(cb: (mids: Record<string, string>) => void): () => void {
  return hlWs().subscribe({ type: "allMids" }, "allMids", (msg) => {
    if (msg?.data?.mids) cb(msg.data.mids);
  });
}

// Subscribe to per-coin candles
export function subscribeCandles(coin: string, interval: string, cb: (candle: Candle) => void): () => void {
  return hlWs().subscribe(
    { type: "candle", coin, interval },
    "candle",
    (msg) => { if (msg?.data?.s === coin && msg?.data?.i === interval) cb(msg.data); },
  );
}
