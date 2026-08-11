import { encode as msgpackEncode } from "@msgpack/msgpack";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const INFO_URL = "https://api.hyperliquid.xyz/info";
const EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";
const SIGNATURE_SOURCE = "a";
/** Default: a 1% BTC move across the latest completed 1-minute candles is an emergency shock. */
export const BTC_SHOCK_THRESHOLD_PCT = 1;

export interface HlCreds { accountAddress: string; agentPrivateKey: Hex }
export function readHlCreds(): HlCreds | null {
  const accountAddress = process.env["HYPERLIQUID_ACCOUNT_ADDRESS"];
  const agentPrivateKey = process.env["HYPERLIQUID_AGENT_PRIVATE_KEY"];
  if (!accountAddress || !agentPrivateKey) return null;
  const pk = (agentPrivateKey.startsWith("0x") ? agentPrivateKey : `0x${agentPrivateKey}`) as Hex;
  return { accountAddress: accountAddress.trim(), agentPrivateKey: pk };
}

export async function hlInfo<T>(body: unknown): Promise<T> {
  const res = await fetch(INFO_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Hyperliquid info ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

function actionHash(action: unknown, nonce: number, vaultAddress: string | null): Hex {
  const packed = msgpackEncode(action);
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce), false);
  let extra: Uint8Array;
  if (vaultAddress === null) extra = new Uint8Array([0x00]);
  else {
    const addr = vaultAddress.replace(/^0x/, "");
    const bytes = new Uint8Array(21); bytes[0] = 0x01;
    for (let i = 0; i < 20; i++) bytes[i + 1] = parseInt(addr.slice(i * 2, i * 2 + 2), 16);
    extra = bytes;
  }
  const out = new Uint8Array(packed.length + 8 + extra.length);
  out.set(packed, 0); out.set(nonceBytes, packed.length); out.set(extra, packed.length + 8);
  return keccak256(out);
}

async function signAction(creds: HlCreds, action: unknown, nonce: number) {
  const account = privateKeyToAccount(creds.agentPrivateKey);
  const connectionId = actionHash(action, nonce, null);
  const signature = await account.signTypedData({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source: SIGNATURE_SOURCE, connectionId },
  });
  return { r: `0x${signature.slice(2, 66)}`, s: `0x${signature.slice(66, 130)}`, v: parseInt(signature.slice(130, 132), 16) };
}

