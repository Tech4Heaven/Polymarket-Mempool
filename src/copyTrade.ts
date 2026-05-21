import {
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type TickSize,
} from "@polymarket/clob-client-v2";
import { formatUnits } from "ethers";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { withSuppressedPolymarketClobConsole } from "./clobConsoleSuppress.js";
import type { CopyTradeConfig } from "./env.js";
import type { Ctf1155TransferRow } from "./ctf1155Inbound.js";
import { appendCopyTradeSuccessLine } from "./copyTradeSuccessLog.js";
import { fetchPolymarketMarketLabels } from "./gammaEventName.js";

function aggregateOutcomeByTokenId(rows: Ctf1155TransferRow[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const r of rows) {
    m.set(r.tokenId, (m.get(r.tokenId) ?? 0n) + r.rawAmount);
  }
  return m;
}

/** On-chain implied price for one leg (0–1). */
function impliedPrice(pusd6: bigint, outcome6: bigint): number {
  if (outcome6 === 0n) {
    return 0;
  }
  return Number(pusd6) / Number(outcome6);
}

export type CopyDigest = {
  side: "buy" | "sell";
  tokenId: string;
  outcomeRaw: bigint;
  /** Full pUSD `sent` (buy) or `received` (sell) from the receipt for the target; only used when a single outcome tokenId is present. */
  pusdRaw: bigint;
};

/**
 * Builds at most one digest: full pUSD flow + aggregated outcome for that token, only when inbound/outbound
 * logs reference exactly **one** distinct `tokenId`. Otherwise returns [] (no copy).
 */
export function buildCopyDigests(
  received: bigint,
  sent: bigint,
  inbound: Ctf1155TransferRow[],
  outbound: Ctf1155TransferRow[]
): CopyDigest[] {
  if (sent > 0n && inbound.length > 0) {
    const byToken = aggregateOutcomeByTokenId(inbound);
    if (byToken.size !== 1) {
      return [];
    }
    const tokenId = [...byToken.keys()][0]!;
    const amount = byToken.get(tokenId)!;
    if (amount === 0n) {
      return [];
    }
    return [{ side: "buy", tokenId, outcomeRaw: amount, pusdRaw: sent }];
  }
  if (received > 0n && outbound.length > 0) {
    const byToken = aggregateOutcomeByTokenId(outbound);
    if (byToken.size !== 1) {
      return [];
    }
    const tokenId = [...byToken.keys()][0]!;
    const amount = byToken.get(tokenId)!;
    if (amount === 0n) {
      return [];
    }
    return [{ side: "sell", tokenId, outcomeRaw: amount, pusdRaw: received }];
  }
  return [];
}

function bestAsk(book: { asks: { price: string }[] }): number | null {
  if (!book.asks.length) {
    return null;
  }
  let min = Infinity;
  for (const a of book.asks) {
    const p = parseFloat(a.price);
    if (!Number.isNaN(p)) {
      min = Math.min(min, p);
    }
  }
  return min === Infinity ? null : min;
}

function bestBid(book: { bids: { price: string }[] }): number | null {
  if (!book.bids.length) {
    return null;
  }
  let max = -Infinity;
  for (const b of book.bids) {
    const p = parseFloat(b.price);
    if (!Number.isNaN(p)) {
      max = Math.max(max, p);
    }
  }
  return max === -Infinity ? null : max;
}

