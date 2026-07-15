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
import { appendLedger, type LedgerRecord } from "./orderLedger.js";
import { isTargetStopped } from "./drawdownGuard.js";
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

/** Relative cap used for the taker bump when `taker_bump` is set but `max_taker_bump_frac` is omitted. */
export const DEFAULT_MAX_TAKER_BUMP_FRAC = 0.1;

/**
 * Buy limit price with the optional taker bump applied. Posts ABOVE the ask so the order crosses and
 * fills as a taker, but caps the bump to `maxFrac × ask` (so low prices aren't over-paid) and stays
 * tick-aware: if rounding the bump UP to the tick would exceed the cap, it falls back to `baseLimit`
 * (post at the ask) rather than overpay a whole tick — accepting the order may rest instead.
 *
 * Applied AFTER the drift check (option B), so the bump doesn't fight the drift filter; `buy_price_max`
 * still bounds the result downstream. Returns `baseLimit` unchanged when the bump is disabled.
 */
export function applyTakerBump(
  ask: number,
  baseLimit: number,
  tick: TickSize,
  takerBump: number | undefined,
  maxTakerBumpFrac: number | undefined
): number {
  if (takerBump === undefined || takerBump <= 0 || !(ask > 0)) {
    return baseLimit;
  }
  const frac = maxTakerBumpFrac ?? DEFAULT_MAX_TAKER_BUMP_FRAC;
  const cap = ask * frac;
  const effBump = Math.min(takerBump, cap);
  const bumped = roundToTick(ask + effBump, tick, "up");
  const maxAllowed = ask * (1 + frac);
  if (bumped > baseLimit && bumped <= maxAllowed + 1e-9) {
    return bumped;
  }
  return baseLimit; // one tick would break the cap, or bump gives no improvement over base
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Uniform sizing block appended to EVERY copy-skip line so all skips carry the same four fields
 * in the same place, regardless of where in the flow the skip fires. `copyUSD`/`shares` are OUR
 * copy sizing (origin pUSD × copy_ratio, clipped) — not the target's origin trade. Fields not yet
 * computed at the skip point (e.g. `limit` on pre-order-book skips) render as `n/a`. When `shares`
 * isn't supplied it's derived from `copyUSD ÷ (limit ?? implied)`.
 */
type SkipSizing = {
  copyUsd?: number;
  shares?: number;
  limitPrice?: number;
  implied?: number;
};

function formatSkipSizing(s: SkipSizing): string {
  const fmt = (n: number | undefined, d: number) =>
    n !== undefined && Number.isFinite(n) ? n.toFixed(d) : "n/a";
  let shares = s.shares;
  if (shares === undefined && s.copyUsd !== undefined) {
    const basis = s.limitPrice ?? s.implied;
    if (basis !== undefined && basis > 0) {
      shares = s.copyUsd / basis;
    }
  }
  return `copyUSD=${fmt(s.copyUsd, 6)} shares=${fmt(shares, 4)} limit=${fmt(s.limitPrice, 4)} implied=${fmt(s.implied, 4)}`;
}

async function logCopySkip(
  reasonDetail: string,
  digest: CopyDigest,
  txHash: string,
  cfg: CopyTradeConfig,
  sizing: SkipSizing = {}
): Promise<void> {
  const { event, outcome } = await fetchPolymarketMarketLabels(digest.tokenId);
  const msg = `copy skip · ${reasonDetail} · ${formatSkipSizing(sizing)} · event=${JSON.stringify(event)} outcome=${JSON.stringify(outcome)} · tx=${txHash}`;
  console.log(msg);
  void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
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

// ─────────────────────────────────────────────────────────────────────────────
// Below-min accumulator — buffer per (target, tokenId) for `accumulate_below_min`
// ─────────────────────────────────────────────────────────────────────────────

type BufferEntry = {
  originPusd: number;
  originShares: number;
  notionalUsdc: number; // = originPusd × copy_ratio at skip time
  impliedPrice: number; // for the weighted-avg implied check at flush
  txHash: string;
  timestamp: number;
};

type SkipBuffer = {
  entries: BufferEntry[];
  totalOriginPusd: number;
  totalOriginShares: number;
  totalNotionalUsdc: number;
};

const skipBufferByTargetToken = new Map<string, SkipBuffer>();
const SKIP_BUFFER_TTL_MS = 15 * 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [k, buf] of skipBufferByTargetToken) {
    const oldest = buf.entries[0]?.timestamp ?? now;
    if (now - oldest > SKIP_BUFFER_TTL_MS) {
      skipBufferByTargetToken.delete(k);
    }
  }
}, 5 * 60_000).unref();

function skipBufferKey(targetAddress: string, tokenId: string): string {
  return `${targetAddress.toLowerCase()}:${tokenId}`;
}

