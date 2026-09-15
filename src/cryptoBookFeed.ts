import WebSocket from "ws";
import { getCryptoTokenIds, lookupCryptoMarket } from "./cryptoMarketPrewarm.js";

/**
 * Crypto order-book WS feed (pre-subscribe).
 *
 * Maintains a live, in-memory top-of-book for the CURRENTLY-ACTIVE crypto up/down markets by
 * subscribing to Polymarket's market websocket AHEAD of trades — so the copy hot path reads the book
 * from memory (~0 ms) instead of a ~37 ms REST `GET /book`. Crypto only: non-crypto markets aren't
 * pre-subscribable, so the copy path falls back to REST there (`getCryptoBook` returns null for them).
 *
 * PLATFORM CONSTRAINT (verified live, not assumed): the market channel honors only the FIRST
 * `subscribe` message per connection, and caps a subscription at ~100 assets. A second subscribe on
 * the same socket is silently ignored. So we CANNOT stream all ~700 cached crypto tokens on one
 * growing subscription. Instead we subscribe, in a SINGLE message, the ACTIVE frontier — the soonest-
 * ending tokens (capped at ACTIVE_MAX), which are the ones actually trading — and RECONNECT with a
 * fresh single subscribe whenever that set changes (markets roll every ~40-60 s). A token outside the
 * frontier (a market that hasn't entered its active window yet) simply uses REST until it rolls in.
 *
 * Message model (verified live):
 *  - `book`         → full snapshot { asset_id, bids[], asks[], tick_size }. Seeds best bid/ask.
 *  - `price_change` → { price_changes: [ { asset_id, price, size, side, best_bid, best_ask } ] } —
 *                     dominates on active markets and carries best_bid/best_ask DIRECTLY, so top-of-book
 *                     stays fresh with no depth reconstruction (the copy path only needs best bid/ask).
 *
 * `min_order_size` / `tick_size` come from the prewarm cache (gamma `orderMinSize` /
 * `orderPriceMinTickSize`) — no per-token REST. A token is served only once `ready` (we've seen a
 * book/price_change for it) and its market params are known; otherwise getCryptoBook returns null.
 *
 * Safety: if the socket is disconnected or has gone silent (zombie / mid-reconnect), getCryptoBook
 * returns null for ALL tokens, so a stale in-memory book is never used — the path degrades to REST,
 * never to a wrong price.
 */

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const ACTIVE_MAX = 90; // stay under the ~100-asset per-connection cap
const ACTIVE_PAST_MS = 2 * 60_000; // still include a just-ended market (pending resolution / late fills)
const SYNC_MS = 8_000; // re-evaluate the active frontier this often; reconnect only if it changed
const RECONNECT_MIN_MS = 25_000; // don't reconnect more often than this even as the frontier wiggles
const STALE_GLOBAL_MS = 15_000; // no WS message for this long → treat feed as unhealthy (REST fallback)
const PING_MS = 20_000;

type Level = { price: string; size: string };
type TopBook = {
  bidPx: number | null;
  bidSz: string;
  askPx: number | null;
  askSz: string;
  ready: boolean;
};

/** REST-`getOrderBook`-shaped view the copy path consumes (only these fields are read downstream). */
export type CryptoBookView = {
  asks: Level[];
  bids: Level[];
  min_order_size: string;
  tick_size: string;
};

let ws: WebSocket | null = null;
let started = false;
let stopped = false;
let connected = false;
let lastMsgMs = 0;
let lastConnectAt = 0;
let desired: string[] = []; // current active frontier (normalized token ids), subscribed on connect
let subscribedKey = ""; // stable key of the token set the live connection subscribed

const books = new Map<string, TopBook>();

function normKey(id: string): string {
  const s = id.trim();
  try {
    return BigInt(s).toString();
  } catch {
    return s.toLowerCase();
  }
}

