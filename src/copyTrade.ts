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

/**
 * tickSize and negRisk are immutable per market — cache them so we save 2 CLOB round-trips
 * on every copy after the first one in a given market. Keyed by tokenId.
 */
const tickSizeByToken = new Map<string, TickSize>();
const negRiskByToken = new Map<string, boolean>();

async function getTickSizeCached(client: ClobClient, tokenId: string): Promise<TickSize> {
  const cached = tickSizeByToken.get(tokenId);
  if (cached !== undefined) {
    return cached;
  }
  const fresh = await client.getTickSize(tokenId);
  tickSizeByToken.set(tokenId, fresh);
  return fresh;
}

async function getNegRiskCached(client: ClobClient, tokenId: string): Promise<boolean> {
  const cached = negRiskByToken.get(tokenId);
  if (cached !== undefined) {
    return cached;
  }
  const fresh = await client.getNegRisk(tokenId);
  negRiskByToken.set(tokenId, fresh);
  return fresh;
}

/**
 * Per-target per-side spend tracker for `max_market_usdc`. Key = `${targetAddrLc}:${tokenId}`.
 * Each tokenId is unique per market+side, so per-side semantics fall out naturally.
 *
 * Buys ADD to the bucket; full sells RESET it (current code exits positions completely on sell).
 * Entries expire after SIDE_SPEND_TTL_MS of no activity so 5-minute markets don't accumulate
 * stale entries forever — sweep runs every 5 minutes.
 */
type SideSpendEntry = { spent: number; lastUpdated: number };
const sideSpendByTargetToken = new Map<string, SideSpendEntry>();
const SIDE_SPEND_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of sideSpendByTargetToken) {
    if (now - e.lastUpdated > SIDE_SPEND_TTL_MS) {
      sideSpendByTargetToken.delete(k);
    }
  }
}, 5 * 60 * 1000).unref();

function sideSpendKey(targetAddress: string, tokenId: string): string {
  return `${targetAddress.toLowerCase()}:${tokenId}`;
}

function getSideSpent(targetAddress: string, tokenId: string): number {
  const e = sideSpendByTargetToken.get(sideSpendKey(targetAddress, tokenId));
  if (!e) {
    return 0;
  }
  if (Date.now() - e.lastUpdated > SIDE_SPEND_TTL_MS) {
    sideSpendByTargetToken.delete(sideSpendKey(targetAddress, tokenId));
    return 0;
  }
  return e.spent;
}

/**
 * Adds (positive) or refunds (negative) USDC to a side's spend bucket. Refunds clamp at 0
 * to avoid going negative when our internal accounting drifts from reality (e.g., a cancel
 * races with a fill and we slightly over-refund).
 */
function addSideSpent(targetAddress: string, tokenId: string, usdcDelta: number): void {
  const k = sideSpendKey(targetAddress, tokenId);
  const e = sideSpendByTargetToken.get(k);
  const newSpent = Math.max(0, (e?.spent ?? 0) + usdcDelta);
  sideSpendByTargetToken.set(k, {
    spent: newSpent,
    lastUpdated: Date.now(),
  });
}

function resetSideSpent(targetAddress: string, tokenId: string): void {
  sideSpendByTargetToken.delete(sideSpendKey(targetAddress, tokenId));
}

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
  /** Best estimate of shares we hold per tokenId. Fed by copy fills (takingAmount) and the balance poller. */
  sharesByToken: Map<string, number>;
  /** Currently-resting hedge order (or null if no resting hedge). */
  hedge: HedgeRest | null;
  /** cfg of the most recent target to trade this condition — used by the poller for hedge_price/cap. */
  cfg: CopyTradeConfig;
  /** ms of last activity (copy or poll-detected change) — for TTL eviction from the poll set. */
  lastActivityMs: number;
  /** Per-condition async mutex (chained promise) so copy- and poll-triggered reconciles serialize. */
  reconcileChain: Promise<void>;
};

/** Keyed by conditionId. Resets on process restart (5m markets resolve before restart gaps matter). */
const hedgeStateByCondition = new Map<string, MarketHedgeState>();

const HEDGE_POLL_INTERVAL_MS = 8_000;
const HEDGE_STATE_TTL_MS = 15 * 60_000;