function getSkipBuffer(targetAddress: string, tokenId: string): SkipBuffer | undefined {
  return skipBufferByTargetToken.get(skipBufferKey(targetAddress, tokenId));
}

function pushSkipBuffer(targetAddress: string, tokenId: string, entry: BufferEntry): SkipBuffer {
  const k = skipBufferKey(targetAddress, tokenId);
  let buf = skipBufferByTargetToken.get(k);
  if (!buf) {
    buf = { entries: [], totalOriginPusd: 0, totalOriginShares: 0, totalNotionalUsdc: 0 };
    skipBufferByTargetToken.set(k, buf);
  }
  buf.entries.push(entry);
  buf.totalOriginPusd += entry.originPusd;
  buf.totalOriginShares += entry.originShares;
  buf.totalNotionalUsdc += entry.notionalUsdc;
  return buf;
}

function clearSkipBuffer(targetAddress: string, tokenId: string): void {
  skipBufferByTargetToken.delete(skipBufferKey(targetAddress, tokenId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Drift re-watch — repost buys skipped for `price drift buy` once the CLOB price
// returns to within max_price_difference of the target's on-chain implied. Applies
// only to the OVERBID drift skip (not underbid — that signals the target's bet is
// going wrong). Per (target, tokenId); each buffered digest keeps the implied from
// its own skip, so digests with different target prices each repost when THEIR gate
// opens. Bounded by a per-target deadline (drift_rewatch_seconds) — these markets
// resolve fast, so watching past the window is pointless/risky.
// ─────────────────────────────────────────────────────────────────────────────

type DriftWatchEntry = { digest: CopyDigest; txHash: string; implied: number };
type DriftWatch = {
  cfg: CopyTradeConfig;
  tokenId: string;
  entries: DriftWatchEntry[];
  deadline: number; // Date.now() ms; the whole watch is dropped after this
};

const driftWatchByTargetToken = new Map<string, DriftWatch>();

/** Fallback drift ceiling if a config somehow omits it (env always sets driftRewatchMax). */
const DEFAULT_DRIFT_REWATCH_MAX = 0.2;

function driftWatchKey(targetAddress: string, tokenId: string): string {
  return `${targetAddress.toLowerCase()}:${tokenId}`;
}

/** Register a drift-skipped BUY for re-watch. No-op when disabled (seconds <= 0) or not a buy. */
function registerDriftWatch(cfg: CopyTradeConfig, digest: CopyDigest, txHash: string, implied: number): void {
  const seconds = cfg.driftRewatchSeconds ?? 0;
  if (seconds <= 0 || digest.side !== "buy") {
    return;
  }
  const k = driftWatchKey(cfg.targetAddress, digest.tokenId);
  const existing = driftWatchByTargetToken.get(k);
  if (existing) {
    // Keep the original (bounded) deadline; just add this skip to the same watch.
    existing.entries.push({ digest, txHash, implied });
  } else {
    driftWatchByTargetToken.set(k, {
      cfg,
      tokenId: digest.tokenId,
      entries: [{ digest, txHash, implied }],
      deadline: Date.now() + seconds * 1000,
    });
  }
}

const DRIFT_REWATCH_POLL_MS = 1000;
let driftRewatchPolling = false;

setInterval(() => {
  if (driftRewatchPolling || driftWatchByTargetToken.size === 0) {
    return;
  }
  driftRewatchPolling = true;
  void (async () => {
    try {
      for (const [k, watch] of [...driftWatchByTargetToken]) {
        try {
          if (Date.now() >= watch.deadline) {
            driftWatchByTargetToken.delete(k);
            void appendCopyTradeSuccessLine(
              `drift rewatch expired · ${watch.entries.length} order(s) dropped · token=${watch.tokenId}`,
              watch.cfg.copyTradeLogPath
            );
            continue;
          }
          const client = await ensureClobClient(watch.cfg);
          const book = await client.getOrderBook(watch.tokenId);
          const ask = bestAsk(book);
          if (ask === null) {
            continue; // one-sided/empty book — wait for asks to reappear (deadline still bounds this)
          }
          const bid = bestBid(book);
          const mid = bid !== null ? (bid + ask) / 2 : ask;
          const effectivePrice = Math.max(mid, ask);
          // Each entry fires when the price has returned to within maxΔ of ITS target implied.
          const ready = watch.entries.filter((e) => effectivePrice - e.implied <= watch.cfg.maxPriceDifference);
          if (ready.length === 0) {
            continue;
          }
          // Remove the ready entries BEFORE reposting so the next tick can't double-post them.
          watch.entries = watch.entries.filter((e) => !ready.includes(e));
          if (watch.entries.length === 0) {
            driftWatchByTargetToken.delete(k);
          }
          void appendCopyTradeSuccessLine(
            `drift rewatch fired · price returned effective=${effectivePrice.toFixed(4)} maxΔ=${watch.cfg.maxPriceDifference} · reposting ${ready.length} order(s) · token=${watch.tokenId}`,
            watch.cfg.copyTradeLogPath
          );
          for (const e of ready) {
            try {
              // fromRewatch: true → executeCopyTrade re-runs ALL gates but won't re-register on a
              // repeat drift skip (avoids unbounded re-queueing beyond the deadline).
              await executeCopyTrade(watch.cfg, e.digest, e.txHash, { fromRewatch: true });
            } catch (err) {
              void appendCopyTradeSuccessLine(
                `drift rewatch repost error · token=${watch.tokenId} · ${err instanceof Error ? err.message : String(err)} · tx=${e.txHash}`,
                watch.cfg.copyTradeLogPath
              );
            }
          }
        } catch {
          // transient per-watch error (book fetch / client) — retry next tick until deadline
        }
      }
    } finally {
      driftRewatchPolling = false;
    }
  })();
}, DRIFT_REWATCH_POLL_MS).unref();

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
  /**
   * Per-target "already-absorbed" marker: key = target address (lowercase), value = tokenId of the
   * side that was absorbed via a matched hedge fill. Survives `state.hedge = null`. Subsequent
   * target buys on that side are suppressed PER-TARGET — Target A's hedge absorption can't falsely
   * suppress Target B's independent same-side trade. Cleared on TTL eviction or on a sell of that
   * token by the matching target.
   */
  absorbedSideByTarget: Map<string, string>;
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
    // P&L ledger (fire-and-forget): the hedge leg is part of each target's realized profit.
    void recordOrderForPnl({ cfg, resp, tokenId: finalHedge.tokenId, side: "buy", isHedge: true, limitPrice: finalHedge.price, conditionId: state.conditionId });
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
      absorbedSideByTarget: new Map(),
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
    // If THIS target sold the side we were considering "already absorbed" for them, clear THEIR
    // marker so a future re-entry on that side by them is copied normally. Other targets'
    // markers are untouched.
    const targetKey = cfg.targetAddress.toLowerCase();
    if (state.absorbedSideByTarget.get(targetKey) === soldTokenId) {
      state.absorbedSideByTarget.delete(targetKey);
    }
    await reconcileHedge(cfg, client, state, txHash);
  });
}

