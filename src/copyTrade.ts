import {
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type TickSize,
} from "@polymarket/clob-client-v2";
import { readFileSync, writeFileSync, renameSync } from "fs";
import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import { CONDITIONAL_TOKENS } from "./contracts.js";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { withSuppressedPolymarketClobConsole } from "./clobConsoleSuppress.js";
import type { CopyTradeConfig } from "./env.js";
import type { Ctf1155TransferRow } from "./ctf1155Inbound.js";
import { appendLedger, readLedger, type LedgerRecord } from "./orderLedger.js";
import { isTargetStopped } from "./drawdownGuard.js";
import { appendCopyTradeSuccessLine } from "./copyTradeSuccessLog.js";
import { lookupCryptoMarket, resolveMarketLabelsFast } from "./cryptoMarketPrewarm.js";
import { registerSimOrder } from "./fillSim.js";

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
  /** Market tick size from the PolyNode settlement (real-time). Used to price the order correctly on
   * the first post. Undefined on the on-chain path → fall back to the cached CLOB tick. */
  tickSize?: TickSize;
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

const TICK_SIZES: TickSize[] = ["0.1", "0.01", "0.001", "0.0001"];
function numToTickSize(n: number): TickSize | null {
  return TICK_SIZES.find((t) => Math.abs(parseFloat(t) - n) < 1e-9) ?? null;
}

/**
 * The CLOB rejects a post whose price violates the market's tick with e.g.
 * `{"error":"price 0.046 breaks minimum tick size rule 0.01","status":400}`. Our cached tick can be
 * finer than what order-placement enforces (Polymarket's tick is price-dependent), so we parse the
 * REQUIRED tick out of the error to self-correct and retry. Returns null if not a tick-size error.
 */
function tickSizeFromError(resp: unknown): TickSize | null {
  const err = (resp as { error?: unknown })?.error;
  if (typeof err !== "string") {
    return null;
  }
  const m = err.match(/tick size rule\s+([0-9.]+)/i);
  return m ? numToTickSize(parseFloat(m[1]!)) : null;
}

/** A rejection message if the CLOB refused the order (error / 4xx-5xx), else null (order accepted). */
function postErrorMessage(resp: unknown): string | null {
  const r = resp as { error?: unknown; status?: unknown };
  if (typeof r?.error === "string" && r.error.length > 0) {
    return r.error;
  }
  if (typeof r?.status === "number" && r.status >= 400) {
    return `HTTP ${r.status}`;
  }
  return null;
}

/**
 * Proportional sell: mirror the FRACTION the target sold onto our own position, rather than dumping
 * everything on any target sell. `targetSold`/`targetHeldBefore` are the target's; `botBalance` is
 * ours. If the target's holding is unknown (null) we fall back to a full exit — the safe default and
 * the previous behavior. Example: target sold 10 of 100 held (10%), we hold 90 → sell 9.
 */
export function proportionalSellShares(
  targetSold: number,
  targetHeldBefore: number | null,
  botBalance: number
): number {
  if (targetHeldBefore === null || !(targetHeldBefore > 0)) {
    return botBalance;
  }
  const fraction = Math.min(1, Math.max(0, targetSold / targetHeldBefore));
  return fraction * botBalance;
}

const ERC1155_BALANCE_ABI = ["function balanceOf(address account, uint256 id) view returns (uint256)"];
let ctfProvider: JsonRpcProvider | null = null;

/** The target's on-chain ERC-1155 balance of an outcome token (their holding), in shares. Null on failure. */
async function fetchTargetTokenBalance(cfg: CopyTradeConfig, target: string, tokenId: string): Promise<number | null> {
  try {
    if (!ctfProvider) {
      ctfProvider = new JsonRpcProvider(cfg.polygonHttpUrl, 137, { staticNetwork: true });
    }
    const ctf = new Contract(CONDITIONAL_TOKENS, ERC1155_BALANCE_ABI, ctfProvider) as unknown as {
      balanceOf: (account: string, id: bigint) => Promise<bigint>;
    };
    const raw = await ctf.balanceOf(target, BigInt(tokenId));
    const v = parseFloat(formatUnits(raw, 6));
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Relative cap used for the taker bump when `taker_bump` is set but `max_taker_bump_frac` is omitted. */
export const DEFAULT_MAX_TAKER_BUMP_FRAC = 0.1;

/**
 * Dead zone for the proportional underbid guard, in ticks. On cheap markets a 1-tick move is a large
 * PERCENTAGE (0.03 → 0.02 is 33%) but not a real collapse, so the fractional rule only fires once the
 * drop also exceeds this many ticks. Collapses are large in both absolute and relative terms.
 */
export const UNDERBID_FRAC_DEAD_ZONE_TICKS = 2;

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

/** Relative cap used for the sell bump when `sell_bump` is set but `max_sell_bump_frac` is omitted. */
export const DEFAULT_MAX_SELL_BUMP_FRAC = 0.1;

/**
 * Sell limit price with the optional sell bump applied — the exit mirror of `applyTakerBump`. Posts
 * BELOW the bid so the order crosses and fills as a taker (sweeping resting bids that may vanish in a
 * fast market), but caps the bump to `maxFrac × bid` (so it can't give away more than a bounded slice
 * of price) and stays tick-aware: if rounding the bump DOWN to the tick would break the cap, it falls
 * back to `baseLimit` (post at the bid) rather than under-sell a whole tick. Returns `baseLimit`
 * unchanged when the bump is disabled, and never returns a non-positive price.
 */
export function applySellBump(
  bid: number,
  baseLimit: number,
  tick: TickSize,
  sellBump: number | undefined,
  maxSellBumpFrac: number | undefined
): number {
  if (sellBump === undefined || sellBump <= 0 || !(bid > 0)) {
    return baseLimit;
  }
  const frac = maxSellBumpFrac ?? DEFAULT_MAX_SELL_BUMP_FRAC;
  const cap = bid * frac;
  const effBump = Math.min(sellBump, cap);
  const bumped = roundToTick(bid - effBump, tick, "down");
  const minAllowed = bid * (1 - frac);
  if (bumped > 0 && bumped < baseLimit && bumped >= minAllowed - 1e-9) {
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
  const { event, outcome } = await resolveMarketLabelsFast(digest.tokenId);
  const msg = `copy skip · ${reasonDetail} · ${formatSkipSizing(sizing)} · event=${JSON.stringify(event)} outcome=${JSON.stringify(outcome)} · tx=${txHash}${targetTag(cfg)}`;
  console.log(msg);
  void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
}

/** ` · target=<addr> (<username>)` — appended to copy log lines so a mixed log shows which target each is for. */
function targetTag(cfg: CopyTradeConfig): string {
  return ` · target=${cfg.targetAddress}${cfg.username ? ` (${cfg.username})` : ""}`;
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
 * Tracks the USDC we POSTED (committed capital), not what filled — a resting/partial order still
 * ties up the cap, so posting is what must be counted. Buys ADD; full sells and cancels REFUND.
 *
 * PERSISTED to disk (atomic write-through) and reloaded on startup, so the cumulative cap survives
 * a bot restart. A market's bucket is only ever released by a sell/cancel refund or the long safety
 * TTL below — NOT by a short idle timer. (A previous 30-minute TTL wrongly reset the bucket between
 * entries that were >30 min apart, letting a $500 cap accumulate to $999 on one outcome.) The TTL is
 * now a 3-day backstop purely to prune stragglers from markets we held to resolution (never sold, so
 * never refunded) — far longer than any market's lifetime, so it can never reset an ACTIVE market.
 */
type SideSpendEntry = { spent: number; lastUpdated: number };
const sideSpendByTargetToken = new Map<string, SideSpendEntry>();
const SIDE_SPEND_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days — safety prune only, never resets a live market

function sideSpendPath(): string {
  return process.env["SIDE_SPEND_PATH"]?.trim() || "logs/side-spend.json";
}

let sideSpendLoaded = false;
/** Lazily load persisted buckets once, on first access (survives restart). */
function ensureSideSpendLoaded(): void {
  if (sideSpendLoaded) {
    return;
  }
  sideSpendLoaded = true;
  try {
    const raw = readFileSync(sideSpendPath(), "utf8");
    const obj = JSON.parse(raw) as Record<string, SideSpendEntry>;
    const now = Date.now();
    for (const [k, e] of Object.entries(obj)) {
      if (e && typeof e.spent === "number" && typeof e.lastUpdated === "number") {
        if (now - e.lastUpdated <= SIDE_SPEND_TTL_MS) {
          sideSpendByTargetToken.set(k, e);
        }
      }
    }
  } catch {
    // no file yet / unreadable → start empty
  }
}

/** Atomically persist the whole (small) map: write temp then rename, so a crash can't corrupt it. */
function persistSideSpend(): void {
  try {
    const obj: Record<string, SideSpendEntry> = {};
    for (const [k, e] of sideSpendByTargetToken) {
      obj[k] = e;
    }
    const p = sideSpendPath();
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, p);
  } catch {
    // best effort — an unwritable path must not break trading
  }
}

// ── New-wallet test-position guard ───────────────────────────────────────────────────────────────
// Defends against the fresh-wallet bait: a trader opens small "test" positions to lure copiers, then
// withdraws. Observed patterns share one signature — EVERY market he touches stays small (built from
// one or more trades: $47+$53=$100, or just $5), and he never makes a real-size position before pulling
// funds. So we aggregate his spend PER market and skip every trade in ANY market whose running total is
// below the threshold. The guard finishes (copies from then on) only when SOME market reaches the
// threshold — proof he's actually trading, not baiting. State is persisted so a restart resumes the
// current market's tally instead of re-arming.
export const DEFAULT_NEW_WALLET_MIN_USD = 150;

/** Per-target guard state. market = the market currently being tallied; cumUsd = his total in it; done = guard off. */
type NewWalletState = { market: string | null; cumUsd: number; done: boolean };
const newWalletState = new Map<string, NewWalletState>();
let newWalletLoaded = false;

function newWalletPath(): string {
  return process.env["NEW_WALLET_STATE_PATH"]?.trim() || "logs/new-wallet-guard.json";
}

function ensureNewWalletLoaded(): void {
  if (newWalletLoaded) {
    return;
  }
  newWalletLoaded = true;
  try {
    const obj = JSON.parse(readFileSync(newWalletPath(), "utf8")) as Record<string, Partial<NewWalletState>>;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object") {
        newWalletState.set(k.toLowerCase(), {
          market: typeof v.market === "string" ? v.market : null,
          cumUsd: Number(v.cumUsd) || 0,
          done: !!v.done,
        });
      }
    }
  } catch {
    // no file yet / unreadable → start empty
  }
}

function persistNewWallet(): void {
  try {
    const obj: Record<string, NewWalletState> = {};
    for (const [k, v] of newWalletState) {
      obj[k] = v;
    }
    const p = newWalletPath();
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, p);
  } catch {
    // best effort — an unwritable path must not break trading
  }
}

