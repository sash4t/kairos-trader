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

type HlUserFill = {
  coin: string;
  startPosition: string;
  dir: string;
  time: number;
  fee: string;
  feeToken?: string;
};

type HlFunding = {
  time: number;
  delta?: { type?: string; coin?: string; usdc?: string };
};

function positionLifecycleStart(fills: HlUserFill[], coin: string, side: "long" | "short"): number | null {
  const wanted = side === "long" ? /open long/i : /open short/i;
  const candidates = fills
    .filter((f) => f.coin === coin && Math.abs(+f.startPosition) < 1e-12 && wanted.test(f.dir ?? ""))
    .sort((a, b) => b.time - a.time);
  return candidates[0]?.time ?? null;
}

export interface LiveAccount {
  accountValue: number;
  withdrawable: number;
  totalMarginUsed: number;
  positions: {
    coin: string;
    size: number;
    side: "long" | "short";
    entryPrice: number;
    /** Net unrealized PnL after actual Hyperliquid fees and funding for the current position lifecycle. */
    unrealizedPnl: number;
    grossUnrealizedPnl: number;
    feesPaid: number;
    fundingPnl: number;
    leverage: number;
  }[];
}

export async function fetchLiveAccount(address: string): Promise<LiveAccount> {
  const [state, fills] = await Promise.all([
    hlInfo<{
      marginSummary: { accountValue: string; totalMarginUsed: string };
      withdrawable: string;
      assetPositions: { position: { coin: string; szi: string; entryPx: string; unrealizedPnl: string; leverage: { value: number } } }[];
    }>({ type: "clearinghouseState", user: address }),
    hlInfo<HlUserFill[]>({ type: "userFills", user: address, aggregateByTime: true }).catch(() => []),
  ]);

  const rawPositions = (state.assetPositions ?? []).map((p) => ({
    coin: p.position.coin,
    size: Math.abs(+p.position.szi),
    side: (+p.position.szi >= 0 ? "long" : "short") as "long" | "short",
    entryPrice: +p.position.entryPx,
    grossUnrealizedPnl: +p.position.unrealizedPnl,
    leverage: p.position.leverage?.value ?? 1,
  }));

  const starts = new Map<string, number>();
  for (const p of rawPositions) {
    const start = positionLifecycleStart(fills, p.coin, p.side);
    if (start != null) starts.set(`${p.coin}:${p.side}`, start);
  }
  const earliestStart = starts.size ? Math.min(...starts.values()) : null;
  const funding = earliestStart == null
    ? []
    : await hlInfo<HlFunding[]>({ type: "userFunding", user: address, startTime: earliestStart }).catch(() => []);

  const positions = rawPositions.map((p) => {
    const start = starts.get(`${p.coin}:${p.side}`);
    const feesPaid = start == null ? 0 : fills.reduce((sum, f) => {
      if (f.coin !== p.coin || f.time < start) return sum;
      if (f.feeToken && f.feeToken !== "USDC") return sum;
      const fee = +f.fee;
      return sum + (Number.isFinite(fee) ? fee : 0);
    }, 0);
    const fundingPnl = start == null ? 0 : funding.reduce((sum, f) => {
      if (f.time < start || f.delta?.coin !== p.coin) return sum;
      const usdc = +(f.delta?.usdc ?? 0);
      return sum + (Number.isFinite(usdc) ? usdc : 0);
    }, 0);
    return {
      ...p,
      feesPaid,
      fundingPnl,
      unrealizedPnl: p.grossUnrealizedPnl - feesPaid + fundingPnl,
    };
  });

  return {
    accountValue: +state.marginSummary.accountValue,
    withdrawable: +state.withdrawable,
    totalMarginUsed: +state.marginSummary.totalMarginUsed,
    positions,
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

function isIocNoMatchError(err: unknown): boolean {
  return err instanceof Error && /could not immediately match against any resting orders/i.test(err.message);
}

async function submitIocOrder(
  creds: HlCreds,
  asset: AssetInfo,
  opts: { isBuy: boolean; size: string; limit: number; reduceOnly: boolean },
): Promise<OrderFill> {
  const json = await post(creds, {
    type: "order",
    orders: [{
      a: asset.index,
      b: opts.isBuy,
      p: formatPrice(opts.limit, asset.szDecimals),
      s: opts.size,
      r: opts.reduceOnly,
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

/**
 * Market order via aggressive IOC limit (Hyperliquid has no true market type).
 * `slippagePct` widens the limit so the order crosses the book.
 *
 * A stale explicit `limitPrice` can stop crossing the spread and Hyperliquid then
 * returns "Order could not immediately match against any resting orders". For
 * opening orders we treat that as a transient no-fill and retry once from a fresh
 * midpoint, still bounded by `slippagePct` so the retry cannot chase indefinitely.
 */
export async function marketOrder(
  creds: HlCreds,
  asset: AssetInfo,
  opts: { isBuy: boolean; size: number; markPrice: number; reduceOnly?: boolean; slippagePct?: number; limitPrice?: number },
): Promise<OrderFill> {
  const slip = (opts.slippagePct ?? 0.5) / 100;
  const initialLimit = opts.limitPrice ?? (opts.isBuy ? opts.markPrice * (1 + slip) : opts.markPrice * (1 - slip));
  if (!(initialLimit > 0) || !Number.isFinite(initialLimit)) throw new Error(`Invalid IOC limit for ${asset.name}`);
  const sz = formatSize(opts.size, asset.szDecimals);
  if (Number(sz) <= 0) throw new Error(`Size rounds to zero for ${asset.name}`);
  const reduceOnly = opts.reduceOnly ?? false;

  try {
    return await submitIocOrder(creds, asset, { isBuy: opts.isBuy, size: sz, limit: initialLimit, reduceOnly });
  } catch (err) {
    if (reduceOnly || opts.limitPrice == null || !isIocNoMatchError(err)) throw err;

    const mids = await hlInfo<Record<string, string>>({ type: "allMids" });
    const freshMark = Number(mids[asset.name]);
    if (!(freshMark > 0) || !Number.isFinite(freshMark)) throw err;
    const retryLimit = opts.isBuy ? freshMark * (1 + slip) : freshMark * (1 - slip);
    return await submitIocOrder(creds, asset, { isBuy: opts.isBuy, size: sz, limit: retryLimit, reduceOnly });
  }
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
  const sizeTolerance = Math.max(10 ** -(asset.szDecimals + 1), opts.size * 0.0001);
  const existing = matching.find((o) =>
    Math.abs(+o.triggerPx - opts.triggerPrice) <= tolerance &&
    Math.abs(Math.abs(+o.sz) - opts.size) <= sizeTolerance
  );
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