/**
 * EARLY suppression check (Case 15 fix, part 1): pure local marker lookup. No CLOB calls.
 * Suppresses target buys on a side this target already absorbed a hedge fill for, even if all
 * downstream checks would otherwise let the copy through. Runs FIRST so we don't waste CLOB
 * calls evaluating a trade we'll suppress anyway.
 */
async function checkAbsorbedSuppression(
  cfg: CopyTradeConfig,
  digest: CopyDigest
): Promise<{ suppress: boolean; reason?: string }> {
  if (digest.side !== "buy") {
    return { suppress: false };
  }
  const info = await resolveMarketTokens(digest.tokenId);
  if (!info) {
    return { suppress: false };
  }
  const state = hedgeStateByCondition.get(info.conditionId);
  if (!state) {
    return { suppress: false };
  }
  // Per-target "we already absorbed a hedge on this side" marker. Survives state.hedge=null
  // after a matched-fill consumption; per-target so Target A's absorption can't falsely block
  // Target B's independent trade on the same condition.
  const targetKey = cfg.targetAddress.toLowerCase();
  if (state.absorbedSideByTarget.get(targetKey) === digest.tokenId) {
    state.lastActivityMs = Date.now();
    return {
      suppress: true,
      reason: `hedge already absorbed earlier for this side · token=${digest.tokenId}`,
    };
  }
  return { suppress: false };
}

/**
 * LATE suppression check (Case 15 fix, part 2): handles the resting hedge order. Runs AFTER all
 * downstream checks (drift, buy_bounds, min_order_size) have passed and we're committed to
 * posting the copy. This way, if any downstream check would have failed, we never touch the
 * hedge — eliminating the "cancel-then-fail-to-copy → unhedged" window.
 *
 * Per user preference, a partial hedge fill counts as "fully done" — the matched portion is
 * rolled into sharesByToken and the unfilled remainder is cancelled.
 */
async function checkRestingHedgeSuppression(
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
      // Per-target marker so subsequent buys from THIS target on this side stay suppressed.
      state.absorbedSideByTarget.set(cfg.targetAddress.toLowerCase(), hedge.tokenId);
      state.hedge = null;
      result = {
        suppress: true,
        reason: `hedge filled (${matched} of ${hedge.size} shares matched at $${hedge.price})`,
      };
      return;
    }

    // Not filled — cancel resting hedge. SAFE NOW: all downstream checks have passed, caller is
    // about to post the copy. We won't end up hedge-cancelled-without-copy (Case 15).
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
 * Sizes with **shares = (pUSD_notional × COPY_RATIO, clipped) / currentPrice**, where `currentPrice` is the
 * order-book midpoint derived locally from best bid/ask. Posts a marketable GTC limit at/through the book.
 */
