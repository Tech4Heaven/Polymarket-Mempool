/**
 * fillSim — dry-run fill simulator.
 *
 * When dry-run "would post" an order, we register it here and track how it WOULD fill against the
 * REAL live flow from Polymarket's market websocket (book + trades) — the thing a static snapshot
 * can't do. Because our order is never actually in the book, queue position is unknowable, so every
 * fill is reported as a [pessimistic, optimistic] RANGE:
 *   - pessimistic: we sit behind ALL depth at our price (bids ≥ P for a buy)
 *   - optimistic : we're first at our price (only bids > P are ahead)
 *
 * Read-only, no auth, active only in dry-run (guarded by the caller). Disable with SIMULATE_FILLS=false.
 */
import WebSocket from "ws";
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const STATE_PATH = "logs/sim-state.json";
const TTL_MS = Number(process.env["SIM_MAX_HOLD_HOURS"] ?? 120) * 3600_000; // default 5 days
const RESOLVE_POLL_MS = 5 * 60_000;
const PROGRESS_MIN_GAP_MS = 60_000; // throttle per-order progress lines
const EPS = 1e-9;

const enabled = () => process.env["SIMULATE_FILLS"] !== "false";

type RawLevel = { price: string | number; size: string | number };
export type BookSnapshot = { bids: RawLevel[]; asks: RawLevel[] };

type SimOrder = {
  id: string;
  tokenId: string;
  side: "buy" | "sell";
  limitPrice: number;
  size: number;
  postedTs: number;
  immFill: number; // marketable shares filled at post (taker slice)
  immCost: number; // USDC for the marketable slice
  restSize: number; // size - immFill, resting at limitPrice
  aheadPess: number; // depth ahead of us at post (behind everything at our price)
  aheadOpt: number; // depth ahead of us at post (first at our price)
  opposeCum: number; // cumulative opposing-taker volume that reached our price since post
  status: "open" | "done";
  reason: string; // filled | resolved | ttl
  event: string;
  outcome: string;
  target: string;
  logPath: string;
  txHash: string;
  lastLogTs: number;
};

const orders: SimOrder[] = [];
const byToken = new Map<string, SimOrder[]>();
let ws: WebSocket | null = null;
let wsAlive = false;
const subscribed = new Set<string>();
let seq = 0;

// ─────────────────────────────────────────────────────────────────────────────
function log(o: SimOrder, msg: string): void {
  const line = `[SIM] ${msg}`;
  console.log(line);
  try {
    mkdirSync("logs", { recursive: true });
    appendFileSync(o.logPath || "logs/sim.log", line + "\n");
  } catch {
    /* best effort */
  }
}