/**
 * Test-position guard decision for a BUY. Tallies the target's spend PER market (resetting when he
 * moves to a new market) and returns whether to SKIP this trade — i.e. the current market's running
 * total is still below the threshold — plus that total for logging. The guard turns off permanently
 * only when SOME market reaches the threshold (a real position). Every small market before that is
 * fully skipped. Mutates + persists per-target state.
 */
function newWalletTestGuardDecision(
  target: string,
  marketKey: string,
  tradeUsd: number,
  minUsd: number
): { skip: boolean; cumUsd: number } {
  ensureNewWalletLoaded();
  const key = target.toLowerCase();
  let st = newWalletState.get(key);
  if (!st) {
    st = { market: null, cumUsd: 0, done: false };
    newWalletState.set(key, st);
  }
  if (st.done) {
    return { skip: false, cumUsd: st.cumUsd };
  }
  if (marketKey !== st.market) {
    // New market → start a fresh per-market tally (the guard spans every market, not just the first).
    st.market = marketKey;
    st.cumUsd = 0;
  }
  st.cumUsd += tradeUsd;
  if (st.cumUsd >= minUsd) {
    // This market reached a real size — proof he's trading, not baiting. Copy it and disable the guard.
    st.done = true;
    persistNewWallet();
    return { skip: false, cumUsd: st.cumUsd };
  }
  persistNewWallet();
  return { skip: true, cumUsd: st.cumUsd };
}

// ── Safe-sell (protective take-profit) ─────────────────────────────────────────────────────────────
// When `safe_sell` is set, each copied BUY that fills gets a resting GTC SELL at that price (e.g. 0.99)
// — a maker order (no fee) that locks the value if the price spikes there, dodging the 99c->1c flip. If
// the target sells first, the resting order(s) are cancelled and his sell is copied. Order ids are held
// in memory per (target, tokenId); not persisted — the startup GTC cleanup cancels orphans after a
// restart (a SELL at a safe_sell price), so a stale protective order can't linger.
const safeSellOrdersByTargetToken = new Map<string, string[]>();

function safeSellKey(target: string, tokenId: string): string {
  return `${target.toLowerCase()}|${tokenId}`;
}

/** Post a resting protective sell for a just-filled copy buy. Best-effort — never throws to the caller. */
async function placeSafeSell(
  cfg: CopyTradeConfig,
  client: ClobClient,
  tokenId: string,
  shares: number,
  tick: TickSize,
  negRisk: boolean,
  minOrder: number,
  txHash: string
): Promise<void> {
  if (cfg.safeSell === undefined || !(shares > 0) || shares < minOrder) {
    return; // feature off, nothing filled, or below the market's share floor
  }
  const price = roundToTick(cfg.safeSell, tick, "down");
  if (!(price > 0) || price >= 1) {
    return;
  }
  try {
    const resp = await client.createAndPostOrder(
      { tokenID: tokenId, price, side: Side.SELL, size: shares },
      { tickSize: tick, negRisk },
      OrderType.GTC
    );
    const err = postErrorMessage(resp);
    const orderId = (resp as { orderID?: string })?.orderID;
    if (err || !orderId) {
      const warn = `safe-sell REJECTED · ${shares} @ ${price} · token=${tokenId} · ${JSON.stringify(err ?? "no orderID")} · tx=${txHash}`;
      console.warn(warn);
      void appendCopyTradeSuccessLine(warn, cfg.copyTradeLogPath);
      return;
    }
    const key = safeSellKey(cfg.targetAddress, tokenId);
    const list = safeSellOrdersByTargetToken.get(key) ?? [];
    list.push(orderId);
    safeSellOrdersByTargetToken.set(key, list);
    const msg = `safe-sell posted · ${shares} sh @ ${price} (resting take-profit) · token=${tokenId} · tx=${txHash}`;
    console.log(msg);
    void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
  } catch (e) {
    const warn = `safe-sell post failed · token=${tokenId}: ${e instanceof Error ? e.message : String(e)} · tx=${txHash}`;
    console.warn(warn);
    void appendCopyTradeSuccessLine(warn, cfg.copyTradeLogPath);
  }
}