/**
 * Fire-and-forget: record a LIVE posted order to the P&L ledger for later per-target reconciliation.
 * Always called with `void` — it must never block or break the trading path, so every failure is
 * swallowed. Fill amounts are the post-time fill from the CLOB response (see orderLedger note).
 */
async function recordOrderForPnl(args: {
  cfg: CopyTradeConfig;
  resp: unknown;
  tokenId: string;
  side: "buy" | "sell";
  isHedge: boolean;
  limitPrice: number;
  conditionId?: string;
  outcome?: string;
  event?: string;
}): Promise<void> {
  try {
    const orderId = (args.resp as { orderID?: string })?.orderID;
    if (!orderId) {
      return;
    }
    const r = args.resp as { takingAmount?: string; makingAmount?: string };
    const taking = parseFloat(r.takingAmount ?? "0") || 0;
    const making = parseFloat(r.makingAmount ?? "0") || 0;
    const filledShares = args.side === "buy" ? taking : making;
    const filledUsdc = args.side === "buy" ? making : taking;

    const conditionId = args.conditionId ?? (await getOppositeTokenId(args.tokenId))?.conditionId;
    if (!conditionId) {
      return; // can't reconcile without the market
    }
    let outcome = args.outcome;
    let event = args.event;
    if (outcome === undefined || event === undefined) {
      const labels = await fetchPolymarketMarketLabels(args.tokenId);
      outcome = outcome ?? labels.outcome;
      event = event ?? labels.event;
    }
    const rec: LedgerRecord = {
      ts: Date.now(),
      orderId,
      target: args.cfg.targetAddress,
      conditionId,
      tokenId: args.tokenId,
      outcome: outcome ?? "",
      side: args.side,
      isHedge: args.isHedge,
      filledShares,
      filledUsdc,
      limitPrice: args.limitPrice,
      event: event ?? "",
    };
    await appendLedger(rec);
  } catch {
    // bookkeeping is best-effort; never affect trading
  }
}

