import { encode as msgpackEncode } from "@msgpack/msgpack";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Signed Hyperliquid exchange client.
 *
 * Uses an **API wallet (agent key)** — a key that can trade but can NOT withdraw.
 * Never put a main wallet's private key here.
 */

const INFO_URL = "https://api.hyperliquid.xyz/info";
const EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";
/** Signature "source" for mainnet L1 actions. */
const SIGNATURE_SOURCE = "a";

export interface HlCreds {
  /** The main account the agent trades for (0x…). */
  accountAddress: string;
  /** Agent / API-wallet private key (0x…). */
  agentPrivateKey: Hex;
}

export function readHlCreds(): HlCreds | null {
  const accountAddress = process.env["HYPERLIQUID_ACCOUNT_ADDRESS"];
  const agentPrivateKey = process.env["HYPERLIQUID_AGENT_PRIVATE_KEY"];
  if (!accountAddress || !agentPrivateKey) return null;
  const pk = (agentPrivateKey.startsWith("0x") ? agentPrivateKey : `0x${agentPrivateKey}`) as Hex;
  return { accountAddress: accountAddress.trim(), agentPrivateKey: pk };
}

export async function hlInfo<T>(body: unknown): Promise<T> {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid info ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** msgpack(action) ‖ vault byte ‖ nonce(8, BE) → keccak256 */
function actionHash(action: unknown, nonce: number, vaultAddress: string | null): Hex {
  const packed = msgpackEncode(action);
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce), false);

  let extra: Uint8Array;
  if (vaultAddress === null) {
    extra = new Uint8Array([0x00]);
  } else {
    const addr = vaultAddress.replace(/^0x/, "");
    const bytes = new Uint8Array(21);
    bytes[0] = 0x01;
    for (let i = 0; i < 20; i++) bytes[i + 1] = parseInt(addr.slice(i * 2, i * 2 + 2), 16);
    extra = bytes;
  }

  const out = new Uint8Array(packed.length + 8 + extra.length);
  out.set(packed, 0);
  out.set(nonceBytes, packed.length);
  out.set(extra, packed.length + 8);
  return keccak256(out);
}