/** Reads the wallet's actual conditional-token balance (filled shares) for a tokenId. */
async function readConditionalBalance(client: ClobClient, tokenId: string): Promise<number> {
  const bal = await client.getBalanceAllowance({
    asset_type: AssetType.CONDITIONAL,
    token_id: tokenId,
  });
  try {
    const v = parseFloat(formatUnits(BigInt(String(bal.balance)), 6));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/**
 * Serializes reconciles for a condition so a copy-triggered and a poll-triggered reconcile can
 * never run concurrently and place duplicate hedges. Chains onto the state's reconcileChain.
 */
function runExclusive(state: MarketHedgeState, fn: () => Promise<void>): Promise<void> {
  const next = state.reconcileChain.then(fn, fn);
  // Swallow errors on the chain so one failure doesn't poison subsequent reconciles.
  state.reconcileChain = next.catch(() => undefined);
  return next;
}

/**
 * Background poller (Part 2-B): every HEDGE_POLL_INTERVAL_MS, walk active LIVE conditions, read
 * real balances, merge into the share estimate, and reconcile. Catches late fills of resting copy
 * orders (and hedge fills) that copy events alone would miss. Dry-run conditions are skipped — they
 * have no real orders, so balance polling would wrongly zero their simulated holdings.
 */
setInterval(() => {
  const now = Date.now();
  for (const [condId, state] of hedgeStateByCondition) {
    if (now - state.lastActivityMs > HEDGE_STATE_TTL_MS) {
      hedgeStateByCondition.delete(condId);
      continue;
    }
    if (state.cfg.dryRun || state.cfg.hedgePrice === undefined) {
      continue;
    }
    void runExclusive(state, async () => {
      const client = await ensureClobClient(state.cfg);
      const balA = await readConditionalBalance(client, state.tokenA);
      const balB = await readConditionalBalance(client, state.tokenB);
      // max-merge: balance only grows vs estimate as resting orders settle. Settlement lag can
      // make balance momentarily LOWER than a just-recorded fill — max() prevents falsely zeroing it.
      const prevA = state.sharesByToken.get(state.tokenA) ?? 0;
      const prevB = state.sharesByToken.get(state.tokenB) ?? 0;
      const newA = Math.max(prevA, balA);
      const newB = Math.max(prevB, balB);
      if (newA === prevA && newB === prevB) {
        return;
      }
      state.sharesByToken.set(state.tokenA, newA);
      state.sharesByToken.set(state.tokenB, newB);
      state.lastActivityMs = Date.now();
      const poll = `hedge poll · condition=${condId} balances A=${newA} B=${newB} (was A=${prevA} B=${prevB}) · resting copy fill detected, reconciling`;
      console.log(poll);
      void appendCopyTradeSuccessLine(poll, state.cfg.copyTradeLogPath);
      await reconcileHedge(state.cfg, client, state, "poller");
    }).catch((e) => {
      console.warn(`hedge poll error · condition=${condId}: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
}, HEDGE_POLL_INTERVAL_MS).unref();

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

  // Cancel current hedge if any. Refund its full cost to the bucket — we assume the cancel
  // succeeds before any fill. If it raced with a fill, our accounting will be slightly off
  // until next reconcile (the addSideSpent clamp-at-zero prevents going negative).
  if (state.hedge) {
    const old = state.hedge;
    await safeCancel(client, old.orderId, cfg, `reconcile condition=${state.conditionId}`);
    addSideSpent(cfg.targetAddress, old.tokenId, -(old.price * old.size));
    state.hedge = null;
    const msg = `hedge cancelled · condition=${state.conditionId} oldToken=${old.tokenId} oldSize=${old.size} oldPrice=${old.price} refunded=$${(old.price * old.size).toFixed(4)} · tx=${txHash}`;
    console.log(msg);
    void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
  }

  if (!ideal) {
    const msg = `hedge none-needed · condition=${state.conditionId} sharesByToken=${JSON.stringify(Object.fromEntries(state.sharesByToken))} · tx=${txHash}`;
    console.log(msg);
    void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
    return;
  }

  // Cap-aware sizing: clip the hedge to fit the opposite side's max_market_usdc bucket.
  // If even one tick of hedge would overflow the bucket, we skip the hedge entirely.
  let sizeToPlace = ideal.size;
  if (cfg.maxMarketUsdc !== undefined) {
    const alreadySpent = getSideSpent(cfg.targetAddress, ideal.tokenId);
    const remaining = cfg.maxMarketUsdc - alreadySpent;
    const desiredCost = ideal.price * ideal.size;
    if (desiredCost > remaining) {
      const maxAffordableSize = remaining / ideal.price;
      if (maxAffordableSize <= 0) {
        const skipMsg = `hedge skipped · max_market_usdc bucket full on opposite side · spent=$${alreadySpent.toFixed(2)} cap=$${cfg.maxMarketUsdc} hedgeToken=${ideal.tokenId} · tx=${txHash}`;
        console.log(skipMsg);
        void appendCopyTradeSuccessLine(skipMsg, cfg.copyTradeLogPath);
        return;
      }
      const clipMsg = `hedge clipped by max_market_usdc · desired=${ideal.size.toFixed(2)} sh → ${maxAffordableSize.toFixed(2)} sh · spent=$${alreadySpent.toFixed(2)} cap=$${cfg.maxMarketUsdc} · tx=${txHash}`;
      console.log(clipMsg);
      void appendCopyTradeSuccessLine(clipMsg, cfg.copyTradeLogPath);
      sizeToPlace = maxAffordableSize;
    }
  }

  const finalHedge: HedgeRest = { ...ideal, size: sizeToPlace };
  const finalCost = finalHedge.price * finalHedge.size;

  if (cfg.dryRun) {
    const msg = `[DRY RUN] would place hedge · condition=${state.conditionId} hedgeToken=${finalHedge.tokenId} price=${finalHedge.price} shares=${finalHedge.size} cost=$${finalCost.toFixed(4)} · tx=${txHash}`;
    console.log(msg);
    void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
    state.hedge = { ...finalHedge, orderId: "DRY_RUN" };
    addSideSpent(cfg.targetAddress, finalHedge.tokenId, finalCost);
    return;
  }

  // Place new hedge.
  try {
    const [tickSize, negRisk] = await Promise.all([
      getTickSizeCached(client, finalHedge.tokenId),
      getNegRiskCached(client, finalHedge.tokenId),
    ]);
    const resp = await client.createAndPostOrder(
      {
        tokenID: finalHedge.tokenId,
        price: finalHedge.price,
        side: Side.BUY,
        size: finalHedge.size,
      },
      { tickSize, negRisk },
      OrderType.GTC
    );
    const orderId = (resp as { orderID?: string })?.orderID ?? null;
    if (orderId) {
      state.hedge = { ...finalHedge, orderId };
      addSideSpent(cfg.targetAddress, finalHedge.tokenId, finalCost);
    }
    const msg = `hedge placed · condition=${state.conditionId} hedgeToken=${finalHedge.tokenId} price=${finalHedge.price} shares=${finalHedge.size} cost=$${finalCost.toFixed(4)} · tx=${txHash} · ${JSON.stringify(resp)}`;
    console.log(msg);
    void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
  } catch (e) {
    const errMsg = `hedge · post failed: ${e instanceof Error ? e.message : String(e)} · condition=${state.conditionId} hedgeToken=${finalHedge.tokenId} · tx=${txHash}`;
    console.error(errMsg);
    void appendCopyTradeSuccessLine(errMsg, cfg.copyTradeLogPath);
  }
}

/** Gets an existing hedge state for a tokenId's condition or creates one, refreshing cfg + activity. */
async function getOrCreateHedgeState(
  cfg: CopyTradeConfig,
  primaryTokenId: string
): Promise<MarketHedgeState | null> {
  const opp = await getOppositeTokenId(primaryTokenId);
  if (!opp) {
    return null;
  }
  let state = hedgeStateByCondition.get(opp.conditionId);
  if (!state) {
    state = {
      conditionId: opp.conditionId,
      tokenA: primaryTokenId,
      tokenB: opp.oppositeTokenId,
      sharesByToken: new Map(),
      hedge: null,
      cfg,
      lastActivityMs: Date.now(),
      reconcileChain: Promise.resolve(),
    };
    hedgeStateByCondition.set(opp.conditionId, state);
  } else {
    // Most-recent target's cfg wins (hedge_price / cap). Refresh activity so poller keeps it alive.
    state.cfg = cfg;
    state.lastActivityMs = Date.now();
  }
  return state;
}

/**
 * Record a successful BUY copy in state (additive to sharesByToken, using ACTUAL filled shares)
 * and reconcile the hedge. Serialized per-condition via the mutex so it can't race the poller.
 */
async function recordCopyBuyAndReconcile(
  cfg: CopyTradeConfig,
  client: ClobClient,
  primaryTokenId: string,
  filledShares: number,
  txHash: string
): Promise<void> {
  if (cfg.hedgePrice === undefined) {
    return;
  }
  const state = await getOrCreateHedgeState(cfg, primaryTokenId);
  if (!state) {
    const warn = `hedge · could not resolve opposite token for tokenId=${primaryTokenId} · tx=${txHash}`;
    console.warn(warn);
    void appendCopyTradeSuccessLine(warn, cfg.copyTradeLogPath);
    return;
  }

  await runExclusive(state, async () => {
    const current = state.sharesByToken.get(primaryTokenId) ?? 0;
    state.sharesByToken.set(primaryTokenId, current + filledShares);
    state.lastActivityMs = Date.now();
    await reconcileHedge(cfg, client, state, txHash);
  });
}

/**
 * Record a successful SELL copy in state (subtractive from sharesByToken, clamped at 0) and
 * reconcile the hedge. Mirrors recordCopyBuyAndReconcile — when our held position shrinks, the
 * existing hedge on the opposite side becomes oversized; reconcile resizes (or cancels) it
 * immediately rather than waiting for the next poller tick.
 */
async function recordCopySellAndReconcile(
  cfg: CopyTradeConfig,
  client: ClobClient,
  soldTokenId: string,
  sharesSold: number,
  txHash: string
): Promise<void> {
  if (cfg.hedgePrice === undefined) {
    return;
  }
  const state = await getOrCreateHedgeState(cfg, soldTokenId);
  if (!state) {
    // No existing condition state means there was no hedge to adjust — nothing to do.
    return;
  }

  await runExclusive(state, async () => {
    const current = state.sharesByToken.get(soldTokenId) ?? 0;
    state.sharesByToken.set(soldTokenId, Math.max(0, current - sharesSold));
    state.lastActivityMs = Date.now();
    await reconcileHedge(cfg, client, state, txHash);
  });
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

  // Serialize with the poller: this mutates state.hedge (reads fill status + cancels), and a
  // concurrent poll-triggered reconcile could otherwise place/cancel a competing hedge.
  let result: { suppress: boolean; reason?: string } = { suppress: false };
  await runExclusive(state, async () => {
    const hedge = state.hedge;
    if (!hedge || hedge.tokenId !== digest.tokenId) {
      // State changed while we waited for the mutex — nothing to suppress against.
      return;
    }
    state.lastActivityMs = Date.now();

    // Dry-run hedge orders never "fill" because they never exist on CLOB. Treat as resting.
    if (hedge.orderId === "DRY_RUN") {
      state.hedge = null;
      const msg = `[DRY RUN] discarding pretend-hedge for condition=${state.conditionId} hedgeToken=${hedge.tokenId} (target buying that side) · tx=${txHash}`;
      console.log(msg);
      void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
      return;
    }

    const matched = await readHedgeMatched(client, hedge.orderId);
    if (matched !== null && matched > 0) {
      // Treat as fully done: roll matched portion into held shares, cancel the unmatched remainder.
      await safeCancel(client, hedge.orderId, cfg, "matched-but-cleanup-remainder");
      const unmatchedShares = Math.max(0, hedge.size - matched);
      if (unmatchedShares > 0) {
        addSideSpent(cfg.targetAddress, hedge.tokenId, -(unmatchedShares * hedge.price));
      }
      const existing = state.sharesByToken.get(hedge.tokenId) ?? 0;
      state.sharesByToken.set(hedge.tokenId, existing + matched);
      state.hedge = null;
      result = {
        suppress: true,
        reason: `hedge filled (${matched} of ${hedge.size} shares matched at $${hedge.price})`,
      };
      return;
    }

    // Not filled — cancel resting hedge to prevent later behind-our-back fill that would double-hedge.
    await safeCancel(client, hedge.orderId, cfg, "diverting-to-copy-target-opposite");
    addSideSpent(cfg.targetAddress, hedge.tokenId, -(hedge.size * hedge.price));
    const msg = `hedge cancelled (diverting to copy target's opposite-side buy) · condition=${state.conditionId} hedgeToken=${hedge.tokenId} price=${hedge.price} shares=${hedge.size} refunded=$${(hedge.size * hedge.price).toFixed(4)} · tx=${txHash}`;
    console.log(msg);
    void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
    state.hedge = null;
  });
  return result;
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

  // ── Pre-CLOB cheap filters: fail fast before spending any API budget ──────────────────
  // For BUY: notional sizing only depends on origin pUSD + copy_ratio + config thresholds.
  // No need to fetch tick/negRisk/book/midpoint just to skip a $0.30 copy below min_position_usdc.
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

    // Per-target per-side cap: clip down to remaining bucket capacity. Skip if remaining
    // wouldn't satisfy min_position_usdc — we don't post sub-min orders.
    if (cfg.maxMarketUsdc !== undefined) {
      const alreadySpent = getSideSpent(cfg.targetAddress, digest.tokenId);
      const remaining = cfg.maxMarketUsdc - alreadySpent;
      if (remaining <= 0) {
        await logCopySkip(
          `max_market_usdc cap reached · spent=$${alreadySpent.toFixed(2)} cap=$${cfg.maxMarketUsdc} token=${digest.tokenId}`,
          digest,
          txHash,
          cfg
        );
        return;
      }
      if (clippedUsdc > remaining) {
        if (remaining < cfg.minPositionUsdc) {
          await logCopySkip(
            `max_market_usdc remaining $${remaining.toFixed(2)} < MIN_POSITION_USDC ${cfg.minPositionUsdc} · spent=$${alreadySpent.toFixed(2)} cap=$${cfg.maxMarketUsdc} token=${digest.tokenId}`,
            digest,
            txHash,
            cfg
          );
          return;
        }
        clippedUsdc = remaining;
      }
    }
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

  // tickSize + negRisk are cached (immutable per market) — only fetched once per tokenId.
  const [tickSize, negRisk, book, midRaw] = await Promise.all([
    getTickSizeCached(client, digest.tokenId),
    getNegRiskCached(client, digest.tokenId),
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

  let limitPrice: number;
  if (digest.side === "buy") {
    const ask = bestAsk(book);
    if (ask === null) {
      await logCopySkip("empty asks", digest, txHash, cfg);
      return;
    }

    // Option A drift check: compare the price we'd ACTUALLY pay (effectivePrice) against implied,
    // not the midpoint. Catches wide-spread books where midpoint passes but ask is much higher.
    const effectivePrice = Math.max(currentPrice, ask);
    const drift = effectivePrice - implied;
    if (drift > cfg.maxPriceDifference) {
      await logCopySkip(
        `price drift buy · implied(on-chain)=${implied.toFixed(4)} effective=${effectivePrice.toFixed(4)} clobMid=${currentPrice.toFixed(4)} bestAsk=${ask.toFixed(4)} drift=${drift.toFixed(4)} maxΔ=${cfg.maxPriceDifference} · ${formatOriginTradeSizing(digest)}`,
        digest,
        txHash,
        cfg
      );
      return;
    }

    limitPrice = roundToTick(effectivePrice, tickSize, "up");

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
    // Sells: no drift check (per design). Just price to top of book.
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
    // Track the would-be position so suppression / reconcile / max_market_usdc logs reflect reality.
    if (digest.side === "buy") {
      addSideSpent(cfg.targetAddress, digest.tokenId, clippedUsdc ?? 0);
      await recordCopyBuyAndReconcile(cfg, client, digest.tokenId, orderShares, txHash);
    } else {
      resetSideSpent(cfg.targetAddress, digest.tokenId);
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

  // Actual fill from the CLOB response. The labels flip by side:
  //   BUY  → takingAmount = shares acquired, makingAmount = USDC paid
  //   SELL → makingAmount = shares given,    takingAmount = USDC received
  // (the order maker "makes" the asset they post and "takes" the asset they want).
  const respObj = resp as { takingAmount?: string; makingAmount?: string };
  const taking = parseFloat(respObj.takingAmount ?? "0") || 0;
  const making = parseFloat(respObj.makingAmount ?? "0") || 0;
  const filledShares = digest.side === "buy" ? taking : making;
  const filledUsdc = digest.side === "buy" ? making : taking;

  const { event, outcome } = await fetchPolymarketMarketLabels(digest.tokenId);
  const intendedPUsd = digest.side === "buy" ? (clippedUsdc ?? 0) : originPusd;
  const msg = `copy posted · ${digest.side} submitted=${orderShares} sh ($${intendedPUsd.toFixed(6)}) filled=${filledShares} sh ($${filledUsdc.toFixed(6)}) · event=${JSON.stringify(event)} outcome=${JSON.stringify(outcome)} · limit=${limitPrice} implied=${implied.toFixed(4)} · tx=${txHash} · ${JSON.stringify(resp)}`;
  console.log(msg);
  void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);

  // After a successful live BUY: add filled shares to sharesByToken and reconcile (hedge grows).
  // After a successful live SELL: subtract filled shares from sharesByToken and reconcile so
  //   the now-oversized hedge is resized or cancelled IMMEDIATELY (don't wait for the poller).
  // Bucket: BUY accrues actual USDC spent; SELL resets the side's bucket (full-exit semantics).
  if (digest.side === "buy") {
    addSideSpent(cfg.targetAddress, digest.tokenId, filledUsdc);
    await recordCopyBuyAndReconcile(cfg, client, digest.tokenId, filledShares, txHash);
  } else {
    await recordCopySellAndReconcile(cfg, client, digest.tokenId, filledShares, txHash);
    resetSideSpent(cfg.targetAddress, digest.tokenId);
  }
}