function roundToTick(price: number, tick: TickSize, mode: "up" | "down"): number {
  const t = parseFloat(tick);
  if (mode === "up") {
    return Math.min(1, Math.ceil(price / t - 1e-12) * t);
  }
  return Math.max(0, Math.floor(price / t + 1e-12) * t);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** On-chain amounts from the copied wallet trade (USDC + outcome tokens, 6 decimals each). */
function formatOriginTradeSizing(digest: CopyDigest): string {
  const pUSD = parseFloat(formatUnits(digest.pusdRaw, 6)).toFixed(6);
  const shares = parseFloat(formatUnits(digest.outcomeRaw, 6)).toFixed(6);
  return `origin pUSD=${pUSD} shares=${shares}`;
}

async function logCopySkip(
  reasonDetail: string,
  digest: CopyDigest,
  txHash: string,
  cfg: CopyTradeConfig
): Promise<void> {
  const { event, outcome } = await fetchPolymarketMarketLabels(digest.tokenId);
  const msg = `copy skip · ${reasonDetail} · event=${JSON.stringify(event)} outcome=${JSON.stringify(outcome)} · tx=${txHash}`;
  console.log(msg);
  void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
}

/** Parse CLOB midpoint / price API payloads to a number in (0,1). */
function parseClobPrice(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const k of ["mid", "price", "p"]) {
      if (k in o && o[k] != null) {
        const n = parseFloat(String(o[k]));
        if (Number.isFinite(n) && n > 0) {
          return n;
        }
      }
    }
  }
  return null;
}

let cachedClient: ClobClient | null = null;
let cachedCfgKey = "";
let authInFlight: Promise<ClobClient> | null = null;

const MAX_AUTH_RETRIES = 5;

function buildSigner(cfg: CopyTradeConfig) {
  const account = privateKeyToAccount(cfg.privateKey);
  return createWalletClient({
    account,
    chain: polygon,
    transport: http(cfg.polygonHttpUrl),
  });
}

/**
 * L1 wallet → `createOrDeriveApiKey()` → fully authenticated CLOB client (same pattern as wallet-only bots).
 * Retries with backoff on transient failures.
 */