async function post(creds: HlCreds, action: unknown) {
  const nonce = Date.now();
  const signature = await signAction(creds, action, nonce);
  const res = await fetch(EXCHANGE_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, nonce, signature, vaultAddress: null }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Hyperliquid exchange ${res.status}: ${text}`);
  const json = JSON.parse(text) as { status: string; response?: unknown };
  if (json.status !== "ok") throw new Error(`Hyperliquid rejected action: ${text}`);
  const statuses = (json.response as { data?: { statuses?: unknown[] } } | undefined)?.data?.statuses;
  const err = statuses?.find((s) => typeof s === "object" && s !== null && "error" in s);
  if (err) throw new Error(`Order error: ${JSON.stringify(err)}`);
  return json;
}

export function formatPrice(price: number, szDecimals: number): string {
  const maxDecimals = Math.max(0, 6 - szDecimals);
  let s = price.toPrecision(5); let n = Number(s); n = Number(n.toFixed(maxDecimals)); s = String(n); return s;
}
export function formatSize(size: number, szDecimals: number): string { return String(Number(size.toFixed(szDecimals))); }
export interface AssetInfo { index: number; name: string; szDecimals: number; maxLeverage: number }
export async function loadAssetIndex(): Promise<Map<string, AssetInfo>> {
  const meta = await hlInfo<{ universe: { name: string; szDecimals: number; maxLeverage: number }[] }>({ type: "meta" });
  const map = new Map<string, AssetInfo>();
  meta.universe.forEach((a, index) => map.set(a.name, { index, name: a.name, szDecimals: a.szDecimals, maxLeverage: a.maxLeverage }));
  return map;
}

export interface LiveAccount {
  accountValue: number; withdrawable: number; totalMarginUsed: number;
  positions: { coin: string; size: number; side: "long" | "short"; entryPrice: number; unrealizedPnl: number; leverage: number }[];
}

async function detectBtcShock(): Promise<"up" | "down" | null> {
  try {
    const now = Date.now();
    const candles = await hlInfo<{ t: number; c: string }[]>({
      type: "candleSnapshot",
      req: { coin: "BTC", interval: "1m", startTime: now - 3 * 60_000, endTime: now },
    });
    const completed = candles.filter(c => c.t < Math.floor(now / 60_000) * 60_000);
    if (completed.length < 2) return null;
    const prev = +completed.at(-2)!.c;
    const latest = +completed.at(-1)!.c;
    if (!(prev > 0 && latest > 0)) return null;
    const movePct = ((latest - prev) / prev) * 100;
    if (movePct <= -BTC_SHOCK_THRESHOLD_PCT) return "down";
    if (movePct >= BTC_SHOCK_THRESHOLD_PCT) return "up";
    return null;
  } catch { return null; }
}

export async function fetchLiveAccount(address: string): Promise<LiveAccount> {
  const state = await hlInfo<{
    marginSummary: { accountValue: string; totalMarginUsed: string };
    withdrawable: string;
    assetPositions: { position: { coin: string; szi: string; entryPx: string; unrealizedPnl: string; leverage: { value: number } } }[];
  }>({ type: "clearinghouseState", user: address });

  const result: LiveAccount = {
    accountValue: +state.marginSummary.accountValue,
    withdrawable: +state.withdrawable,
    totalMarginUsed: +state.marginSummary.totalMarginUsed,
    positions: (state.assetPositions ?? []).map((p) => ({
      coin: p.position.coin, size: Math.abs(+p.position.szi), side: +p.position.szi >= 0 ? "long" : "short",
      entryPrice: +p.position.entryPx, unrealizedPnl: +p.position.unrealizedPnl, leverage: p.position.leverage?.value ?? 1,
    })),
  };

  // Emergency BTC shock protection. This runs before normal strategy management.
  // A sudden BTC drop closes longs; a sudden BTC rise closes shorts. The close
  // is reduce-only, so this guard can never open an opposing position.
  const shock = await detectBtcShock();
  if (shock && result.positions.length) {
    const creds = readHlCreds();
    if (creds && creds.accountAddress.toLowerCase() === address.toLowerCase()) {
      const assets = await loadAssetIndex();
      const opposing = result.positions.filter(p => shock === "down" ? p.side === "long" : p.side === "short");
      for (const p of opposing) {
        const asset = assets.get(p.coin); if (!asset) continue;
        try {
          const mark = +(await hlInfo<Record<string, string>>({ type: "allMids" }))[p.coin] || p.entryPrice;
          const fill = await marketOrder(creds, asset, { isBuy: p.side === "short", size: p.size, markPrice: mark, reduceOnly: true, slippagePct: 1 });
          if (fill.size > 0) {
            p.size = Math.max(0, p.size - fill.size);
          }
        } catch {
          // Normal cycle reconciliation retries any unclosed remainder.
        }
      }
      if (opposing.some(p => p.size <= 0)) {
        result.positions = result.positions.filter(p => p.size > 0);
      }
    }
  }
  return result;
}

export function setLeverage(creds: HlCreds, asset: AssetInfo, leverage: number, cross = true) {
  return post(creds, { type: "updateLeverage", asset: asset.index, isCross: cross, leverage: Math.max(1, Math.floor(Math.min(leverage, asset.maxLeverage))) });
}

export interface OrderFill { size: number; avgPrice: number; oid: number | null }
export async function marketOrder(creds: HlCreds, asset: AssetInfo, opts: { isBuy: boolean; size: number; markPrice: number; reduceOnly?: boolean; slippagePct?: number }): Promise<OrderFill> {
  const slip = (opts.slippagePct ?? 0.5) / 100;
  const limit = opts.isBuy ? opts.markPrice * (1 + slip) : opts.markPrice * (1 - slip);
  const sz = formatSize(opts.size, asset.szDecimals);
  if (Number(sz) <= 0) throw new Error(`Size rounds to zero for ${asset.name}`);
  const json = await post(creds, {
    type: "order",
    orders: [{ a: asset.index, b: opts.isBuy, p: formatPrice(limit, asset.szDecimals), s: sz, r: opts.reduceOnly ?? false, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  });
  const statuses = (json.response as { data?: { statuses?: unknown[] } } | undefined)?.data?.statuses ?? [];
  const first = statuses[0] as { filled?: { totalSz: string; avgPx: string; oid: number } } | undefined;
  const filled = first?.filled;
  if (!filled) return { size: 0, avgPrice: 0, oid: null };
  return { size: Math.abs(+filled.totalSz), avgPrice: +filled.avgPx, oid: filled.oid ?? null };
}