function num(v: string | number): number {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** Marketable fill + queue-ahead depth, computed from the book snapshot the bot priced against. */
function computeImmediateAndAhead(
  side: "buy" | "sell",
  limitPrice: number,
  size: number,
  book: BookSnapshot
): { immFill: number; immCost: number; aheadPess: number; aheadOpt: number } {
  const bids = book.bids.map((l) => ({ p: num(l.price), s: num(l.size) })).sort((a, b) => b.p - a.p);
  const asks = book.asks.map((l) => ({ p: num(l.price), s: num(l.size) })).sort((a, b) => a.p - b.p);
  let immFill = 0;
  let immCost = 0;
  let aheadPess = 0;
  let aheadOpt = 0;
  if (side === "buy") {
    let rem = size;
    for (const a of asks) {
      if (a.p > limitPrice + EPS) break;
      const f = Math.min(rem, a.s);
      immFill += f;
      immCost += f * a.p;
      rem -= f;
      if (rem <= EPS) break;
    }
    for (const b of bids) {
      if (b.p >= limitPrice - EPS) aheadPess += b.s; // behind everything at ≥ P
      if (b.p > limitPrice + EPS) aheadOpt += b.s; // first at P → only > P is ahead
    }
  } else {
    let rem = size;
    for (const b of bids) {
      if (b.p < limitPrice - EPS) break;
      const f = Math.min(rem, b.s);
      immFill += f;
      immCost += f * b.p;
      rem -= f;
      if (rem <= EPS) break;
    }
    for (const a of asks) {
      if (a.p <= limitPrice + EPS) aheadPess += a.s;
      if (a.p < limitPrice - EPS) aheadOpt += a.s;
    }
  }
  return { immFill, immCost, aheadPess, aheadOpt };
}

function restFill(o: SimOrder): { pess: number; opt: number } {
  return {
    pess: Math.max(0, Math.min(o.restSize, o.opposeCum - o.aheadPess)),
    opt: Math.max(0, Math.min(o.restSize, o.opposeCum - o.aheadOpt)),
  };
}

function fmtRange(lo: number, hi: number, d = 1): string {
  return lo === hi ? lo.toFixed(d) : `${lo.toFixed(d)}–${hi.toFixed(d)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry: called from the dry-run branch of executeCopyTrade.
export function registerSimOrder(args: {
  tokenId: string;
  side: "buy" | "sell";
  limitPrice: number;
  size: number;
  book: BookSnapshot;
  targetAddress: string;
  logPath: string;
  event: string;
  outcome: string;
  txHash: string;
}): void {
  if (!enabled() || args.size <= 0 || args.limitPrice <= 0) {
    return;
  }
  const { immFill, immCost, aheadPess, aheadOpt } = computeImmediateAndAhead(
    args.side,
    args.limitPrice,
    args.size,
    args.book
  );
  const o: SimOrder = {
    id: `sim${++seq}`,
    tokenId: args.tokenId,
    side: args.side,
    limitPrice: args.limitPrice,
    size: args.size,
    postedTs: Date.now(),
    immFill,
    immCost,
    restSize: Math.max(0, args.size - immFill),
    aheadPess,
    aheadOpt,
    opposeCum: 0,
    status: "open",
    reason: "",
    event: args.event,
    outcome: args.outcome,
    target: args.targetAddress,
    logPath: args.logPath,
    txHash: args.txHash,
    lastLogTs: Date.now(),
  };
  orders.push(o);
  const list = byToken.get(o.tokenId) ?? [];
  list.push(o);
  byToken.set(o.tokenId, list);
  ensureFeed();
  ensureSubscribed(o.tokenId);
  log(
    o,
    `register ${o.side} token=${o.tokenId} limit=${o.limitPrice} size=${o.size.toFixed(2)} · ` +
      `immFill=${immFill.toFixed(2)}@${immFill > 0 ? (immCost / immFill).toFixed(4) : "-"} resting=${o.restSize.toFixed(2)} ` +
      `aheadPess=${aheadPess.toFixed(1)} aheadOpt=${aheadOpt.toFixed(1)} · event=${JSON.stringify(o.event)} out=${o.outcome} · tx=${o.txHash}`
  );
  saveState();
}

// ─────────────────────────────────────────────────────────────────────────────
// Live flow: accumulate opposing-taker volume that reaches each order's price.
// Aggressor is inferred from PRICE (a print ≤ our bid = a seller reaching us; ≥ our ask = a buyer),
// which sidesteps any ambiguity in the message's `side` field. `side` is only logged for reference.
function onTrade(tokenId: string, price: number, size: number): void {
  const list = byToken.get(tokenId);
  if (!list) return;
  for (const o of list) {
    if (o.status !== "open") continue;
    const reaches = o.side === "buy" ? price <= o.limitPrice + EPS : price >= o.limitPrice - EPS;
    if (!reaches) continue;
    o.opposeCum += size;
    const { pess, opt } = restFill(o);
    const now = Date.now();
    if (now - o.lastLogTs >= PROGRESS_MIN_GAP_MS) {
      o.lastLogTs = now;
      const loTot = o.immFill + pess;
      const hiTot = o.immFill + opt;
      log(
        o,
        `fill token=${tokenId} filled=[${fmtRange(loTot, hiTot)}]/${o.size.toFixed(2)} ` +
          `(${fmtRange((100 * loTot) / o.size, (100 * hiTot) / o.size)}%) ` +
          `opposeVol@≤P=${o.opposeCum.toFixed(1)} restRemaining≈${fmtRange(o.restSize - opt, o.restSize - pess)}`
      );
    }
    if (pess >= o.restSize - EPS) {
      finalize(o, "filled");
    }
  }
  saveStateThrottled();
}

function finalize(o: SimOrder, reason: string, outcomeValue?: number): void {
  if (o.status !== "open") return;
  o.status = "done";
  o.reason = reason;
  const { pess, opt } = restFill(o);
  const filledLo = o.immFill + pess;
  const filledHi = o.immFill + opt;
  const costLo = o.immCost + pess * o.limitPrice;
  const costHi = o.immCost + opt * o.limitPrice;
  let pnl = "";
  if (outcomeValue !== undefined) {
    const pnlLo = filledLo * outcomeValue - costLo;
    const pnlHi = filledHi * outcomeValue - costHi;
    pnl = ` · outcome=${outcomeValue === 1 ? "WIN" : "LOSE"} simPnL=[$${pnlLo.toFixed(2)} – $${pnlHi.toFixed(2)}]`;
  }
  log(
    o,
    `DONE token=${o.tokenId} reason=${reason} filled=[${fmtRange(filledLo, filledHi, 2)}]/${o.size.toFixed(2)} ` +
      `(${fmtRange((100 * filledLo) / o.size, (100 * filledHi) / o.size)}%) ` +
      `cost=[$${costLo.toFixed(2)} – $${costHi.toFixed(2)}]${pnl} · tx=${o.txHash}`
  );
  saveState();
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket feed (multiplexes all active tokens on one connection).
function ensureFeed(): void {
  if (ws) return;
  connect();
}

function connect(): void {
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.warn(`[SIM] ws connect error: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  ws.on("open", () => {
    wsAlive = true;
    subscribed.clear();
    for (const t of byToken.keys()) {
      if (hasOpen(t)) sendSubscribe(t);
    }
    console.log(`[SIM] market feed connected · tokens=${subscribed.size}`);
  });
  ws.on("message", (data: WebSocket.RawData) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    const msgs = Array.isArray(parsed) ? parsed : [parsed];
    for (const m of msgs as Array<Record<string, unknown>>) {
      const type = (m["event_type"] as string) || (m["type"] as string) || "";
      if (type === "last_trade_price") {
        const tokenId = (m["asset_id"] as string) || "";
        onTrade(tokenId, num(m["price"] as string), num(m["size"] as string));
      }
      // book / price_change carry no fill info in this model (price-based aggressor inference);
      // they'd only be needed for dynamic queue recompute, a future refinement.
    }
  });
  ws.on("error", (err: Error) => {
    console.warn(`[SIM] ws error: ${err?.message ?? String(err)}`);
  });
  ws.on("close", () => {
    wsAlive = false;
    ws = null;
    if (anyOpen()) {
      setTimeout(connect, 2000); // reconnect; on open we re-subscribe all open tokens
    }
  });
}