/** Cancel all resting safe-sell orders for a (target, tokenId) so the shares are freed for a copy sell. */
async function cancelSafeSells(cfg: CopyTradeConfig, client: ClobClient, tokenId: string): Promise<void> {
  const key = safeSellKey(cfg.targetAddress, tokenId);
  const ids = safeSellOrdersByTargetToken.get(key);
  if (!ids || ids.length === 0) {
    return;
  }
  safeSellOrdersByTargetToken.delete(key);
  for (const id of ids) {
    try {
      await client.cancelOrder({ orderID: id });
    } catch {
      // already filled / cancelled / gone — nothing to free
    }
  }
  const msg = `safe-sell cancelled ${ids.length} resting order(s) · token=${tokenId} (target sold / exiting)`;
  console.log(msg);
  void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
}

setInterval(() => {
  ensureSideSpendLoaded();
  const now = Date.now();
  let changed = false;
  for (const [k, e] of sideSpendByTargetToken) {
    if (now - e.lastUpdated > SIDE_SPEND_TTL_MS) {
      sideSpendByTargetToken.delete(k);
      changed = true;
    }
  }
  if (changed) {
    persistSideSpend();
  }
}, 60 * 60 * 1000).unref(); // hourly sweep (TTL is 3 days, so no need to run often)

function sideSpendKey(targetAddress: string, tokenId: string): string {
  return `${targetAddress.toLowerCase()}:${tokenId}`;
}

function getSideSpent(targetAddress: string, tokenId: string): number {
  ensureSideSpendLoaded();
  const e = sideSpendByTargetToken.get(sideSpendKey(targetAddress, tokenId));
  if (!e) {
    return 0;
  }
  if (Date.now() - e.lastUpdated > SIDE_SPEND_TTL_MS) {
    sideSpendByTargetToken.delete(sideSpendKey(targetAddress, tokenId));
    persistSideSpend();
    return 0;
  }
  return e.spent;
}

/**
 * Adds (positive) or refunds (negative) USDC to a side's spend bucket. Refunds clamp at 0
 * to avoid going negative when our internal accounting drifts from reality (e.g., a cancel
 * races with a fill and we slightly over-refund). Write-through persisted on every change.
 */