export async function executeCopyTrade(
  cfg: CopyTradeConfig,
  digest: CopyDigest,
  txHash: string,
  opts?: { fromRewatch?: boolean }
): Promise<void> {
  // Drawdown circuit breaker: halt NEW exposure (buys) for a target that breached its P&L limit.
  // Sells/exits are still allowed so existing positions can be unwound.
  if (digest.side === "buy") {
    const stop = isTargetStopped(cfg.targetAddress);
    if (stop) {
      await logCopySkip(`target auto-stopped (drawdown) · ${stop}`, digest, txHash, cfg);
      return;
    }
  }

  const implied = impliedPrice(digest.pusdRaw, digest.outcomeRaw);
  const originPusd = parseFloat(formatUnits(digest.pusdRaw, 6));
  const originShares = parseFloat(formatUnits(digest.outcomeRaw, 6));
  if (!Number.isFinite(implied) || implied <= 0) {
    await logCopySkip(`bad implied on-chain price · token=${digest.tokenId}`, digest, txHash, cfg);
    return;
  }

  // Effective values — overwritten when the below-min accumulator combines this trade with
  // previously-buffered sub-min trades. For drift checks and logging we want the COMBINED
  // implied (weighted by origin USDC) and the COMBINED origin pUSD/shares.
  let effectiveImplied = implied;
  let effectiveOriginPusd = originPusd;
  let effectiveOriginShares = originShares;
  let flushedFromBufferCount = 0;

  // ── Pre-CLOB cheap filters: fail fast before spending any API budget ──────────────────
  // For BUY: notional sizing only depends on origin pUSD + copy_ratio + config thresholds.
  // No need to fetch tick/negRisk/book/midpoint just to skip a $0.30 copy below min_position_usdc.
  let clippedUsdc: number | null = null;
  if (digest.side === "buy") {
    const usdcNotional = originPusd * cfg.copyRatio;

    // Combine with any existing accumulator buffer for this (target, tokenId), if the feature
    // is enabled. The buffer holds prior sub-min trades whose combined notional is still < min.
    let combinedNotional = usdcNotional;
    if (cfg.accumulateBelowMin) {
      const buf = getSkipBuffer(cfg.targetAddress, digest.tokenId);
      if (buf) {
        combinedNotional += buf.totalNotionalUsdc;
        effectiveOriginPusd += buf.totalOriginPusd;
        effectiveOriginShares += buf.totalOriginShares;
        flushedFromBufferCount = buf.entries.length;
        // Weighted-avg implied across all combined origin trades (sums-of-pUSD / sums-of-shares).
        effectiveImplied = effectiveOriginShares > 0 ? effectiveOriginPusd / effectiveOriginShares : implied;
      }
    }

    if (combinedNotional < cfg.minPositionUsdc) {
      // min_position_usdc is a hard floor. Set it to 0 in copy-targets.toml to disable; the
      // accumulator now targets `min_order_size` (the CLOB's share-count floor) instead, since
      // share-count is the actual CLOB-imposed minimum that matters for thin-share trades.
      await logCopySkip(
        `below MIN_POSITION_USDC ${cfg.minPositionUsdc}`,
        digest,
        txHash,
        cfg,
        { copyUsd: combinedNotional, implied: effectiveImplied }
      );
      return;
    }

    clippedUsdc = clamp(combinedNotional, cfg.minPositionUsdc, cfg.maxPositionUsdc);

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
          cfg,
          { copyUsd: clippedUsdc ?? undefined, implied: effectiveImplied }
        );
        return;
      }
      if (clippedUsdc > remaining) {
        if (remaining < cfg.minPositionUsdc) {
          await logCopySkip(
            `max_market_usdc remaining $${remaining.toFixed(2)} < MIN_POSITION_USDC ${cfg.minPositionUsdc} · spent=$${alreadySpent.toFixed(2)} cap=$${cfg.maxMarketUsdc} token=${digest.tokenId}`,
            digest,
            txHash,
            cfg,
            { copyUsd: clippedUsdc ?? undefined, implied: effectiveImplied }
          );
          return;
        }
        clippedUsdc = remaining;
      }
    }
  }

  const client = await ensureClobClient(cfg);

  // EARLY suppression: cheap local absorbedSide check only. The resting-hedge interaction is
  // deferred to LATE (just before createAndPostOrder) so we don't cancel a hedge for a copy
  // that's about to fail a downstream check (drift / buy_bounds / min_order_size).
  if (cfg.hedgePrice !== undefined) {
    const sup = await checkAbsorbedSuppression(cfg, digest);
    if (sup.suppress) {
      await logCopySkip(`already hedged · ${sup.reason ?? ""} · token=${digest.tokenId}`, digest, txHash, cfg, {
        copyUsd: clippedUsdc ?? undefined,
        implied: effectiveImplied,
      });
      return;
    }
  }

  // tickSize + negRisk are cached (immutable per market) — only fetched once per tokenId.
  // Midpoint is derived locally from the order book instead of a separate getMidpoint call: the
  // book already carries both sides, and currentPrice is only ever used as max(mid,ask) for buys
  // / min(mid,bid) for sells — both collapse to the book's ask/bid. Saves one CLOB request per
  // copy and removes the sequential getPrice fallback.
  const [tickSize, negRisk, book] = await Promise.all([
    getTickSizeCached(client, digest.tokenId),
    getNegRiskCached(client, digest.tokenId),
    client.getOrderBook(digest.tokenId),
  ]);

  const topBid = bestBid(book);
  const topAsk = bestAsk(book);
  // Both sides → true midpoint. One-sided book → use the side that exists; the side-specific
  // empty asks/bids checks below still gate a buy/sell that needs the missing side.
  let currentPrice: number | null;
  if (topBid !== null && topAsk !== null) {
    currentPrice = (topBid + topAsk) / 2;
  } else {
    currentPrice = topAsk ?? topBid;
  }
  if (currentPrice === null || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    await logCopySkip(`empty/invalid order book · token=${digest.tokenId}`, digest, txHash, cfg, {
      copyUsd: clippedUsdc ?? undefined,
      implied: effectiveImplied,
    });
    return;
  }

  let limitPrice: number;
  if (digest.side === "buy") {
    const ask = bestAsk(book);
    if (ask === null) {
      await logCopySkip("empty asks", digest, txHash, cfg, {
        copyUsd: clippedUsdc ?? undefined,
        implied: effectiveImplied,
      });
      return;
    }

    // Option A drift check: compare the price we'd ACTUALLY pay (effectivePrice) against the
    // EFFECTIVE implied (weighted across any flushed buffer entries), not the midpoint. Catches
    // wide-spread books where midpoint passes but ask is much higher.
    // Overbid (effective > implied): skip when drift > max_price_difference (market moved up,
    // we'd pay too much vs target). Underbid (effective < implied): skip when drift below
    // -max_underbid_difference (market moved down too much, signals target's bet is going wrong).
    const effectivePrice = Math.max(currentPrice, ask);
    const drift = effectivePrice - effectiveImplied;
    if (drift > cfg.maxPriceDifference) {
      // Re-watch only MODEST drifts. A drift far above max_price_difference means the market
      // repriced hard; if it later snaps back it's usually a new regime, not the original signal
      // — so past drift_rewatch_max we drop it permanently instead of chasing a stale entry.
      const rewatchEnabled = !opts?.fromRewatch && (cfg.driftRewatchSeconds ?? 0) > 0;
      const rewatchMax = cfg.driftRewatchMax ?? DEFAULT_DRIFT_REWATCH_MAX;
      const rewatchOn = rewatchEnabled && drift <= rewatchMax;
      const rewatchNote = rewatchOn
        ? ` · rewatch=${cfg.driftRewatchSeconds}s`
        : rewatchEnabled
          ? ` · no rewatch (drift>${rewatchMax})`
          : "";
      await logCopySkip(
        `price drift buy · implied(on-chain)=${effectiveImplied.toFixed(4)} effective=${effectivePrice.toFixed(4)} clobMid=${currentPrice.toFixed(4)} bestAsk=${ask.toFixed(4)} drift=${drift.toFixed(4)} maxΔ=${cfg.maxPriceDifference}${flushedFromBufferCount > 0 ? ` · flushedFromBuffer=${flushedFromBufferCount}` : ""}${rewatchNote}`,
        digest,
        txHash,
        cfg,
        { copyUsd: clippedUsdc ?? undefined, implied: effectiveImplied }
      );
      if (rewatchOn) {
        registerDriftWatch(cfg, digest, txHash, effectiveImplied);
      }
      return;
    }
    if (cfg.maxUnderbidDifference !== undefined && -drift > cfg.maxUnderbidDifference) {
      await logCopySkip(
        `underbid skip · implied(on-chain)=${effectiveImplied.toFixed(4)} effective=${effectivePrice.toFixed(4)} clobMid=${currentPrice.toFixed(4)} bestAsk=${ask.toFixed(4)} underbid=${(-drift).toFixed(4)} maxUnderbid=${cfg.maxUnderbidDifference}${flushedFromBufferCount > 0 ? ` · flushedFromBuffer=${flushedFromBufferCount}` : ""}`,
        digest,
        txHash,
        cfg,
        { copyUsd: clippedUsdc ?? undefined, implied: effectiveImplied }
      );
      return;
    }

    limitPrice = roundToTick(effectivePrice, tickSize, "up");
    // Taker bump (fill improvement): cross above the ask so the order fills, capped relative to price
    // and tick-aware. After the drift check (option B), before the buy_price bounds below.
    limitPrice = applyTakerBump(ask, limitPrice, tickSize, cfg.takerBump, cfg.maxTakerBumpFrac);

    if (cfg.buyPriceMin !== undefined && limitPrice < cfg.buyPriceMin) {
      await logCopySkip(
        `buy limitPrice=${limitPrice.toFixed(4)} below buy_price_min=${cfg.buyPriceMin}`,
        digest,
        txHash,
        cfg,
        { copyUsd: clippedUsdc ?? undefined, limitPrice, implied: effectiveImplied }
      );
      return;
    }
    if (cfg.buyPriceMax !== undefined && limitPrice > cfg.buyPriceMax) {
      await logCopySkip(
        `buy limitPrice=${limitPrice.toFixed(4)} above buy_price_max=${cfg.buyPriceMax}`,
        digest,
        txHash,
        cfg,
        { copyUsd: clippedUsdc ?? undefined, limitPrice, implied: effectiveImplied }
      );
      return;
    }
  } else {
    // Sells: no drift check (per design). Just price to top of book.
    const bid = bestBid(book);
    if (bid === null) {
      await logCopySkip("empty bids", digest, txHash, cfg, { implied: effectiveImplied });
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
      await logCopySkip(`invalid balance response · token=${digest.tokenId}`, digest, txHash, cfg, {
        limitPrice,
        implied: effectiveImplied,
      });
      return;
    }
    if (!Number.isFinite(fullBalance) || fullBalance <= 0) {
      await logCopySkip(
        `no balance to sell · token=${digest.tokenId} · clob=${currentPrice.toFixed(4)}`,
        digest,
        txHash,
        cfg,
        { limitPrice, implied: effectiveImplied }
      );
      return;
    }
    orderShares = fullBalance;
  }

  const minOrder = parseFloat(book.min_order_size);
  if (!Number.isNaN(minOrder) && orderShares < minOrder) {
    // Accumulator: if enabled and this is a BUY, buffer the current trade so a future buy on the
    // same (target, tokenId) can combine with it and cross the CLOB's share-count floor in one
    // posted order. The buffer's pUSD/shares are read at the top of this function via
    // `getSkipBuffer` and folded into `combinedNotional` / `effectiveImplied` for sizing.
    if (digest.side === "buy" && cfg.accumulateBelowMin) {
      pushSkipBuffer(cfg.targetAddress, digest.tokenId, {
        originPusd,
        originShares,
        notionalUsdc: originPusd * cfg.copyRatio,
        impliedPrice: implied,
        txHash,
        timestamp: Date.now(),
      });
      const buf = getSkipBuffer(cfg.targetAddress, digest.tokenId)!;
      await logCopySkip(
        `accumulating below min_order_size · combined shares=${orderShares.toFixed(4)} < min_order_size ${minOrder} · buffer entries=${buf.entries.length} totalOriginPusd=$${buf.totalOriginPusd.toFixed(4)} avgImplied=${(buf.totalOriginShares > 0 ? buf.totalOriginPusd / buf.totalOriginShares : 0).toFixed(4)}`,
        digest,
        txHash,
        cfg,
        { copyUsd: clippedUsdc ?? undefined, shares: orderShares, limitPrice, implied: effectiveImplied }
      );
      return;
    }
    await logCopySkip(`size ${orderShares} < min_order_size ${book.min_order_size}`, digest, txHash, cfg, {
      copyUsd: clippedUsdc ?? undefined,
      shares: orderShares,
      limitPrice,
      implied: effectiveImplied,
    });
    return;
  }

  // Past min_order_size: we're committed to posting. Clear the buffer (if any flush is in
  // progress) and log the flush. From here, any later failure (CLOB error) just leaves us
  // unbuffered for next time — drift only widens, so re-buffering wouldn't help anyway.
  if (digest.side === "buy" && cfg.accumulateBelowMin && flushedFromBufferCount > 0) {
    clearSkipBuffer(cfg.targetAddress, digest.tokenId);
    const flushMsg = `accumulator flush · combined notional $${(clippedUsdc ?? 0).toFixed(4)} from ${flushedFromBufferCount} buffered + current · orderShares=${orderShares.toFixed(2)} >= min_order_size ${minOrder} · token=${digest.tokenId}`;
    console.log(flushMsg);
    void appendCopyTradeSuccessLine(flushMsg, cfg.copyTradeLogPath);
  }

  // LATE suppression (Case 15 fix): now that ALL downstream checks have passed and we're
  // committed to posting, it's safe to cancel a resting hedge or detect a fill. Before this,
  // any check could have failed and left us hedge-cancelled-without-copy.
  if (cfg.hedgePrice !== undefined && digest.side === "buy") {
    const sup = await checkRestingHedgeSuppression(cfg, client, digest, txHash);
    if (sup.suppress) {
      await logCopySkip(`already hedged · ${sup.reason ?? ""} · token=${digest.tokenId}`, digest, txHash, cfg, {
        copyUsd: clippedUsdc ?? undefined,
        shares: orderShares,
        limitPrice,
        implied: effectiveImplied,
      });
      return;
    }
  }

  const side = digest.side === "buy" ? Side.BUY : Side.SELL;

  // ── ATOMIC max_market_usdc reservation ────────────────────────────────────────────────
  // Re-read the bucket and reserve the posted notional in ONE synchronous block (no await
  // between the read and the write), immediately before posting. Because Node is single-
  // threaded, no other fire-and-forget copy can interleave between the read and the write —
  // the first to arrive reserves, every later one sees it and clips or skips. This is the
  // AUTHORITATIVE cap gate; the pre-book check above is only a cheap fast-fail. Zero added
  // latency (in-memory map ops), so a burst of concurrent same-side copies can no longer
  // collectively exceed the cap. Only reached after all skip checks, so a copy that bails
  // earlier never reserves; the sole refund path is a post that throws (below).
  let reservedUsdc = 0;
  if (digest.side === "buy" && cfg.maxMarketUsdc !== undefined) {
    const alreadySpent = getSideSpent(cfg.targetAddress, digest.tokenId);
    const remaining = cfg.maxMarketUsdc - alreadySpent;
    if (remaining <= 0) {
      await logCopySkip(
        `max_market_usdc cap reached · spent=$${alreadySpent.toFixed(2)} cap=$${cfg.maxMarketUsdc} token=${digest.tokenId}`,
        digest,
        txHash,
        cfg,
        { copyUsd: clippedUsdc ?? undefined, limitPrice, implied: effectiveImplied }
      );
      return;
    }
    if ((clippedUsdc ?? 0) > remaining) {
      if (remaining < cfg.minPositionUsdc) {
        await logCopySkip(
          `max_market_usdc remaining $${remaining.toFixed(2)} < MIN_POSITION_USDC ${cfg.minPositionUsdc} · spent=$${alreadySpent.toFixed(2)} cap=$${cfg.maxMarketUsdc} token=${digest.tokenId}`,
          digest,
          txHash,
          cfg,
          { copyUsd: clippedUsdc ?? undefined, limitPrice, implied: effectiveImplied }
        );
        return;
      }
      clippedUsdc = remaining;
      orderShares = clippedUsdc / limitPrice;
      if (orderShares < minOrder) {
        await logCopySkip(
          `max_market_usdc clip → size ${orderShares.toFixed(4)} < min_order_size ${minOrder} · remaining $${remaining.toFixed(2)} spent=$${alreadySpent.toFixed(2)} cap=$${cfg.maxMarketUsdc} token=${digest.tokenId}`,
          digest,
          txHash,
          cfg,
          { copyUsd: clippedUsdc, shares: orderShares, limitPrice, implied: effectiveImplied }
        );
        return;
      }
    }
    // Commit the reservation — atomic w.r.t. the getSideSpent read above (no await between).
    addSideSpent(cfg.targetAddress, digest.tokenId, clippedUsdc ?? 0);
    reservedUsdc = clippedUsdc ?? 0;
  }

  if (cfg.dryRun) {
    const { event, outcome } = await fetchPolymarketMarketLabels(digest.tokenId);
    const pUsdForLog = digest.side === "buy" ? (clippedUsdc ?? 0) : originPusd;
    const flushSuffix = flushedFromBufferCount > 0 ? ` · flushedFromBuffer=${flushedFromBufferCount}` : "";
    const msg =
      `[DRY RUN] would post GTC · side=${digest.side} shares=${orderShares} pUSD=${pUsdForLog.toFixed(6)} · event=${JSON.stringify(event)} outcome=${JSON.stringify(outcome)} · tokenID=${digest.tokenId} limitPrice=${limitPrice} tickSize=${tickSize} negRisk=${negRisk} · implied=${effectiveImplied.toFixed(4)} · tx=${txHash}${flushSuffix}`;
    console.log(msg);
    void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
    // Reservation for buys was already committed atomically above (max_market_usdc block).
    if (digest.side === "buy") {
      await recordCopyBuyAndReconcile(cfg, client, digest.tokenId, orderShares, txHash);
    } else {
      resetSideSpent(cfg.targetAddress, digest.tokenId);
      clearSkipBuffer(cfg.targetAddress, digest.tokenId);
    }
    return;
  }

  let resp;
  try {
    resp = await client.createAndPostOrder(
      {
        tokenID: digest.tokenId,
        price: limitPrice,
        side,
        size: orderShares,
      },
      { tickSize, negRisk },
      OrderType.GTC
    );
  } catch (e) {
    // Post failed after we reserved — release the reservation so a failed order doesn't
    // permanently consume max_market_usdc capacity. This is the only refund path.
    if (reservedUsdc > 0) {
      addSideSpent(cfg.targetAddress, digest.tokenId, -reservedUsdc);
    }
    throw e;
  }

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
  const flushSuffix = flushedFromBufferCount > 0 ? ` · flushedFromBuffer=${flushedFromBufferCount}` : "";
  const msg = `copy posted · ${digest.side} submitted=${orderShares} sh ($${intendedPUsd.toFixed(6)}) filled=${filledShares} sh ($${filledUsdc.toFixed(6)}) · event=${JSON.stringify(event)} outcome=${JSON.stringify(outcome)} · limit=${limitPrice} implied=${effectiveImplied.toFixed(4)} · tx=${txHash}${flushSuffix} · ${JSON.stringify(resp)}`;
  console.log(msg);
  void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
  // P&L ledger (fire-and-forget): record this order for per-target reconciliation at resolution.
  void recordOrderForPnl({ cfg, resp, tokenId: digest.tokenId, side: digest.side, isHedge: false, limitPrice, outcome, event });

  // After a successful live BUY: add filled shares to sharesByToken and reconcile (hedge grows).
  // After a successful live SELL: subtract filled shares from sharesByToken and reconcile so
  //   the now-oversized hedge is resized or cancelled IMMEDIATELY (don't wait for the poller).
  // Bucket: BUY reserves the POSTED notional (clippedUsdc), not the fill — so resting/unfilled
  //   orders still count against max_market_usdc and a burst of copies can't overshoot the cap
  //   while their limit orders sit on the book. SELL resets the side's bucket: the bot fully
  //   exits the side on any target sell (partial or full), so the reservation is released whole.
  if (digest.side === "buy") {
    // Reservation was committed atomically before the post (max_market_usdc block). Canary:
    // with the atomic read-modify-write this invariant must never trip; if it does, the
    // reservation logic has regressed. Cheap check, no serialization.
    if (cfg.maxMarketUsdc !== undefined) {
      const spent = getSideSpent(cfg.targetAddress, digest.tokenId);
      if (spent > cfg.maxMarketUsdc + 1e-9) {
        const warn = `max_market_usdc overshoot · spent=$${spent.toFixed(2)} cap=$${cfg.maxMarketUsdc} token=${digest.tokenId} (atomic reserve invariant violated) · tx=${txHash}`;
        console.warn(warn);
        void appendCopyTradeSuccessLine(warn, cfg.copyTradeLogPath);
      }
    }
    await recordCopyBuyAndReconcile(cfg, client, digest.tokenId, filledShares, txHash);
  } else {
    await recordCopySellAndReconcile(cfg, client, digest.tokenId, filledShares, txHash);
    resetSideSpent(cfg.targetAddress, digest.tokenId);
    // Target exited this side — any pending below-min accumulator entries are now stale.
    clearSkipBuffer(cfg.targetAddress, digest.tokenId);
  }
}