async function signAction(creds: HlCreds, action: unknown, nonce: number) {
  const account = privateKeyToAccount(creds.agentPrivateKey);
  const connectionId = actionHash(action, nonce, null);
  const signature = await account.signTypedData({
    domain: {
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: { source: SIGNATURE_SOURCE, connectionId },
  });
  return {
    r: `0x${signature.slice(2, 66)}`,
    s: `0x${signature.slice(66, 130)}`,
    v: parseInt(signature.slice(130, 132), 16),
  };
}

async function post(creds: HlCreds, action: unknown) {
  const nonce = Date.now();
  const signature = await signAction(creds, action, nonce);
  const res = await fetch(EXCHANGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, nonce, signature, vaultAddress: null }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Hyperliquid exchange ${res.status}: ${text}`);
  const json = JSON.parse(text) as { status: string; response?: unknown };
  if (json.status !== "ok") throw new Error(`Hyperliquid rejected action: ${text}`);
  const statuses = (json.response as { data?: { statuses?: unknown[] } } | undefined)?.data?.statuses;
  const err = statuses?.find((s) => typeof s === "object" && s !== null && "error" in s);
  if (err) throw new Error(`Order error: ${JSON.stringify(err)}`);
  return json;
}

/** Hyperliquid wire format: ≤5 significant figures and ≤(6 − szDecimals) decimals. */
export function formatPrice(price: number, szDecimals: number): string {
  const maxDecimals = Math.max(0, 6 - szDecimals);
  let s = price.toPrecision(5);
  let n = Number(s);
  n = Number(n.toFixed(maxDecimals));
  s = String(n);
  return s;
}

export function formatSize(size: number, szDecimals: number): string {
  return String(Number(size.toFixed(szDecimals)));
}

export interface AssetInfo { index: number; name: string; szDecimals: number; maxLeverage: number }

export async function loadAssetIndex(): Promise<Map<string, AssetInfo>> {
  const meta = await hlInfo<{ universe: { name: string; szDecimals: number; maxLeverage: number }[] }>({ type: "meta" });
  const map = new Map<string, AssetInfo>();
  meta.universe.forEach((a, index) => {
    map.set(a.name, { index, name: a.name, szDecimals: a.szDecimals, maxLeverage: a.maxLeverage });
  });
  return map;
}

export interface LiveAccount {
  accountValue: number;
  withdrawable: number;
  totalMarginUsed: number;
  positions: { coin: string; size: number; side: "long" | "short"; entryPrice: number; unrealizedPnl: number; leverage: number }[];
}

export async function fetchLiveAccount(address: string): Promise<LiveAccount> {
  const state = await hlInfo<{
    marginSummary: { accountValue: string; totalMarginUsed: string };
    withdrawable: string;
    assetPositions: { position: { coin: string; szi: string; entryPx: string; unrealizedPnl: string; leverage: { value: number } } }[];
  }>({ type: "clearinghouseState", user: address });

  return {
    accountValue: +state.marginSummary.accountValue,
    withdrawable: +state.withdrawable,
    totalMarginUsed: +state.marginSummary.totalMarginUsed,
    positions: (state.assetPositions ?? []).map((p) => ({
      coin: p.position.coin,
      size: Math.abs(+p.position.szi),
      side: +p.position.szi >= 0 ? "long" : "short",
      entryPrice: +p.position.entryPx,
      unrealizedPnl: +p.position.unrealizedPnl,
      leverage: p.position.leverage?.value ?? 1,
    })),
  };
}

/** True when the agent key is actually approved to trade for the account. */
export async function checkAgentApproved(creds: HlCreds): Promise<{ ok: boolean; agentAddress: string; detail: string }> {
  const agentAddress = privateKeyToAccount(creds.agentPrivateKey).address;
  try {
    const agents = await hlInfo<{ address: string; name: string; validUntil: number }[]>({
      type: "extraAgents", user: creds.accountAddress,
    });
    const match = (agents ?? []).find((a) => a.address.toLowerCase() === agentAddress.toLowerCase());
    if (match) {
      return { ok: true, agentAddress, detail: `Approved as "${match.name || "agent"}" until ${new Date(match.validUntil).toUTCString()}` };
    }
    return { ok: false, agentAddress, detail: "Agent wallet is not approved on this account. Approve it in the Hyperliquid API page." };
  } catch (err) {
    return { ok: false, agentAddress, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function setLeverage(creds: HlCreds, asset: AssetInfo, leverage: number, cross = true) {
  await post(creds, {
    type: "updateLeverage",
    asset: asset.index,
    isCross: cross,
    leverage: Math.max(1, Math.floor(Math.min(leverage, asset.maxLeverage))),
  });
}

export interface OrderFill {
  /** Filled size in coin units (0 when the IOC order crossed nothing). */
  size: number;
  /** Volume-weighted average fill price (0 when nothing filled). */
  avgPrice: number;
  oid: number | null;
}

/**
 * Market order via aggressive IOC limit (Hyperliquid has no true market type).
 * `slippagePct` widens the limit so the order crosses the book.
 * Returns the ACTUAL fill — an IOC can fill partially or not at all.
 */
export async function marketOrder(
  creds: HlCreds,
  asset: AssetInfo,
  opts: { isBuy: boolean; size: number; markPrice: number; reduceOnly?: boolean; slippagePct?: number },
): Promise<OrderFill> {
  const slip = (opts.slippagePct ?? 0.5) / 100;
  const limit = opts.isBuy ? opts.markPrice * (1 + slip) : opts.markPrice * (1 - slip);
  const sz = formatSize(opts.size, asset.szDecimals);
  if (Number(sz) <= 0) throw new Error(`Size rounds to zero for ${asset.name}`);
  const json = await post(creds, {
    type: "order",
    orders: [{
      a: asset.index,
      b: opts.isBuy,
      p: formatPrice(limit, asset.szDecimals),
      s: sz,
      r: opts.reduceOnly ?? false,
      t: { limit: { tif: "Ioc" } },
    }],
    grouping: "na",
  });

  const statuses = (json.response as { data?: { statuses?: unknown[] } } | undefined)?.data?.statuses ?? [];
  const first = statuses[0] as { filled?: { totalSz: string; avgPx: string; oid: number } } | undefined;
  const filled = first?.filled;
  if (!filled) return { size: 0, avgPrice: 0, oid: null };
  return { size: Math.abs(+filled.totalSz), avgPrice: +filled.avgPx, oid: filled.oid ?? null };
}

export interface NativeStopResult {
  oid: number | null;
  alreadyPresent: boolean;
}

async function ensureNativeTrigger(
  creds: HlCreds,
  asset: AssetInfo,
  opts: { positionSide: "long" | "short"; size: number; triggerPrice: number },
  kind: "sl" | "tp",
): Promise<NativeStopResult> {
  if (!(opts.triggerPrice > 0) || !(opts.size > 0)) throw new Error(`${asset.name}: invalid native ${kind} parameters`);
  const triggerPx = formatPrice(opts.triggerPrice, asset.szDecimals);
  const closeIsBuy = opts.positionSide === "short";
  const expectedSide = closeIsBuy ? "B" : "A";
  const open = await hlInfo<Array<{
    coin: string; oid: number; isTrigger: boolean; reduceOnly: boolean; side: string;
    triggerPx: string; orderType: string; sz: string;
  }>>({ type: "frontendOpenOrders", user: creds.accountAddress });
  const tolerance = Math.max(opts.triggerPrice * 0.00005, 10 ** -(Math.max(0, 6 - asset.szDecimals)));
  const typePattern = kind === "sl" ? /stop/i : /take.?profit/i;
  const matching = (open ?? []).filter((o) =>
    o.coin === asset.name && o.isTrigger && o.reduceOnly && o.side === expectedSide && typePattern.test(o.orderType ?? "")
  );
  const existing = matching.find((o) => Math.abs(+o.triggerPx - opts.triggerPrice) <= tolerance);
  for (const stale of matching) {
    if (existing && stale.oid === existing.oid) continue;
    await cancelOrder(creds, asset, stale.oid);
  }
  if (existing) return { oid: existing.oid, alreadyPresent: true };

  const marketLimit = closeIsBuy ? opts.triggerPrice * 1.10 : opts.triggerPrice * 0.90;
  const sz = formatSize(opts.size, asset.szDecimals);
  if (Number(sz) <= 0) throw new Error(`Size rounds to zero for ${asset.name}`);
  const json = await post(creds, {
    type: "order",
    orders: [{
      a: asset.index, b: closeIsBuy, p: formatPrice(marketLimit, asset.szDecimals), s: sz, r: true,
      t: { trigger: { isMarket: true, triggerPx, tpsl: kind } },
    }],
    grouping: "positionTpsl",
  });
  const statuses = (json.response as { data?: { statuses?: unknown[] } } | undefined)?.data?.statuses ?? [];
  const first = statuses[0] as { resting?: { oid: number } } | undefined;
  return { oid: first?.resting?.oid ?? null, alreadyPresent: false };
}

/** Cancel one resting order by oid. */
async function cancelOrder(creds: HlCreds, asset: AssetInfo, oid: number) {
  await post(creds, { type: "cancel", cancels: [{ a: asset.index, o: oid }] });
}

/**
 * Ensure exactly one reduce-only exchange-native Stop Market exists for a live
 * position at the requested trigger. Any stale Kairos stop for the same coin and
 * close side is cancelled first, which lets strategy/settings changes safely
 * replace old too-tight safety-line stops.
 */
export async function ensureNativeStopLoss(
  creds: HlCreds,
  asset: AssetInfo,
  opts: { positionSide: "long" | "short"; size: number; triggerPrice: number },
): Promise<NativeStopResult> {
  return ensureNativeTrigger(creds, asset, opts, "sl");
}

export async function ensureNativeTakeProfit(
  creds: HlCreds,
  asset: AssetInfo,
  opts: { positionSide: "long" | "short"; size: number; triggerPrice: number },
): Promise<NativeStopResult> {
  return ensureNativeTrigger(creds, asset, opts, "tp");
}