function addSideSpent(targetAddress: string, tokenId: string, usdcDelta: number): void {
  ensureSideSpendLoaded();
  const k = sideSpendKey(targetAddress, tokenId);
  const e = sideSpendByTargetToken.get(k);
  const newSpent = Math.max(0, (e?.spent ?? 0) + usdcDelta);
  sideSpendByTargetToken.set(k, {
    spent: newSpent,
    lastUpdated: Date.now(),
  });
  persistSideSpend();
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

/**
 * One copy ("main") order posted by THIS target in this market. Fill status is read per-order via
 * getOrder().size_matched — never from the wallet balance, which aggregates every target.
 */
type MainOrder = {
  tokenId: string;
  side: "buy" | "sell";
  /** Shares submitted, used to decide when the order is fully done and can stop being polled. */
  postedSize: number;
  /** Last known size_matched. Monotonic per order; a failed read keeps the previous value. */
  matched: number;
  /** Fully matched, cancelled, or dry-run — stop polling it. */
  terminal: boolean;
};

type MarketHedgeState = {
  conditionId: string;
  /** Lowercase address of the ONE target this state belongs to. */
  targetKey: string;
  tokenA: string;
  tokenB: string;
  /**
   * Effective shares held per tokenId FOR THIS TARGET. Derived — recomputed by recomputeShares()
   * from mainOrders + absorbedByToken. Never write to it directly.
   */
  sharesByToken: Map<string, number>;
  /** This target's own copy orders in this market, by orderId. The sole source of fill truth. */
  mainOrders: Map<string, MainOrder>;
  /** Shares acquired via matched HEDGE fills, per tokenId — added on top of the order-derived count. */
  absorbedByToken: Map<string, number>;
  /** Currently-resting hedge order (or null if no resting hedge). */
  hedge: HedgeRest | null;
  /** cfg of this state's target — used by the poller for hedge_price/cap. */
  cfg: CopyTradeConfig;
  /** ms of last activity (copy or poll-detected change) — for TTL eviction from the poll set. */
  lastActivityMs: number;
  /** Per-(target,condition) async mutex (chained promise) so copy- and poll-triggered reconciles serialize. */
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

/**
 * Keyed by `<target>|<conditionId>` so each target hedges ONLY its own position. Keying by condition
 * alone (with wallet-balance polling) let an unhedged target's shares in the same market inflate a
 * hedged target's imbalance and post a wildly oversized hedge.
 * Resets on process restart (5m markets resolve before restart gaps matter).
 */
const hedgeStateByTargetCondition = new Map<string, MarketHedgeState>();

function hedgeStateKey(targetAddress: string, conditionId: string): string {
  return `${targetAddress.toLowerCase()}|${conditionId}`;
}

const HEDGE_POLL_INTERVAL_MS = 8_000;
const HEDGE_STATE_TTL_MS = 15 * 60_000;

/**
 * Recompute this target's effective shares per token:
 *   shares(token) = Σ(buy.matched) − Σ(sell.matched)   (clamped ≥ 0)   + hedge-absorbed shares
 * Derived from per-order fills only, so another target trading the same market cannot affect it.
 */
function recomputeShares(state: MarketHedgeState): void {
  const net = new Map<string, number>();
  for (const o of state.mainOrders.values()) {
    const cur = net.get(o.tokenId) ?? 0;
    net.set(o.tokenId, cur + (o.side === "buy" ? o.matched : -o.matched));
  }
  state.sharesByToken = new Map();
  for (const token of [state.tokenA, state.tokenB]) {
    const derived = Math.max(0, net.get(token) ?? 0);
    const absorbed = state.absorbedByToken.get(token) ?? 0;
    state.sharesByToken.set(token, derived + absorbed);
  }
}

/** Track a newly posted copy order and refresh derived shares. */
function registerMainOrder(
  state: MarketHedgeState,
  orderId: string,
  tokenId: string,
  side: "buy" | "sell",
  postedSize: number,
  matchedNow: number
): void {
  if (orderId === "DRY_RUN") {
    // Dry run: no CLOB order exists, so pretend it filled fully — that is what the simulated
    // hedge is meant to reflect. Unique key so repeated dry-run copies accumulate.
    state.mainOrders.set(`DRY_RUN:${tokenId}:${side}:${state.mainOrders.size}`, {
      tokenId,
      side,
      postedSize,
      matched: postedSize,
      terminal: true,
    });
  } else if (orderId === "") {
    // Real order but the response carried no id: we can never poll it. Record ONLY what we saw fill
    // immediately and mark terminal. Must NOT assume a full fill — that would hedge phantom shares.
    state.mainOrders.set(`UNTRACKED:${tokenId}:${side}:${state.mainOrders.size}`, {
      tokenId,
      side,
      postedSize,
      matched: matchedNow,
      terminal: true,
    });
    console.warn(`hedge · copy order for token=${tokenId} came back without an orderID — late fills for it cannot be tracked`);
  } else {
    state.mainOrders.set(orderId, {
      tokenId,
      side,
      postedSize,
      matched: matchedNow,
      terminal: matchedNow >= postedSize - 1e-9,
    });
  }
  recomputeShares(state);
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
 * Background poller (Part 2-B): every HEDGE_POLL_INTERVAL_MS, walk active LIVE (target, condition)
 * states and re-read the fill status of THIS TARGET'S OWN copy orders via getOrder().size_matched.
 * Catches late fills of resting copy orders that the post response alone would miss.
 *
 * Deliberately per-order, NOT wallet-balance based: the wallet balance sums every target's shares in
 * the market, which would size one target's hedge off another target's position. Fully matched /
 * cancelled orders go terminal and stop being polled, bounding the call count.
 *
 * Dry-run states are skipped — they have no real orders on CLOB.
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, state] of hedgeStateByTargetCondition) {
    if (now - state.lastActivityMs > HEDGE_STATE_TTL_MS) {
      hedgeStateByTargetCondition.delete(key);
      continue;
    }
    if (state.cfg.dryRun) {
      continue; // dry-run states have no real CLOB orders to poll
    }
    const pending = [...state.mainOrders.entries()].filter(([, o]) => !o.terminal);
    if (pending.length === 0) {
      continue; // nothing left that could still fill
    }
    void runExclusive(state, async () => {
      const client = await ensureClobClient(state.cfg);
      let changed = false;
      for (const [orderId, o] of pending) {
        const matched = await readOrderMatched(client, orderId);
        if (matched === null) {
          // Transient read failure or an order the API no longer returns. KEEP the last known
          // matched value — zeroing here would collapse the position and cancel a live hedge.
          continue;
        }
        if (matched > o.matched + 1e-9) {
          o.matched = matched;
          changed = true;
        }
        if (o.matched >= o.postedSize - 1e-9) {
          o.terminal = true;
        }
      }
      if (!changed) {
        return;
      }
      const prev = new Map(state.sharesByToken);
      recomputeShares(state);
      state.lastActivityMs = Date.now();
      const shown = [state.tokenA, state.tokenB]
        .map((t) => `${t.slice(0, 8)}…=${(state.sharesByToken.get(t) ?? 0).toFixed(2)}(was ${(prev.get(t) ?? 0).toFixed(2)})`)
        .join(" ");
      const poll = `position poll · target=${state.cfg.targetAddress} condition=${state.conditionId} shares ${shown} · late copy fill detected`;
      console.log(poll);
      void appendCopyTradeSuccessLine(poll, state.cfg.copyTradeLogPath);
      // reconcileHedge self-gates on hedge_price — a no-op for non-hedged targets, so the poll just
      // keeps their position accurate (for proportional sells) without touching any hedge.
      await reconcileHedge(state.cfg, client, state, "poller");
    }).catch((e) => {
      console.warn(`hedge poll error · ${key}: ${e instanceof Error ? e.message : String(e)}`);
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
 * Returns the matched portion of an order (`size_matched`) — the authoritative per-order fill.
 * Used for BOTH the resting hedge and this target's main copy orders.
 *
 * null means "unknown" (network error, or the API no longer returns a completed order). Callers must
 * treat null as "keep the previous value", never as zero: a transient failure must not be able to
 * erase a real position and trigger a hedge cancel.
 *
 * For the hedge specifically, the "treat partial fills as fully done" policy means even one share
 * matched counts as filled.
 */
async function readOrderMatched(client: ClobClient, orderId: string): Promise<number | null> {
  if (orderId === "DRY_RUN" || orderId.startsWith("DRY_RUN:")) {
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

/** Default hedge size as a fraction of the filled main position (1.0 = fully balance the position). */
export const DEFAULT_HEDGE_TOKEN_PERCENT = 1;

/** Hedge shares still needed = target (percent × main) minus what's already held on the hedge side. */
export function idealHedgeSize(mainShares: number, hedgeHeld: number, percent: number): number {
  if (!(mainShares > 0)) {
    return 0;
  }
  return mainShares * percent - hedgeHeld;
}

/**
 * Compute the ideal hedge: a GTC BUY on the side OPPOSITE the target's main, sized to
 * `hedge_token_percent × (filled main position)`, minus any hedge shares already held. Returns null
 * when no more hedge is needed.
 *
 * Direction (which side is "main") comes from the COPIED position (mainOrders), NOT total shares —
 * filled hedge shares inflate the hedge side and must never be mistaken for the target's direction.
 * This is what prevents the runaway "hedge > main" we saw: once the hedge side reaches percent × main
 * it stops, and it never flips to hedging the main side just because the hedge over-filled.
 */
function computeIdealHedge(state: MarketHedgeState, hedgePrice: number, hedgePercent: number): HedgeRest | null {
  const copied = new Map<string, number>();
  for (const o of state.mainOrders.values()) {
    copied.set(o.tokenId, (copied.get(o.tokenId) ?? 0) + (o.side === "buy" ? o.matched : -o.matched));
  }
  const cA = Math.max(0, copied.get(state.tokenA) ?? 0);
  const cB = Math.max(0, copied.get(state.tokenB) ?? 0);
  const mainShares = Math.max(cA, cB);
  const hedgeToken = cA >= cB ? state.tokenB : state.tokenA; // opposite the target's main
  const hedgeHeld = state.sharesByToken.get(hedgeToken) ?? 0; // incl. already-filled hedge shares
  const size = idealHedgeSize(mainShares, hedgeHeld, hedgePercent);
  if (size <= 0) {
    return null;
  }
  return { orderId: "", tokenId: hedgeToken, price: hedgePrice, size };
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
  const ideal = computeIdealHedge(state, cfg.hedgePrice, cfg.hedgeTokenPercent ?? DEFAULT_HEDGE_TOKEN_PERCENT);

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
  const key = hedgeStateKey(cfg.targetAddress, opp.conditionId);
  let state = hedgeStateByTargetCondition.get(key);
  if (!state) {
    state = {
      conditionId: opp.conditionId,
      targetKey: cfg.targetAddress.toLowerCase(),
      tokenA: primaryTokenId,
      tokenB: opp.oppositeTokenId,
      sharesByToken: new Map(),
      mainOrders: new Map(),
      absorbedByToken: new Map(),
      hedge: null,
      cfg,
      lastActivityMs: Date.now(),
      reconcileChain: Promise.resolve(),
      absorbedSideByTarget: new Map(),
    };
    hedgeStateByTargetCondition.set(key, state);
  } else {
    // Same target — refresh its cfg (params may have been reloaded) and keep the poller alive.
    state.cfg = cfg;
    state.lastActivityMs = Date.now();
  }
  return state;
}

/**
 * This target's tracked filled position (shares) for an outcome token — the shares filled from
 * copying THIS target specifically, isolated from other targets that share the same wallet/market.
 * Derived from per-order fills (getOrder), kept current by the poller. Null when there's no tracked
 * state yet (before the first copy, or across a restart) — caller should fall back to the wallet
 * balance in that case.
 */
async function getTargetPosition(cfg: CopyTradeConfig, tokenId: string): Promise<number | null> {
  const info = await resolveMarketTokens(tokenId);
  if (!info) {
    return null;
  }
  const state = hedgeStateByTargetCondition.get(hedgeStateKey(cfg.targetAddress, info.conditionId));
  if (!state) {
    return null;
  }
  return state.sharesByToken.get(tokenId) ?? 0;
}

/**
 * Record a successful BUY copy in this target's position state (additive to sharesByToken, using
 * ACTUAL filled shares). Runs for EVERY target — the per-target position feeds proportional sells,
 * and (when hedge_price is set) the hedge. Serialized per-condition via the mutex vs the poller.
 */
async function recordCopyBuyAndReconcile(
  cfg: CopyTradeConfig,
  client: ClobClient,
  primaryTokenId: string,
  filledShares: number,
  txHash: string,
  orderId: string,
  postedShares: number
): Promise<void> {
  const state = await getOrCreateHedgeState(cfg, primaryTokenId);
  if (!state) {
    const warn = `hedge · could not resolve opposite token for tokenId=${primaryTokenId} · tx=${txHash}`;
    console.warn(warn);
    void appendCopyTradeSuccessLine(warn, cfg.copyTradeLogPath);
    return;
  }

  await runExclusive(state, async () => {
    // Track the order itself, not just its immediate fill: a resting GTC buy posts with
    // filledShares=0 and only fills later — the poller reads size_matched for it from here on.
    registerMainOrder(state, orderId, primaryTokenId, "buy", postedShares, filledShares);
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
  txHash: string,
  orderId: string,
  postedShares: number,
  /**
   * Shares already sold by reprice attempts whose orders were cancelled (no longer on the book).
   * Registered as a single terminal entry so the derived position reflects them but the poller
   * never re-checks a dead order. Default 0 (single-post sell, no reprice).
   */
  terminalPriorFill = 0
): Promise<void> {
  const state = await getOrCreateHedgeState(cfg, soldTokenId);
  if (!state) {
    return; // opposite token unresolvable — can't track; nothing to do
  }

  await runExclusive(state, async () => {
    // Reprice attempts that already filled and were cancelled: terminal, untrackable — record once.
    if (terminalPriorFill > 1e-9) {
      state.mainOrders.set(`SELL_REPRICED:${soldTokenId}:${state.mainOrders.size}`, {
        tokenId: soldTokenId,
        side: "sell",
        postedSize: terminalPriorFill,
        matched: terminalPriorFill,
        terminal: true,
      });
    }
    // Sells are tracked as orders too, so a resting sell that fills later reduces the derived
    // position on the next poll and the now-oversized hedge is resized. Skip when the remainder was
    // abandoned (no resting order and nothing filled) — the terminal entry above already covers it.
    if (orderId !== "" || sharesSold > 1e-9) {
      registerMainOrder(state, orderId, soldTokenId, "sell", postedShares, sharesSold);
    } else {
      recomputeShares(state);
    }
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
  // This target's own state only — another target's hedge activity must never gate this trade.
  const state = hedgeStateByTargetCondition.get(hedgeStateKey(cfg.targetAddress, info.conditionId));
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
  // This target's own state only — never inspect or cancel another target's hedge.
  const state = hedgeStateByTargetCondition.get(hedgeStateKey(cfg.targetAddress, info.conditionId));
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

    const matched = await readOrderMatched(client, hedge.orderId);
    if (matched !== null && matched > 0) {
      // Treat as fully done: roll matched portion into held shares, cancel the unmatched remainder.
      await safeCancel(client, hedge.orderId, cfg, "matched-but-cleanup-remainder");
      const unmatchedShares = Math.max(0, hedge.size - matched);
      if (unmatchedShares > 0) {
        addSideSpent(cfg.targetAddress, hedge.tokenId, -(unmatchedShares * hedge.price));
      }
      // Into absorbedByToken (not sharesByToken) — the latter is derived and would be recomputed away.
      const existingAbsorbed = state.absorbedByToken.get(hedge.tokenId) ?? 0;
      state.absorbedByToken.set(hedge.tokenId, existingAbsorbed + matched);
      recomputeShares(state);
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
/**
 * On restart, cancel only STALE HEDGE orders — never copy orders. Hedges lose their in-memory
 * tracking across a restart and could double-hedge / create unexpected exposure, so they must go;
 * but resting COPY orders (from ANY target) are left alone so a restart doesn't wipe them.
 *
 * A hedge is identified by the P&L ledger (`isHedge` for that orderId) and, as a fallback for
 * orders not in the ledger, a BUY resting at one of the configured `hedgePrices`.
 */
export async function cancelAllStaleGtcOrders(
  cfg: CopyTradeConfig,
  hedgePrices: number[] = [],
  safeSellPrices: number[] = []
): Promise<void> {
  try {
    const client = await ensureClobClient(cfg);
    const orders = await client.getOpenOrders();
    if (!Array.isArray(orders) || orders.length === 0) {
      console.log("startup: no pre-existing open orders to clean up");
      return;
    }
    const ledger = await readLedger();
    const hedgeIds = new Set(ledger.filter((r) => r.isHedge).map((r) => r.orderId));
    // Stale = a hedge order (ledger-tagged, or a BUY at a hedge price) OR an orphan safe-sell (a SELL at
    // a safe_sell price) left resting from a prior run — the in-memory id tracking resets on restart.
    const isHedgeOrder = (o: { id?: string; side?: string; price?: string }): boolean => {
      if (o.id && hedgeIds.has(o.id)) {
        return true;
      }
      const side = (o.side ?? "").toUpperCase();
      const p = parseFloat(o.price ?? "");
      if (side === "BUY" && Number.isFinite(p) && hedgePrices.some((hp) => Math.abs(hp - p) < 1e-9)) {
        return true;
      }
      if (side === "SELL" && Number.isFinite(p) && safeSellPrices.some((sp) => Math.abs(sp - p) < 1e-9)) {
        return true;
      }
      return false;
    };

    const hedges = orders.filter(isHedgeOrder);
    if (hedges.length === 0) {
      console.log(`startup: ${orders.length} open order(s), none are stale hedge/safe-sell — leaving all copy orders resting`);
      return;
    }
    console.log(
      `startup: cancelling ${hedges.length} stale hedge/safe-sell order(s); leaving ${orders.length - hedges.length} copy order(s) resting`
    );
    for (const o of hedges) {
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
    console.log("startup: hedge cleanup done");
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
      const labels = await resolveMarketLabelsFast(args.tokenId);
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

  // Market filter (ALLOWLIST): copy ONLY the configured crypto assets (e.g. btc). The asset is read
  // from the prewarm cache ONLY (network-free) — never a gamma call on the hot path. Copy only on a
  // cache HIT whose asset is in the allowlist; SKIP everything else — other coins, non-crypto markets,
  // and anything not in the cache (unknown). This is deliberate: when copying a fresh/unknown wallet
  // you don't know what it will trade, so only confirmed-asset trades should go through. The prewarm
  // reliably holds every live crypto market for the next ~2h, so a real btc trade is a hit in practice.
  if (cfg.marketFilter && cfg.marketFilter.length > 0) {
    const asset = lookupCryptoMarket(digest.tokenId)?.asset;
    if (!asset || !cfg.marketFilter.includes(asset)) {
      await logCopySkip(
        `market filter · asset=${asset ?? "unknown"} not in [${cfg.marketFilter.join(",")}] · token=${digest.tokenId}`,
        digest,
        txHash,
        cfg
      );
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

  // New-wallet test-position guard: the fresh-wallet bait opens small positions (one or more trades per
  // market — $47+$53=$100, or just $5) across several markets, then withdraws. We tally his spend PER
  // market and skip every trade in ANY market whose running total stays below the threshold, for every
  // market — until SOME market reaches the threshold (proof he's trading), after which we copy normally.
  // Buys only — a sell can't precede a position, and if we skipped the buys a copied sell finds nothing.
  // Market key is the prewarm cache's market name (both Up/Down tokens share it), network-free; falls
  // back to the tokenId on a cache miss. Uses HIS spend (originPusd), independent of copy_ratio.
  if (cfg.newWallet && digest.side === "buy") {
    const minUsd = cfg.newWalletMinUsd ?? DEFAULT_NEW_WALLET_MIN_USD;
    const marketKey = lookupCryptoMarket(digest.tokenId)?.event ?? `token:${digest.tokenId}`;
    const d = newWalletTestGuardDecision(cfg.targetAddress, marketKey, originPusd, minUsd);
    if (d.skip) {
      await logCopySkip(
        `new-wallet guard · test market total $${d.cumUsd.toFixed(2)} < $${minUsd} (possible bait) · token=${digest.tokenId}`,
        digest,
        txHash,
        cfg,
        { copyUsd: originPusd * cfg.copyRatio, implied }
      );
      return;
    }
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

  // Safe-sell: the target is exiting, so cancel our resting protective sell(s) FIRST — this frees the
  // escrowed shares back to the wallet balance before the sell path reads it (sellReads, below), so the
  // copied sell can size against the full position. Done here (before the book/balance fetch) for sells.
  if (digest.side === "sell" && cfg.safeSell !== undefined) {
    await cancelSafeSells(cfg, client, digest.tokenId);
  }

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
  // Prefer the real-time tick from the PolyNode settlement (digest.tickSize) — it's the market's
  // actual tick at trade time, so the order prices correctly on the FIRST post. Only fall back to the
  // CLOB lookup on the on-chain detection path (no settlement tick). Seed the cache with the
  // authoritative value so the hedge path and any fallback use it too.
  if (digest.tickSize) {
    tickSizeByToken.set(digest.tokenId, digest.tickSize);
  }
  // Sell-path reads (our balance, the target's on-chain balance, our tracked position) are independent
  // of the order book and of each other. Start them NOW so they run concurrently with the book fetch
  // instead of sequentially after it — cutting a sell's time-to-post from ~4 round-trips to ~1. They're
  // read-only, so firing them before the (rare) empty-book/empty-bids skip only wastes throwaway work.
  // Each is made non-rejecting so an early return before they're awaited can't orphan a rejection.
  const sellReads =
    digest.side === "sell"
      ? {
          bal: client
            .getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: digest.tokenId })
            .catch(() => null),
          targetBefore: fetchTargetTokenBalance(cfg, cfg.targetAddress, digest.tokenId), // already catches → null
          tracked: getTargetPosition(cfg, digest.tokenId), // never rejects (reads local state)
        }
      : null;
  const [tickSize, negRisk, book] = await Promise.all([
    digest.tickSize ?? getTickSizeCached(client, digest.tokenId),
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
  let takerBumpNote = ""; // shows in the copy-posted/dry-run log whether the taker bump was applied
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
    // PROPORTIONAL underbid guard. The absolute cap above can't separate "target bought cheap" from
    // "price collapsed since the target bought", because the same absolute gap means different things
    // at different entry prices (0.29 is routine from 0.60 but catastrophic from 0.30). Measuring the
    // drop as a FRACTION of the target's entry scales the tolerance with the entry price:
    //   entry 0.60 → 0.01 = 98% drop → skip      entry 0.30 → 0.01 = 97% drop → skip
    //   entry 0.01 → 0.01 =  0% drop → COPY (a genuine cheap entry, which a price floor would reject)
    // Guarded by a tick-sized dead zone so ordinary 1-tick noise on cheap markets can't trip it.
    if (cfg.maxUnderbidFrac !== undefined && effectiveImplied > 0 && drift < 0) {
      const dropFrac = -drift / effectiveImplied;
      const deadZone = (parseFloat(tickSize) || 0) * UNDERBID_FRAC_DEAD_ZONE_TICKS;
      if (dropFrac > cfg.maxUnderbidFrac && -drift > deadZone) {
        const floor = effectiveImplied * (1 - cfg.maxUnderbidFrac);
        await logCopySkip(
          `underbid frac skip · implied(on-chain)=${effectiveImplied.toFixed(4)} effective=${effectivePrice.toFixed(4)} clobMid=${currentPrice.toFixed(4)} bestAsk=${ask.toFixed(4)} drop=${(dropFrac * 100).toFixed(1)}% maxUnderbidFrac=${cfg.maxUnderbidFrac} (floor=${floor.toFixed(4)})${flushedFromBufferCount > 0 ? ` · flushedFromBuffer=${flushedFromBufferCount}` : ""}`,
          digest,
          txHash,
          cfg,
          { copyUsd: clippedUsdc ?? undefined, implied: effectiveImplied }
        );
        return;
      }
    }

    const baseLimit = roundToTick(effectivePrice, tickSize, "up");
    // Taker bump (fill improvement): cross above the ask so the order fills, capped relative to price
    // and tick-aware. After the drift check (option B), before the buy_price bounds below.
    limitPrice = applyTakerBump(ask, baseLimit, tickSize, cfg.takerBump, cfg.maxTakerBumpFrac);
    if (cfg.takerBump !== undefined && cfg.takerBump > 0) {
      takerBumpNote =
        limitPrice > baseLimit
          ? ` · takerBump=+${(limitPrice - baseLimit).toFixed(4)} (ask=${ask.toFixed(4)} base=${baseLimit.toFixed(4)}→${limitPrice.toFixed(4)})`
          : ` · takerBump=none (ask=${ask.toFixed(4)} base=${baseLimit.toFixed(4)}; cap/tick blocked)`;
    }

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
    // Sells: no drift check (per design). Price to top of book, then optionally cross BELOW the bid
    // (sell_bump) so the exit fills as a taker instead of resting on a bid that can vanish in a fast
    // market. The reprice loop after the post chases the bid down further if this still doesn't fill.
    const bid = bestBid(book);
    if (bid === null) {
      await logCopySkip("empty bids", digest, txHash, cfg, { implied: effectiveImplied });
      return;
    }
    const baseSellLimit = roundToTick(Math.min(currentPrice, bid), tickSize, "down");
    limitPrice = applySellBump(bid, baseSellLimit, tickSize, cfg.sellBump, cfg.maxSellBumpFrac);
  }

  // Buy: size from clipped notional. Sell: immediately liquidate full token balance.
  let orderShares: number;
  let sellFraction = 1; // fraction of OUR position a sell trims (1 = full exit); used for the bucket below
  if (digest.side === "buy") {
    orderShares = (clippedUsdc ?? 0) / limitPrice;
  } else {
    // Pre-started concurrently with the book fetch (see sellReads above) — these awaits resolve
    // in-flight results, not fresh sequential round-trips.
    const bal = await sellReads!.bal;
    /** CLOB returns conditional balance in raw 6-decimal units; `createAndPostOrder` size is decimal shares (same scale as buys). */
    let fullBalance: number;
    try {
      fullBalance = parseFloat(formatUnits(BigInt(String(bal?.balance)), 6));
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
    // Proportional partial sell: sell the same FRACTION of OUR position that the target sold of theirs.
    //   fraction    = target's sold shares / target's holding before the sell (read on-chain; pending
    //                 detection means their tx hasn't settled, so it's the pre-sell balance).
    //   ourPosition = shares filled from THIS target only (tracked per-order), NOT the wallet total —
    //                 so a sell never touches shares another target filled in the same market. Capped
    //                 by the real wallet balance (can't sell more than the wallet holds). Falls back to
    //                 the wallet balance only when there's no tracked state (e.g. across a restart).
    const targetBefore = await sellReads!.targetBefore;
    const tracked = await sellReads!.tracked;
    const ourPosition = tracked === null ? fullBalance : Math.min(tracked, fullBalance);
    orderShares = proportionalSellShares(originShares, targetBefore, ourPosition);
    sellFraction = ourPosition > 0 ? orderShares / ourPosition : 1;
    const sellNote =
      `sell sizing · target sold ${originShares.toFixed(2)} of ${targetBefore === null ? "?" : targetBefore.toFixed(2)} held ` +
      `(${(sellFraction * 100).toFixed(1)}%) → selling ${orderShares.toFixed(2)} of THIS target's ` +
      `${tracked === null ? `wallet ${fullBalance.toFixed(2)}` : `${ourPosition.toFixed(2)}`} (wallet ${fullBalance.toFixed(2)}) · token=${digest.tokenId}`;
    console.log(sellNote);
    void appendCopyTradeSuccessLine(sellNote, cfg.copyTradeLogPath);
    if (orderShares <= 0) {
      await logCopySkip(`nothing to sell for this target · token=${digest.tokenId}`, digest, txHash, cfg, {
        limitPrice,
        implied: effectiveImplied,
      });
      return;
    }
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
    const { event, outcome } = await resolveMarketLabelsFast(digest.tokenId);
    const pUsdForLog = digest.side === "buy" ? (clippedUsdc ?? 0) : originPusd;
    const flushSuffix = flushedFromBufferCount > 0 ? ` · flushedFromBuffer=${flushedFromBufferCount}` : "";
    const msg =
      `[DRY RUN] would post GTC · side=${digest.side} shares=${orderShares} pUSD=${pUsdForLog.toFixed(6)} · event=${JSON.stringify(event)} outcome=${JSON.stringify(outcome)} · tokenID=${digest.tokenId} limitPrice=${limitPrice} tickSize=${tickSize} negRisk=${negRisk} · implied=${effectiveImplied.toFixed(4)}${takerBumpNote} · tx=${txHash}${flushSuffix}`;
    console.log(msg);
    void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
    // Fill simulation (dry-run only): track how this order would fill against real live market flow.
    try {
      registerSimOrder({
        tokenId: digest.tokenId,
        side: digest.side,
        limitPrice,
        size: orderShares,
        book,
        targetAddress: cfg.targetAddress,
        logPath: cfg.copyTradeLogPath ?? "logs/sim.log",
        event,
        outcome,
        txHash,
      });
    } catch (e) {
      console.warn(`[SIM] register failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Reservation for buys was already committed atomically above (max_market_usdc block).
    if (digest.side === "buy") {
      // Dry run: no real order exists, so pass DRY_RUN — registerMainOrder treats it as fully filled.
      await recordCopyBuyAndReconcile(cfg, client, digest.tokenId, orderShares, txHash, "DRY_RUN", orderShares);
    } else {
      const spent = getSideSpent(cfg.targetAddress, digest.tokenId);
      addSideSpent(cfg.targetAddress, digest.tokenId, -(sellFraction * spent));
      if (sellFraction >= 0.999) {
        clearSkipBuffer(cfg.targetAddress, digest.tokenId);
      }
    }
    return;
  }

  let postPrice = limitPrice;
  let postTick: TickSize = tickSize;
  const postOnce = (price: number, tk: TickSize, size: number = orderShares) =>
    client.createAndPostOrder(
      { tokenID: digest.tokenId, price, side, size },
      { tickSize: tk, negRisk },
      OrderType.GTC
    );

  let resp;
  try {
    resp = await postOnce(postPrice, postTick);
    // Self-heal a too-fine tick: the CLOB tells us the real tick in the error. Correct the cache,
    // re-round the price to it (buys down toward the ask, sells up toward the bid — still crosses,
    // no overpay), and retry ONCE. Otherwise a low-price copy is silently lost to a 400.
    const correctedTick = tickSizeFromError(resp);
    if (correctedTick && correctedTick !== postTick) {
      tickSizeByToken.set(digest.tokenId, correctedTick);
      const newPrice = roundToTick(postPrice, correctedTick, digest.side === "buy" ? "down" : "up");
      if (newPrice > 0 && Math.abs(newPrice - postPrice) > 1e-12) {
        const note = `tick-size retry · token=${digest.tokenId} tick ${postTick}→${correctedTick} · price ${postPrice}→${newPrice} · tx=${txHash}`;
        console.warn(note);
        void appendCopyTradeSuccessLine(note, cfg.copyTradeLogPath);
        postPrice = newPrice;
        postTick = correctedTick;
        resp = await postOnce(postPrice, postTick);
      }
    }
  } catch (e) {
    // Post failed after we reserved — release the reservation so a failed order doesn't
    // permanently consume max_market_usdc capacity. This is the only refund path.
    if (reservedUsdc > 0) {
      addSideSpent(cfg.targetAddress, digest.tokenId, -reservedUsdc);
    }
    throw e;
  }
  limitPrice = postPrice; // reflect any tick-retry adjustment in the logs/ledger below

  // A rejected order (error / 4xx in the response, not a throw) is NOT on the book — do not log it as
  // "posted", do not record it for P&L, and release the max_market_usdc reservation so a rejection
  // can't permanently consume the cap.
  const postErr = postErrorMessage(resp);
  if (postErr) {
    if (reservedUsdc > 0) {
      addSideSpent(cfg.targetAddress, digest.tokenId, -reservedUsdc);
    }
    const { event, outcome } = await resolveMarketLabelsFast(digest.tokenId);
    const fmsg = `copy REJECTED · ${digest.side} shares=${orderShares} · event=${JSON.stringify(event)} outcome=${JSON.stringify(outcome)} · limit=${limitPrice} tick=${postTick} · error=${JSON.stringify(postErr)} · tx=${txHash}${targetTag(cfg)}`;
    console.warn(fmsg);
    void appendCopyTradeSuccessLine(fmsg, cfg.copyTradeLogPath);
    return;
  }

  // Actual fill from the CLOB response. The labels flip by side:
  //   BUY  → takingAmount = shares acquired, makingAmount = USDC paid
  //   SELL → makingAmount = shares given,    takingAmount = USDC received
  // (the order maker "makes" the asset they post and "takes" the asset they want).
  const respObj = resp as { takingAmount?: string; makingAmount?: string; orderID?: string };
  const taking = parseFloat(respObj.takingAmount ?? "0") || 0;
  const making = parseFloat(respObj.makingAmount ?? "0") || 0;
  // The currently-resting order (id, its posted size, its immediate fill). The reprice loop below may
  // supersede it: superseded fills accumulate into terminalFill* and the loop tracks the new order.
  let restingOrderId = respObj.orderID ?? "";
  let restingPosted = orderShares;
  let restingFillShares = digest.side === "buy" ? taking : making;
  let restingFillUsdc = digest.side === "buy" ? making : taking;
  let terminalFillShares = 0; // shares filled by now-cancelled reprice attempts (no longer on book)
  let terminalFillUsdc = 0;
  // Every order we posted (each a unique orderID) — recorded once for P&L after the loop.
  const postedResps: unknown[] = [resp];
  let repriceNote = "";

  // ── SELL reprice-until-filled ─────────────────────────────────────────────────────────────
  // A GTC sell priced at the top bid can rest unfilled when the bid moves/vanishes (fast markets).
  // Chase it: cancel the resting remainder, re-price aggressively off a FRESH book, and re-post —
  // until filled, out of attempts, past the deadline, or the price would breach the slippage floor
  // (then abandon the remainder rather than dump at any price). Live sells only; dry-run posts nothing.
  if (digest.side === "sell" && (cfg.sellRepriceAttempts ?? 0) > 0 && restingOrderId) {
    const startTs = Date.now();
    const deadlineMs = cfg.sellRepriceDeadlineMs ?? 2500;
    const floor =
      cfg.sellMaxSlippageFrac !== undefined && effectiveImplied > 0
        ? effectiveImplied * (1 - cfg.sellMaxSlippageFrac)
        : 0;
    let attempt = 0;
    let repriced = 0;
    while (
      attempt < (cfg.sellRepriceAttempts ?? 0) &&
      Date.now() - startTs < deadlineMs &&
      orderShares - terminalFillShares - restingFillShares >= minOrder &&
      restingOrderId
    ) {
      attempt++;
      // Cancel the resting remainder first — never leave two orders for the same shares on the book.
      try {
        await client.cancelOrder({ orderID: restingOrderId });
      } catch {
        // Cancel failed → the order may have just filled; keep it as the final tracked order and stop.
        break;
      }
      // Cancel succeeded → the old order is terminal. Fold its fill in (already in postedResps for P&L).
      terminalFillShares += restingFillShares;
      terminalFillUsdc += restingFillUsdc;
      restingOrderId = "";
      restingPosted = 0;
      restingFillShares = 0;
      restingFillUsdc = 0;
      const remaining = orderShares - terminalFillShares;
      if (remaining < minOrder) break; // enough sold
      let freshBook;
      try {
        freshBook = await client.getOrderBook(digest.tokenId);
      } catch {
        break;
      }
      const freshBid = bestBid(freshBook);
      if (freshBid === null || !(freshBid > 0)) break; // no bids to fill against — abandon remainder
      const freshBase = roundToTick(freshBid, postTick, "down");
      const freshPrice = applySellBump(freshBid, freshBase, postTick, cfg.sellBump, cfg.maxSellBumpFrac);
      if (!(freshPrice > 0)) break;
      if (floor > 0 && freshPrice < floor) {
        repriceNote += ` floor-stop@${freshPrice.toFixed(4)}(floor ${floor.toFixed(4)})`;
        break; // would sell too low — leave the remainder unsold
      }
      let rp;
      try {
        rp = await postOnce(freshPrice, postTick, remaining);
      } catch {
        break; // repost threw — remainder now un-posted; nothing resting to track
      }
      if (postErrorMessage(rp)) {
        repriceNote += ` reject`;
        break;
      }
      const rpObj = rp as { takingAmount?: string; makingAmount?: string; orderID?: string };
      restingOrderId = rpObj.orderID ?? "";
      restingPosted = remaining;
      restingFillShares = parseFloat(rpObj.makingAmount ?? "0") || 0;
      restingFillUsdc = parseFloat(rpObj.takingAmount ?? "0") || 0;
      resp = rp;
      postPrice = freshPrice;
      limitPrice = freshPrice;
      postedResps.push(rp);
      repriced++;
    }
    if (repriced > 0 || repriceNote) {
      repriceNote = ` · reprice×${repriced}${repriceNote}`;
    }
  }

  const filledShares = terminalFillShares + restingFillShares;
  const filledUsdc = terminalFillUsdc + restingFillUsdc;
  // Order id the poller keeps watching for late fills (the final resting order; "" if abandoned).
  const postedOrderId = restingOrderId;

  const { event, outcome } = await resolveMarketLabelsFast(digest.tokenId);
  const intendedPUsd = digest.side === "buy" ? (clippedUsdc ?? 0) : originPusd;
  const flushSuffix = flushedFromBufferCount > 0 ? ` · flushedFromBuffer=${flushedFromBufferCount}` : "";
  const msg = `copy posted · ${digest.side} submitted=${orderShares} sh ($${intendedPUsd.toFixed(6)}) filled=${filledShares} sh ($${filledUsdc.toFixed(6)}) · event=${JSON.stringify(event)} outcome=${JSON.stringify(outcome)} · limit=${limitPrice} implied=${effectiveImplied.toFixed(4)}${takerBumpNote}${repriceNote} · tx=${txHash}${flushSuffix}${targetTag(cfg)} · ${JSON.stringify(resp)}`;
  console.log(msg);
  void appendCopyTradeSuccessLine(msg, cfg.copyTradeLogPath);
  // P&L ledger (fire-and-forget): record EACH posted order (unique orderIds) for reconciliation.
  for (const r of postedResps) {
    void recordOrderForPnl({ cfg, resp: r, tokenId: digest.tokenId, side: digest.side, isHedge: false, limitPrice, outcome, event });
  }

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
    await recordCopyBuyAndReconcile(cfg, client, digest.tokenId, filledShares, txHash, postedOrderId, orderShares);
    // Protective take-profit: rest a GTC SELL of the just-filled position at safe_sell (e.g. 0.99), so a
    // spike there exits fee-free before a possible 99c->1c flip. Best-effort; never blocks the copy.
    await placeSafeSell(cfg, client, digest.tokenId, filledShares, postTick, negRisk, minOrder, txHash);
  } else {
    // Register the FINAL resting order (restingFillShares/restingPosted) plus a terminal entry for the
    // shares already sold by superseded reprice attempts, so the position reflects the full exit while
    // the poller only re-checks the one order that can still fill.
    await recordCopySellAndReconcile(
      cfg,
      client,
      digest.tokenId,
      restingFillShares,
      txHash,
      postedOrderId,
      restingPosted,
      terminalFillShares
    );
    // Free the max_market_usdc bucket proportionally to the fraction sold (a full exit zeroes it).
    const spent = getSideSpent(cfg.targetAddress, digest.tokenId);
    addSideSpent(cfg.targetAddress, digest.tokenId, -(sellFraction * spent));
    if (sellFraction >= 0.999) {
      // Full exit — any pending below-min accumulator entries are now stale.
      clearSkipBuffer(cfg.targetAddress, digest.tokenId);
    }
  }
}