/** The soonest-ending (most active) crypto tokens, capped — the ones actually being traded now. */
function computeDesired(): string[] {
  const now = Date.now();
  const rows: { t: string; end: number }[] = [];
  for (const t of getCryptoTokenIds()) {
    const info = lookupCryptoMarket(t);
    if (!info || info.minOrderSize === undefined) continue;
    if (!(info.endMs > now - ACTIVE_PAST_MS)) continue; // drop long-ended markets
    rows.push({ t, end: info.endMs });
  }
  rows.sort((a, b) => a.end - b.end);
  return rows.slice(0, ACTIVE_MAX).map((r) => r.t);
}

function keyOf(tokens: string[]): string {
  return [...tokens].sort().join(",");
}

function bestFromLevels(levels: unknown, pick: "max" | "min"): { px: number | null; sz: string } {
  if (!Array.isArray(levels)) return { px: null, sz: "0" };
  let best = pick === "max" ? -Infinity : Infinity;
  let sz = "0";
  for (const l of levels as Level[]) {
    const p = parseFloat(l?.price);
    if (!Number.isFinite(p)) continue;
    if ((pick === "max" && p > best) || (pick === "min" && p < best)) {
      best = p;
      sz = typeof l.size === "string" ? l.size : String(l.size ?? "0");
    }
  }
  if (best === Infinity || best === -Infinity) return { px: null, sz: "0" };
  return { px: best, sz };
}

function getEntry(tokenKey: string): TopBook {
  let e = books.get(tokenKey);
  if (!e) {
    e = { bidPx: null, bidSz: "0", askPx: null, askSz: "0", ready: false };
    books.set(tokenKey, e);
  }
  return e;
}

function handleBook(ev: Record<string, unknown>): void {
  const asset = typeof ev["asset_id"] === "string" ? ev["asset_id"] : "";
  if (!asset) return;
  const e = getEntry(normKey(asset));
  const bid = bestFromLevels(ev["bids"], "max");
  const ask = bestFromLevels(ev["asks"], "min");
  e.bidPx = bid.px;
  e.bidSz = bid.sz;
  e.askPx = ask.px;
  e.askSz = ask.sz;
  e.ready = true;
}

function handlePriceChange(ev: Record<string, unknown>): void {
  const changes = ev["price_changes"];
  if (!Array.isArray(changes)) return;
  for (const c of changes as Record<string, unknown>[]) {
    const asset = typeof c["asset_id"] === "string" ? c["asset_id"] : "";
    if (!asset) continue;
    const e = getEntry(normKey(asset));
    // best_bid / best_ask are the post-change tops — take them directly (no depth reconstruction).
    const bb = parseFloat(String(c["best_bid"]));
    const ba = parseFloat(String(c["best_ask"]));
    e.bidPx = Number.isFinite(bb) && bb > 0 ? bb : null;
    e.askPx = Number.isFinite(ba) && ba > 0 ? ba : null;
    // Keep the best-level size fresh when THIS change is at the new best (else leave the last known).
    const px = parseFloat(String(c["price"]));
    const sz = typeof c["size"] === "string" ? (c["size"] as string) : String(c["size"] ?? "");
    const side = String(c["side"] ?? "").toUpperCase();
    if (Number.isFinite(px) && sz) {
      if (side === "BUY" && e.bidPx !== null && Math.abs(px - e.bidPx) < 1e-12) e.bidSz = sz;
      if (side === "SELL" && e.askPx !== null && Math.abs(px - e.askPx) < 1e-12) e.askSz = sz;
    }
    e.ready = true;
  }
}

function onMessage(raw: WebSocket.RawData): void {
  lastMsgMs = Date.now();
  let msg: unknown;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const arr = Array.isArray(msg) ? msg : [msg];
  for (const ev of arr as Record<string, unknown>[]) {
    const t = ev["event_type"];
    if (t === "book") handleBook(ev);
    else if (t === "price_change") handlePriceChange(ev);
  }
}