function sendSubscribe(tokenId: string): void {
  if (!ws || !wsAlive || subscribed.has(tokenId)) return;
  ws.send(JSON.stringify({ assets_ids: [tokenId], type: "market" }));
  subscribed.add(tokenId);
}

function ensureSubscribed(tokenId: string): void {
  if (wsAlive) sendSubscribe(tokenId);
  // else: the "open" handler subscribes all open tokens once connected.
}

function hasOpen(tokenId: string): boolean {
  return (byToken.get(tokenId) ?? []).some((o) => o.status === "open");
}
function anyOpen(): boolean {
  return orders.some((o) => o.status === "open");
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution watcher: when a token's market closes, finalize its orders with the outcome.
setInterval(() => {
  void pollResolutions();
}, RESOLVE_POLL_MS).unref();

// TTL sweep.
setInterval(() => {
  const now = Date.now();
  for (const o of orders) {
    if (o.status === "open" && now - o.postedTs > TTL_MS) finalize(o, "ttl");
  }
}, RESOLVE_POLL_MS).unref();

async function pollResolutions(): Promise<void> {
  const tokens = [...byToken.keys()].filter(hasOpen);
  for (const tokenId of tokens) {
    try {
      const res = await fetch(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`);
      if (!res.ok) continue;
      const arr = (await res.json()) as Array<Record<string, unknown>>;
      const m = arr?.[0];
      if (!m || m["closed"] !== true) continue;
      const ids = safeArr(m["clobTokenIds"]);
      const prices = safeArr(m["outcomePrices"]);
      const idx = ids.indexOf(tokenId);
      if (idx < 0 || idx >= prices.length) continue;
      const outcomeValue = num(prices[idx]!) >= 0.5 ? 1 : 0;
      for (const o of byToken.get(tokenId) ?? []) {
        if (o.status === "open") finalize(o, "resolved", outcomeValue);
      }
    } catch {
      /* transient; retry next poll */
    }
  }
}

function safeArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence — survive restarts across the multi-day hold.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveStateThrottled(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveState();
  }, 5000);
  saveTimer.unref();
}
function saveState(): void {
  try {
    mkdirSync("logs", { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify({ seq, orders }, null, 0));
  } catch {
    /* best effort */
  }
}
function loadState(): void {
  try {
    if (!existsSync(STATE_PATH)) return;
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as { seq?: number; orders?: SimOrder[] };
    seq = raw.seq ?? 0;
    for (const o of raw.orders ?? []) {
      orders.push(o);
      const list = byToken.get(o.tokenId) ?? [];
      list.push(o);
      byToken.set(o.tokenId, list);
    }
    if (anyOpen()) {
      console.log(`[SIM] resumed ${orders.filter((o) => o.status === "open").length} open sim order(s) from state`);
      ensureFeed();
    }
  } catch {
    /* corrupt state — ignore */
  }
}
if (enabled()) loadState();