export async function ensureClobClient(cfg: CopyTradeConfig): Promise<ClobClient> {
  const key = `${cfg.privateKey}-${cfg.clobHost}`;
  if (cachedClient && cachedCfgKey === key) {
    return cachedClient;
  }
  if (!authInFlight) {
    authInFlight = (async () => {
      const signer = buildSigner(cfg);
      let lastErr: unknown;
      for (let attempt = 1; attempt <= MAX_AUTH_RETRIES; attempt++) {
        try {
          const l1 = new ClobClient({
            host: cfg.clobHost,
            chain: Chain.POLYGON,
            signer,
            signatureType: cfg.signatureType as SignatureTypeV2,
            funderAddress: cfg.funderAddress,
          });
          const creds = await withSuppressedPolymarketClobConsole(() =>
            l1.createOrDeriveApiKey()
          );
          const client = new ClobClient({
            host: cfg.clobHost,
            chain: Chain.POLYGON,
            signer,
            creds,
            signatureType: cfg.signatureType as SignatureTypeV2,
            funderAddress: cfg.funderAddress,
          });
          cachedCfgKey = key;
          cachedClient = client;
          return client;
        } catch (e) {
          lastErr = e;
          if (attempt < MAX_AUTH_RETRIES) {
            console.error(
              `CLOB createOrDeriveApiKey attempt ${attempt}/${MAX_AUTH_RETRIES} failed, retrying…`,
              e
            );
            await new Promise((r) => setTimeout(r, 5000 * attempt));
          }
        }
      }
      throw lastErr ?? new Error("CLOB L2 auth failed");
    })().finally(() => {
      authInFlight = null;
    });
  }
  return authInFlight;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hedge module — per-target `hedge_price` strategy
// ─────────────────────────────────────────────────────────────────────────────

type HedgeRest = {
  orderId: string;
  tokenId: string;
  price: number;
  size: number;
};

type MarketHedgeState = {
  conditionId: string;
  tokenA: string;
  tokenB: string;
  /** Shares we hold per tokenId (in this condition). Updated on each copy buy AND on detected hedge fills. */
  sharesByToken: Map<string, number>;
  /** Currently-resting hedge order (or null if no resting hedge). */
  hedge: HedgeRest | null;
};

/** Keyed by conditionId. Resets on process restart (5m markets resolve before restart gaps matter). */
const hedgeStateByCondition = new Map<string, MarketHedgeState>();

/** tokenId → { conditionId, [tokenId, oppositeTokenId] }. Cached after first gamma lookup. */
const marketTokensCache = new Map<string, { conditionId: string; clobTokenIds: [string, string] }>();

/**
 * Resolves the conditionId and both outcome tokenIds for a given tokenId via Polymarket's gamma API.
 * Cached aggressively because the relationship is immutable per market.
 */
async function resolveMarketTokens(
  tokenId: string
): Promise<{ conditionId: string; clobTokenIds: [string, string] } | null> {
  const cached = marketTokensCache.get(tokenId);
  if (cached) {
    return cached;
  }
  try {
    const url = new URL("https://gamma-api.polymarket.com/markets");
    url.searchParams.set("clob_token_ids", tokenId);
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    const arr = (await res.json()) as unknown;
    if (!Array.isArray(arr) || arr.length === 0) {
      return null;
    }
    const m = arr[0] as Record<string, unknown>;
    const conditionId = typeof m["conditionId"] === "string" ? (m["conditionId"] as string) : null;
    const tokensRaw = m["clobTokenIds"];
    let tokens: string[] = [];
    if (Array.isArray(tokensRaw)) {
      tokens = tokensRaw.map(String);
    } else if (typeof tokensRaw === "string") {
      try {
        tokens = JSON.parse(tokensRaw).map(String);
      } catch {
        tokens = [];
      }
    }
    if (!conditionId || tokens.length !== 2) {
      return null;
    }
    const entry = { conditionId, clobTokenIds: [tokens[0]!, tokens[1]!] as [string, string] };
    // Cache against BOTH tokens so either side hits the same entry next time.
    marketTokensCache.set(tokens[0]!, entry);
    marketTokensCache.set(tokens[1]!, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * Returns the opposite tokenId for a binary market. null if metadata can't be resolved.
 */
async function getOppositeTokenId(tokenId: string): Promise<{ conditionId: string; oppositeTokenId: string } | null> {
  const info = await resolveMarketTokens(tokenId);
  if (!info) {
    return null;
  }
  const [a, b] = info.clobTokenIds;
  const opposite = a === tokenId ? b : a;
  if (opposite === tokenId) {
    return null;
  }
  return { conditionId: info.conditionId, oppositeTokenId: opposite };
}

/**
 * Returns the matched portion of an order. The "treat partial fills as fully done" policy
 * means we use this number to decide whether the hedge effectively "filled" — even one share
 * matched counts. Returns null if the order can't be read.
 */
async function readHedgeMatched(client: ClobClient, orderId: string): Promise<number | null> {
  if (orderId === "DRY_RUN") {
    return 0;
  }
  try {
    const o = await client.getOrder(orderId);
    const matched = parseFloat(o.size_matched ?? "0");
    return Number.isFinite(matched) ? matched : 0;
  } catch {
    return null;
  }
}

async function safeCancel(client: ClobClient, orderId: string, cfg: CopyTradeConfig, ctx: string): Promise<void> {
  if (orderId === "DRY_RUN") {
    return;
  }
  try {
    await client.cancelOrder({ orderID: orderId });
  } catch (e) {
    const warn = `hedge · cancel ${orderId} failed (${ctx}): ${e instanceof Error ? e.message : String(e)}`;
    console.warn(warn);
    void appendCopyTradeSuccessLine(warn, cfg.copyTradeLogPath);
  }
}

/**
 * Compute the ideal hedge for current holdings: GTC BUY on the smaller side at hedge_price,
 * sized to the net imbalance. Returns null if the position is balanced (no hedge needed).
 */
function computeIdealHedge(state: MarketHedgeState, hedgePrice: number): HedgeRest | null {
  const sharesA = state.sharesByToken.get(state.tokenA) ?? 0;
  const sharesB = state.sharesByToken.get(state.tokenB) ?? 0;
  const imbalance = Math.abs(sharesA - sharesB);
  if (imbalance <= 0) {
    return null;
  }
  const shortTokenId = sharesA > sharesB ? state.tokenB : state.tokenA;
  return {
    orderId: "",
    tokenId: shortTokenId,
    price: hedgePrice,
    size: imbalance,
  };
}

/**
 * Cancel + replace the resting hedge so it always matches the ideal (size = net imbalance,
 * side = the smaller of our two holdings). Invariant: at most one resting hedge per condition.
 * Skips network calls in dry-run mode but still updates state so suppression logic works.
 */
async function reconcileHedge(
  cfg: CopyTradeConfig,
  client: ClobClient,
  state: MarketHedgeState,
  txHash: string
): Promise<void> {
  if (cfg.hedgePrice === undefined) {
    return;
  }
  const ideal = computeIdealHedge(state, cfg.hedgePrice);

  // If current hedge already matches ideal, nothing to do (avoids needless cancel/replace churn).
  if (
    state.hedge &&
    ideal &&
    state.hedge.tokenId === ideal.tokenId &&
    Math.abs(state.hedge.size - ideal.size) < 1e-9 &&
    state.hedge.price === ideal.price
  ) {
    return;
  }

  // Cancel current hedge if any.
  if (state.hedge) {
    const old = state.hedge;
    await safeCancel(client, old.orderId, cfg, `reconcile condition=${state.conditionId}`);
    state.hedge = null;
    const msg = `hedge cancelled · condition=${state.conditionId} oldToken=${old.tokenId} oldSize=${old.size} oldPrice=${old.price} · tx=${txHash}`;
    console.log(msg);
    void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
  }

  if (!ideal) {
    const msg = `hedge none-needed · condition=${state.conditionId} sharesByToken=${JSON.stringify(Object.fromEntries(state.sharesByToken))} · tx=${txHash}`;
    console.log(msg);
    void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
    return;
  }

  if (cfg.dryRun) {
    const msg = `[DRY RUN] would place hedge · condition=${state.conditionId} hedgeToken=${ideal.tokenId} price=${ideal.price} shares=${ideal.size} · tx=${txHash}`;
    console.log(msg);
    void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
    state.hedge = { ...ideal, orderId: "DRY_RUN" };
    return;
  }

  // Place new hedge.
  try {
    const [tickSize, negRisk] = await Promise.all([
      client.getTickSize(ideal.tokenId),
      client.getNegRisk(ideal.tokenId),
    ]);
    const resp = await client.createAndPostOrder(
      {
        tokenID: ideal.tokenId,
        price: ideal.price,
        side: Side.BUY,
        size: ideal.size,
      },
      { tickSize, negRisk },
      OrderType.GTC
    );
    const orderId = (resp as { orderID?: string })?.orderID ?? null;
    if (orderId) {
      state.hedge = { ...ideal, orderId };
    }
    const msg = `hedge placed · condition=${state.conditionId} hedgeToken=${ideal.tokenId} price=${ideal.price} shares=${ideal.size} · tx=${txHash} · ${JSON.stringify(resp)}`;
    console.log(msg);
    void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
  } catch (e) {
    const errMsg = `hedge · post failed: ${e instanceof Error ? e.message : String(e)} · condition=${state.conditionId} hedgeToken=${ideal.tokenId} · tx=${txHash}`;
    console.error(errMsg);
    void appendCopyTradeSuccessLine(errMsg, cfg.copyTradeLogPath);
  }
}

/**
 * Record a successful BUY copy in state (additive to sharesByToken) and reconcile the hedge.
 * Idempotent w.r.t. existing state if same condition was already seen — accumulates shares correctly.
 */
async function recordCopyBuyAndReconcile(
  cfg: CopyTradeConfig,
  client: ClobClient,
  primaryTokenId: string,
  sharesAdded: number,
  txHash: string
): Promise<void> {
  if (cfg.hedgePrice === undefined) {
    return;
  }
  const opp = await getOppositeTokenId(primaryTokenId);
  if (!opp) {
    const warn = `hedge · could not resolve opposite token for tokenId=${primaryTokenId} · tx=${txHash}`;
    console.warn(warn);
    void appendCopyTradeSuccessLine(warn, cfg.copyTradeLogPath);
    return;
  }

  let state = hedgeStateByCondition.get(opp.conditionId);
  if (!state) {
    state = {
      conditionId: opp.conditionId,
      tokenA: primaryTokenId,
      tokenB: opp.oppositeTokenId,
      sharesByToken: new Map(),
      hedge: null,
    };
    hedgeStateByCondition.set(opp.conditionId, state);
  }
  const current = state.sharesByToken.get(primaryTokenId) ?? 0;
  state.sharesByToken.set(primaryTokenId, current + sharesAdded);

  await reconcileHedge(cfg, client, state, txHash);
}

/**
 * Option-2 suppression: only suppress if our hedge actually filled. If the hedge is resting
 * unfilled, cancel it (to prevent double-hedge later when the cheap price might fill behind us)
 * and don't suppress — let the bot copy the target's opposite-side buy at fair price instead.
 *
 * Per user preference, a partial fill counts as "fully done" — the matched portion is rolled into
 * sharesByToken and the unfilled remainder is cancelled.
 */
async function checkHedgeSuppression(
  cfg: CopyTradeConfig,
  client: ClobClient,
  digest: CopyDigest,
  txHash: string
): Promise<{ suppress: boolean; reason?: string }> {
  if (digest.side !== "buy") {
    return { suppress: false };
  }
  const info = await resolveMarketTokens(digest.tokenId);
  if (!info) {
    return { suppress: false };
  }
  const state = hedgeStateByCondition.get(info.conditionId);
  if (!state || !state.hedge) {
    return { suppress: false };
  }
  if (state.hedge.tokenId !== digest.tokenId) {
    // Hedge is for some other side — not applicable.
    return { suppress: false };
  }

  const hedge = state.hedge;

  // Dry-run hedge orders never "fill" because they never exist on CLOB. Treat as resting.
  if (hedge.orderId === "DRY_RUN") {
    state.hedge = null; // discard so we don't keep "cancelling" forever
    const msg = `[DRY RUN] discarding pretend-hedge for condition=${state.conditionId} hedgeToken=${hedge.tokenId} (target buying that side) · tx=${txHash}`;
    console.log(msg);
    void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
    return { suppress: false };
  }

  const matched = await readHedgeMatched(client, hedge.orderId);
  if (matched !== null && matched > 0) {
    // Treat as fully done: roll matched portion into held shares, cancel the unmatched remainder.
    await safeCancel(client, hedge.orderId, cfg, "matched-but-cleanup-remainder");
    const existing = state.sharesByToken.get(hedge.tokenId) ?? 0;
    state.sharesByToken.set(hedge.tokenId, existing + matched);
    state.hedge = null;
    return {
      suppress: true,
      reason: `hedge filled (${matched} of ${hedge.size} shares matched at $${hedge.price})`,
    };
  }

  // Not filled — cancel resting hedge to prevent later behind-our-back fill that would double-hedge.
  await safeCancel(client, hedge.orderId, cfg, "diverting-to-copy-target-opposite");
  const msg = `hedge cancelled (diverting to copy target's opposite-side buy) · condition=${state.conditionId} hedgeToken=${hedge.tokenId} price=${hedge.price} shares=${hedge.size} · tx=${txHash}`;
  console.log(msg);
  void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
  state.hedge = null;
  return { suppress: false };
}

/**
 * Startup-time cleanup: cancel any pre-existing GTC orders for this wallet. Prevents orphan
 * hedges from a prior process from filling behind the bot's (now-empty) in-memory state.
 *
 * Caveat: if other systems share this wallet, their GTC orders will also be cancelled. The user
 * was warned and opted in.
 */
export async function cancelAllStaleGtcOrders(cfg: CopyTradeConfig): Promise<void> {
  try {
    const client = await ensureClobClient(cfg);
    const orders = await client.getOpenOrders();
    if (!Array.isArray(orders) || orders.length === 0) {
      console.log("startup: no pre-existing open orders to clean up");
      return;
    }
    console.log(`startup: cancelling ${orders.length} pre-existing open order(s)`);
    for (const o of orders) {
      const id = (o as { id?: string }).id;
      if (!id) {
        continue;
      }
      try {
        await client.cancelOrder({ orderID: id });
      } catch (e) {
        console.warn(`startup: cancel ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    console.log("startup: cleanup done");
  } catch (e) {
    console.warn(`startup: failed to list open orders: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Sizes with **shares = (pUSD_notional × COPY_RATIO, clipped) / currentPrice**, where `currentPrice` comes from
 * the CLOB (`getMidpoint`, then `getPrice` fallback). Posts a marketable GTC limit at/through the book.
 */
export async function executeCopyTrade(cfg: CopyTradeConfig, digest: CopyDigest, txHash: string): Promise<void> {
  const implied = impliedPrice(digest.pusdRaw, digest.outcomeRaw);
  const originPusd = parseFloat(formatUnits(digest.pusdRaw, 6));
  if (!Number.isFinite(implied) || implied <= 0) {
    await logCopySkip(`bad implied on-chain price · token=${digest.tokenId}`, digest, txHash, cfg);
    return;
  }

  const client = await ensureClobClient(cfg);

  // Option-2 suppression: only suppress if our hedge actually filled. If hedge is unfilled,
  // cancel it (to prevent double-hedge later) and continue copying the target's opposite-side buy.
  if (cfg.hedgePrice !== undefined) {
    const sup = await checkHedgeSuppression(cfg, client, digest, txHash);
    if (sup.suppress) {
      await logCopySkip(`already hedged · ${sup.reason ?? ""} · token=${digest.tokenId}`, digest, txHash, cfg);
      return;
    }
  }

  const [tickSize, negRisk, book, midRaw] = await Promise.all([
    client.getTickSize(digest.tokenId),
    client.getNegRisk(digest.tokenId),
    client.getOrderBook(digest.tokenId),
    client.getMidpoint(digest.tokenId),
  ]);

  let currentPrice = parseClobPrice(midRaw);
  if (currentPrice === null) {
    const sideStr = digest.side === "buy" ? Side.BUY : Side.SELL;
    const pxRaw = await client.getPrice(digest.tokenId, sideStr);
    currentPrice = parseClobPrice(pxRaw);
  }
  if (currentPrice === null) {
    await logCopySkip(`could not parse CLOB price · token=${digest.tokenId}`, digest, txHash, cfg);
    return;
  }

  if (digest.side === "buy") {
    const drift = currentPrice - implied;
    if (drift > cfg.maxPriceDifference) {
      await logCopySkip(
        `price drift buy · implied(on-chain)=${implied.toFixed(4)} clob=${currentPrice.toFixed(4)} drift=${drift.toFixed(4)} maxΔ=${cfg.maxPriceDifference} · ${formatOriginTradeSizing(digest)}`,
        digest,
        txHash,
        cfg
      );
      return;
    }
  }

  let clippedUsdc: number | null = null;
  if (digest.side === "buy") {
    const usdcNotional = originPusd * cfg.copyRatio;
    if (usdcNotional < cfg.minPositionUsdc) {
      await logCopySkip(
        `pUSD ${usdcNotional.toFixed(6)} < MIN_POSITION_USDC ${cfg.minPositionUsdc}`,
        digest,
        txHash,
        cfg
      );
      return;
    }
    clippedUsdc = clamp(usdcNotional, cfg.minPositionUsdc, cfg.maxPositionUsdc);
  }

  let limitPrice: number;
  if (digest.side === "buy") {
    const ask = bestAsk(book);
    if (ask === null) {
      await logCopySkip("empty asks", digest, txHash, cfg);
      return;
    }
    limitPrice = roundToTick(Math.max(currentPrice, ask), tickSize, "up");

    if (cfg.buyPriceMin !== undefined && limitPrice < cfg.buyPriceMin) {
      await logCopySkip(
        `buy limitPrice=${limitPrice.toFixed(4)} below buy_price_min=${cfg.buyPriceMin} · ${formatOriginTradeSizing(digest)}`,
        digest,
        txHash,
        cfg
      );
      return;
    }
    if (cfg.buyPriceMax !== undefined && limitPrice > cfg.buyPriceMax) {
      await logCopySkip(
        `buy limitPrice=${limitPrice.toFixed(4)} above buy_price_max=${cfg.buyPriceMax} · ${formatOriginTradeSizing(digest)}`,
        digest,
        txHash,
        cfg
      );
      return;
    }
  } else {
    const bid = bestBid(book);
    if (bid === null) {
      await logCopySkip("empty bids", digest, txHash, cfg);
      return;
    }
    limitPrice = roundToTick(Math.min(currentPrice, bid), tickSize, "down");
  }

  // Buy: size from clipped notional. Sell: immediately liquidate full token balance.
  let orderShares: number;
  if (digest.side === "buy") {
    orderShares = (clippedUsdc ?? 0) / limitPrice;
  } else {
    const bal = await client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: digest.tokenId,
    });
    /** CLOB returns conditional balance in raw 6-decimal units; `createAndPostOrder` size is decimal shares (same scale as buys). */
    let fullBalance: number;
    try {
      fullBalance = parseFloat(formatUnits(BigInt(String(bal.balance)), 6));
    } catch {
      await logCopySkip(`invalid balance response · token=${digest.tokenId}`, digest, txHash, cfg);
      return;
    }
    if (!Number.isFinite(fullBalance) || fullBalance <= 0) {
      await logCopySkip(
        `no balance to sell · token=${digest.tokenId} · limit=${limitPrice} implied=${implied.toFixed(4)} clob=${currentPrice.toFixed(4)}`,
        digest,
        txHash,
        cfg
      );
      return;
    }
    orderShares = fullBalance;
  }

  const minOrder = parseFloat(book.min_order_size);
  if (!Number.isNaN(minOrder) && orderShares < minOrder) {
    await logCopySkip(`size ${orderShares} < min_order_size ${book.min_order_size}`, digest, txHash, cfg);
    return;
  }

  const side = digest.side === "buy" ? Side.BUY : Side.SELL;

  if (cfg.dryRun) {
    const { event, outcome } = await fetchPolymarketMarketLabels(digest.tokenId);
    const pUsdForLog = digest.side === "buy" ? (clippedUsdc ?? 0) : originPusd;
    const msg =
      `[DRY RUN] would post GTC · side=${digest.side} shares=${orderShares} pUSD=${pUsdForLog.toFixed(6)} · event=${JSON.stringify(event)} outcome=${JSON.stringify(outcome)} · tokenID=${digest.tokenId} limitPrice=${limitPrice} tickSize=${tickSize} negRisk=${negRisk} · implied=${implied.toFixed(4)} · tx=${txHash}`;
    console.log(msg);
    void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
    // Track the would-be position so suppression / reconcile logs reflect reality.
    if (digest.side === "buy") {
      await recordCopyBuyAndReconcile(cfg, client, digest.tokenId, orderShares, txHash);
    }
    return;
  }

  const resp = await client.createAndPostOrder(
    {
      tokenID: digest.tokenId,
      price: limitPrice,
      side,
      size: orderShares,
    },
    { tickSize, negRisk },
    OrderType.GTC
  );

  const { event, outcome } = await fetchPolymarketMarketLabels(digest.tokenId);
  const pUsdForLog = digest.side === "buy" ? (clippedUsdc ?? 0) : originPusd;
  const msg = `copy posted · ${digest.side} shares=${orderShares} pUSD=${pUsdForLog.toFixed(6)} · event=${JSON.stringify(event)} outcome=${JSON.stringify(outcome)} · limit=${limitPrice} implied=${implied.toFixed(4)} · tx=${txHash} · ${JSON.stringify(resp)}`;
  console.log(msg);
  void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);

  // After a successful live BUY, update sharesByToken and reconcile the hedge to net imbalance.
  if (digest.side === "buy") {
    await recordCopyBuyAndReconcile(cfg, client, digest.tokenId, orderShares, txHash);
  }
}