function connect(): void {
  if (stopped) return;
  desired = computeDesired();
  const tokens = desired;
  ws = new WebSocket(WS_URL, { perMessageDeflate: false, handshakeTimeout: 10_000 });

  ws.on("open", () => {
    connected = true;
    lastMsgMs = Date.now();
    lastConnectAt = Date.now();
    // SINGLE subscribe message — the only one the connection honors — with the active frontier.
    if (tokens.length > 0) {
      try {
        ws?.send(JSON.stringify({ assets_ids: tokens, type: "market" }));
      } catch {
        // a failed send triggers a reconnect via close/error
      }
    }
    subscribedKey = keyOf(tokens);
    // Prune books no longer in the active set (bounds memory as markets roll).
    const keep = new Set(tokens);
    for (const k of books.keys()) if (!keep.has(k)) books.delete(k);
    console.info(`[cryptoBook] connected · subscribed ${tokens.length} active crypto token(s)`);
  });
  ws.on("message", onMessage);
  ws.on("close", () => {
    connected = false;
    if (!stopped) setTimeout(connect, 1500);
  });
  ws.on("error", () => {
    try {
      ws?.terminate();
    } catch {
      // close handler drives reconnect
    }
  });
  ws.on("pong", () => {
    lastMsgMs = Date.now();
  });
}

/** Reconnect with a fresh single subscribe if the active frontier has changed since we connected. */
function resync(): void {
  if (stopped || !ws || !connected) return;
  if (Date.now() - lastConnectAt < RECONNECT_MIN_MS) return; // throttle: cap reconnect frequency
  const next = computeDesired();
  if (keyOf(next) === subscribedKey) return; // unchanged — keep the stable connection (no gap)
  desired = next;
  try {
    ws.terminate(); // close handler reconnects and subscribes `desired` in one message
  } catch {
    // ignore
  }
}

function healthy(): boolean {
  return connected && lastMsgMs > 0 && Date.now() - lastMsgMs < STALE_GLOBAL_MS;
}

/**
 * In-memory top-of-book for a crypto token in REST-`getOrderBook` shape, or null when it can't be
 * served (not crypto / outside the active frontier / not yet ready / market params unknown / feed
 * unhealthy) — caller falls back to REST. Never returns a stale book.
 */
export function getCryptoBook(tokenId: string): CryptoBookView | null {
  if (!started || !healthy()) return null;
  const key = normKey(tokenId);
  const info = lookupCryptoMarket(key);
  if (!info || info.minOrderSize === undefined) return null; // not a known crypto market, or no min size
  const e = books.get(key);
  if (!e || !e.ready) return null;
  return {
    asks: e.askPx !== null ? [{ price: String(e.askPx), size: e.askSz }] : [],
    bids: e.bidPx !== null ? [{ price: String(e.bidPx), size: e.bidSz }] : [],
    min_order_size: String(info.minOrderSize),
    tick_size: info.tickSize !== undefined ? String(info.tickSize) : "0.01",
  };
}

/** True when the feed is connected and receiving — for a boot/status log. */
export function isCryptoBookFeedHealthy(): boolean {
  return healthy();
}

/** Number of tokens currently served (ready) — for status/diagnostics. */
export function cryptoBookReadyCount(): number {
  let n = 0;
  for (const e of books.values()) if (e.ready) n++;
  return n;
}

/** Starts the WS feed (idempotent). Safe to call before the prewarm cache is populated. */
export function startCryptoBookFeed(): void {
  if (started) return;
  started = true;
  connect();
  const sync = setInterval(resync, SYNC_MS);
  sync.unref();
  const ping = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }
  }, PING_MS);
  ping.unref();
}

export function stopCryptoBookFeed(): void {
  stopped = true;
  try {
    ws?.removeAllListeners();
    ws?.terminate();
  } catch {
    // ignore
  }
  ws = null;
  connected = false;
}
