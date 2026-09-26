/**
 * Local web UI to buy Polymarket BTC 5m / 15m Up/Down tokens by slug + side + USDC amount.
 *
 * Usage: `npm run buy-ui`  →  http://127.0.0.1:3847
 *
 * Env: same wallet/funder/CLOB settings as copy trading. Optional: `BUY_UI_PORT` (default 3847),
 * `BUY_UI_HOST` (default 127.0.0.1), `COPY_WALLET_KEY_PASSPHRASE`.
 */

import "dotenv/config";
import http from "node:http";
import { mkdir, readFile } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { AssetType, OrderType, Side, type ClobClient } from "@polymarket/clob-client-v2";
import { formatUnits } from "ethers";
import { withSuppressedPolymarketClobConsole } from "../src/clobConsoleSuppress.js";
import { loadCopyTradeSharedCredentials, mergeCopyTradeConfig, type TargetCopyParams } from "../src/env.js";
import { ensureClobClient, applyTakerBump, applySellBump } from "../src/copyTrade.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = resolve(SCRIPT_DIR, "assets", "btc-manual-buy-logo.png");

const GAMMA_HOST = "https://gamma-api.polymarket.com";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3847;
/** Same style as copy targets: bump above ask so the buy crosses as a taker. */
const MANUAL_TAKER_BUMP = 0.03;
/** Exit mirror: bump below bid so sells cross as a taker. */
const MANUAL_SELL_BUMP = 0.03;

type SideLabel = "Up" | "Down";

type GammaMarketRow = {
  slug?: string;
  question?: string;
  conditionId?: string;
  clobTokenIds?: unknown;
  outcomes?: unknown;
  closed?: boolean;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  endDate?: string;
  orderMinSize?: unknown;
};

type ResolvedMarket = {
  slug: string;
  question: string;
  side: SideLabel;
  tokenId: string;
  oppositeTokenId: string;
  outcomes: string[];
  endDate?: string;
  acceptingOrders: boolean;
};

type QuotePlan = ResolvedMarket & {
  tickSize: string;
  negRisk: boolean;
  bestAsk: number;
  baseLimit: number;
  limitPrice: number;
  takerBump: number;
  minOrderSize: number;
  usdc: number;
  shares: number;
  raisedForMin: boolean;
};

function parseJsonStringArray(raw: unknown): string[] {
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw) as unknown;
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw.map(String) : [];
}

function windowStartSecs(nowMs: number, durationSecs: number): number {
  const nowSecs = Math.floor(nowMs / 1000);
  return Math.floor(nowSecs / durationSecs) * durationSecs;
}

function btcWindows(nowMs = Date.now()): {
  interval: "5m" | "15m";
  label: "current" | "next";
  slug: string;
  start: number;
  end: number;
}[] {
  const out: ReturnType<typeof btcWindows> = [];
  for (const [interval, secs] of [
    ["5m", 300],
    ["15m", 900],
  ] as const) {
    const start = windowStartSecs(nowMs, secs);
    for (const [label, offset] of [
      ["current", 0],
      ["next", 1],
    ] as const) {
      const s = start + offset * secs;
      out.push({
        interval,
        label,
        slug: `btc-updown-${interval}-${s}`,
        start: s,
        end: s + secs,
      });
    }
  }
  return out;
}

async function fetchGammaBySlug(slug: string): Promise<GammaMarketRow | null> {
  const url = `${GAMMA_HOST}/markets/slug/${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Gamma slug ${slug}: HTTP ${res.status}`);
  return (await res.json()) as GammaMarketRow;
}

function pickToken(ids: string[], outcomes: string[], side: SideLabel): { tokenId: string; oppositeTokenId: string } {
  const idxByOutcome = outcomes.findIndex((o) => o.trim().toLowerCase() === side.toLowerCase());
  // Convention when outcomes missing/odd: [0]=Up, [1]=Down
  const idx = idxByOutcome >= 0 ? idxByOutcome : side === "Up" ? 0 : 1;
  if (idx < 0 || idx >= ids.length) {
    throw new Error(`Cannot map side "${side}" to token (outcomes=${JSON.stringify(outcomes)})`);
  }
  const oppositeIdx = idx === 0 ? 1 : 0;
  if (oppositeIdx >= ids.length) {
    throw new Error("Market needs at least two clobTokenIds");
  }
  return { tokenId: ids[idx]!, oppositeTokenId: ids[oppositeIdx]! };
}

async function resolveMarket(slug: string, side: SideLabel): Promise<ResolvedMarket> {
  const cleaned = slug.trim().toLowerCase();
  if (!cleaned) throw new Error("slug is required");
  if (side !== "Up" && side !== "Down") throw new Error('side must be "Up" or "Down"');

  const row = await fetchGammaBySlug(cleaned);
  if (!row) throw new Error(`Market not found for slug: ${cleaned}`);
  if (row.closed === true) throw new Error("Market is closed");

  const ids = parseJsonStringArray(row.clobTokenIds);
  const outcomes = parseJsonStringArray(row.outcomes);
  if (ids.length < 2) throw new Error("Market missing clobTokenIds");

  const { tokenId, oppositeTokenId } = pickToken(ids, outcomes, side);
  return {
    slug: row.slug ?? cleaned,
    question: row.question ?? cleaned,
    side,
    tokenId,
    oppositeTokenId,
    outcomes: outcomes.length ? outcomes : ["Up", "Down"],
    endDate: typeof row.endDate === "string" ? row.endDate : undefined,
    acceptingOrders: row.acceptingOrders !== false && row.enableOrderBook !== false,
  };
}

function bestAsk(book: { asks: { price: string }[] }): number | null {
  let min = Infinity;
  for (const a of book.asks) {
    const x = parseFloat(a.price);
    if (Number.isFinite(x) && x > 0) min = Math.min(min, x);
  }
  return min === Infinity ? null : min;
}

function roundToTick(price: number, tickStr: string, mode: "up" | "down"): number {
  const t = parseFloat(tickStr);
  if (!(t > 0)) return price;
  if (mode === "up") return Math.min(0.99, Math.ceil(price / t - 1e-12) * t);
  return Math.max(0.01, Math.floor(price / t + 1e-12) * t);
}

type SideBookQuote = {
  side: SideLabel;
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
};

type MarketPrices = {
  slug: string;
  question: string;
  endDate?: string;
  acceptingOrders: boolean;
  outcomes: string[];
  up: SideBookQuote;
  down: SideBookQuote;
  updatedAtMs: number;
};

function bestBid(book: { bids: { price: string }[] }): number | null {
  let max = -Infinity;
  for (const b of book.bids) {
    const x = parseFloat(b.price);
    if (Number.isFinite(x) && x > 0) max = Math.max(max, x);
  }
  return max === -Infinity ? null : max;
}

async function quoteSideBook(client: ClobClient, side: SideLabel, tokenId: string): Promise<SideBookQuote> {
  const book = await client.getOrderBook(tokenId);
  const ask = bestAsk(book);
  const bid = bestBid(book);
  let mid: number | null = null;
  if (ask !== null && bid !== null) mid = (ask + bid) / 2;
  else if (ask !== null) mid = ask;
  else if (bid !== null) mid = bid;
  return { side, tokenId, bestBid: bid, bestAsk: ask, mid };
}

async function fetchMarketPrices(client: ClobClient, slug: string): Promise<MarketPrices> {
  const up = await resolveMarket(slug, "Up");
  const [upQ, downQ] = await Promise.all([
    quoteSideBook(client, "Up", up.tokenId),
    quoteSideBook(client, "Down", up.oppositeTokenId),
  ]);
  return {
    slug: up.slug,
    question: up.question,
    endDate: up.endDate,
    acceptingOrders: up.acceptingOrders,
    outcomes: up.outcomes,
    up: upQ,
    down: downQ,
    updatedAtMs: Date.now(),
  };
}

type SellPlan = ResolvedMarket & {
  tickSize: string;
  negRisk: boolean;
  bestBid: number;
  baseLimit: number;
  limitPrice: number;
  sellBump: number;
  balanceShares: number;
  shares: number;
  usdc: number;
  sellAll: boolean;
  minOrderSize: number;
};

async function getConditionalShares(client: ClobClient, tokenId: string): Promise<number> {
  const bal = await client.getBalanceAllowance({
    asset_type: AssetType.CONDITIONAL,
    token_id: tokenId,
  });
  const size = parseFloat(formatUnits(BigInt(String(bal.balance)), 6));
  return Number.isFinite(size) && size > 0 ? size : 0;
}

async function planSell(
  client: ClobClient,
  slug: string,
  side: SideLabel,
  amountUsdc: number | null
): Promise<SellPlan> {
  const market = await resolveMarket(slug, side);
  if (!market.acceptingOrders) {
    throw new Error("Market is not accepting orders");
  }

  const balanceShares = await getConditionalShares(client, market.tokenId);
  if (!(balanceShares > 0)) {
    throw new Error(`No ${side} position to sell on this market`);
  }

  const [tickSize, negRisk, book] = await Promise.all([
    client.getTickSize(market.tokenId),
    client.getNegRisk(market.tokenId),
    client.getOrderBook(market.tokenId),
  ]);

  const bid = bestBid(book);
  if (bid === null) throw new Error("No bids on the book — cannot place a marketable sell");

  const baseLimit = roundToTick(bid, String(tickSize), "down");
  const limitPrice = applySellBump(bid, baseLimit, tickSize, MANUAL_SELL_BUMP, undefined);
  const minOrderSize = parseFloat(String(book.min_order_size ?? 5));

  const sellAll = amountUsdc === null || !(amountUsdc > 0);
  let shares: number;
  if (sellAll) {
    shares = balanceShares;
  } else {
    shares = Math.min(balanceShares, amountUsdc / limitPrice);
  }

  if (Number.isFinite(minOrderSize) && shares + 1e-9 < minOrderSize) {
    throw new Error(
      `Shares ${shares.toFixed(4)} < min_order_size ${minOrderSize}` +
        (sellAll ? " (balance too small to sell)" : " — raise amount or leave blank to sell all")
    );
  }

  return {
    ...market,
    tickSize: String(tickSize),
    negRisk: Boolean(negRisk),
    bestBid: bid,
    baseLimit,
    limitPrice,
    sellBump: MANUAL_SELL_BUMP,
    balanceShares,
    shares,
    usdc: shares * limitPrice,
    sellAll,
    minOrderSize: Number.isFinite(minOrderSize) ? minOrderSize : 5,
  };
}

async function planBuy(
  client: ClobClient,
  slug: string,
  side: SideLabel,
  amountUsdc: number
): Promise<QuotePlan> {
  if (!(amountUsdc > 0) || !Number.isFinite(amountUsdc)) {
    throw new Error("amountUsdc must be a positive number");
  }
  const market = await resolveMarket(slug, side);
  if (!market.acceptingOrders) {
    throw new Error("Market is not accepting orders");
  }

  const [tickSize, negRisk, book] = await Promise.all([
    client.getTickSize(market.tokenId),
    client.getNegRisk(market.tokenId),
    client.getOrderBook(market.tokenId),
  ]);

  const ask = bestAsk(book);
  if (ask === null) throw new Error("No asks on the book — cannot place a marketable buy");

  const baseLimit = roundToTick(ask, tickSize, "up");
  const limitPrice = applyTakerBump(ask, baseLimit, tickSize, MANUAL_TAKER_BUMP, undefined);
  const minOrderSize = parseFloat(String(book.min_order_size ?? 5));
  const minUsdc = Number.isFinite(minOrderSize) && minOrderSize > 0 ? minOrderSize * limitPrice : 0;
  const usdc = Math.max(amountUsdc, minUsdc > 0 ? minUsdc * 1.000001 : amountUsdc);
  const shares = usdc / limitPrice;
  if (Number.isFinite(minOrderSize) && shares + 1e-9 < minOrderSize) {
    throw new Error(`Shares ${shares.toFixed(4)} < min_order_size ${minOrderSize}`);
  }

  return {
    ...market,
    tickSize: String(tickSize),
    negRisk: Boolean(negRisk),
    bestAsk: ask,
    baseLimit,
    limitPrice,
    takerBump: MANUAL_TAKER_BUMP,
    minOrderSize: Number.isFinite(minOrderSize) ? minOrderSize : 5,
    usdc,
    shares,
    raisedForMin: usdc > amountUsdc + 1e-9,
  };
}

function dummyTargetParams(cwd: string): TargetCopyParams {
  return {
    address: "0x0000000000000000000000000000000000000001",
    copyRatio: 1,
    maxPriceDifference: 1,
    minPositionUsdc: 0,
    maxPositionUsdc: 1e12,
    dryRun: false,
    copyTradeLogPath: resolve(cwd, "logs", "manual-buy-ui.log"),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(raw);
}

function sendHtml(res: http.ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function sendPng(res: http.ServerResponse, buf: Buffer): void {
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=3600",
    "Content-Length": buf.length,
  });
  res.end(buf);
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BTC Manual Buy</title>
  <link rel="icon" type="image/png" href="/logo.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Syne:wght@600;700;800&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg0: #f3efe6;
      --bg1: #e7e1d4;
      --ink: #1a1c1a;
      --muted: #5c635c;
      --line: #c9c2b4;
      --panel: rgba(255, 252, 246, 0.86);
      --accent: #0f6e56;
      --accent-ink: #f5fff9;
      --up: #0f6e56;
      --down: #9a3412;
      --err: #9f1239;
      --ok: #166534;
      --shadow: 0 18px 50px rgba(40, 36, 28, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      background:
        radial-gradient(900px 500px at 10% -10%, #d9f2e8 0%, transparent 55%),
        radial-gradient(700px 420px at 100% 0%, #f6e2c8 0%, transparent 50%),
        linear-gradient(180deg, var(--bg0), var(--bg1));
    }
    main {
      width: min(720px, calc(100% - 2rem));
      margin: 2.5rem auto 3rem;
    }
    h1 {
      font-family: Syne, system-ui, sans-serif;
      font-weight: 800;
      font-size: clamp(1.8rem, 4vw, 2.6rem);
      letter-spacing: -0.03em;
      margin: 0;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.85rem;
      margin-bottom: 0.45rem;
    }
    .brand img {
      width: 64px;
      height: 64px;
      border-radius: 16px;
      box-shadow: 0 8px 24px rgba(40, 36, 28, 0.12);
      background: #fffdf8;
      object-fit: cover;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      box-shadow: var(--shadow);
      padding: 1.25rem 1.35rem 1.4rem;
      backdrop-filter: blur(8px);
    }
    .grid { display: grid; gap: 0.9rem; }
    label {
      display: grid;
      gap: 0.35rem;
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    input, button { font: inherit; }
    input {
      width: 100%;
      border: 1px solid var(--line);
      background: #fffdf8;
      color: var(--ink);
      border-radius: 10px;
      padding: 0.7rem 0.8rem;
      outline: none;
    }
    input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(15, 110, 86, 0.15);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem;
      margin: 0.2rem 0 0.4rem;
    }
    .chip {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      border-radius: 999px;
      padding: 0.35rem 0.7rem;
      font-size: 0.75rem;
      cursor: pointer;
    }
    .chip:hover { border-color: var(--accent); color: var(--accent); }
    .chip.active {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-ink);
    }
    .side-pick {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.7rem;
    }
    .side-card {
      border: 1px solid var(--line);
      background: #fffdf8;
      border-radius: 14px;
      padding: 0.85rem 0.95rem;
      cursor: pointer;
      text-align: left;
      transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
    }
    .side-card:hover { border-color: var(--accent); }
    .side-card.active-up {
      border-color: var(--up);
      background: #eef8f3;
      box-shadow: 0 0 0 3px rgba(15, 110, 86, 0.12);
    }
    .side-card.active-down {
      border-color: var(--down);
      background: #faf1eb;
      box-shadow: 0 0 0 3px rgba(154, 52, 18, 0.12);
    }
    .side-card .name {
      font-family: Syne, system-ui, sans-serif;
      font-weight: 700;
      font-size: 1.05rem;
      margin-bottom: 0.45rem;
    }
    .side-card.active-up .name { color: var(--up); }
    .side-card.active-down .name { color: var(--down); }
    .side-card .px {
      display: grid;
      gap: 0.2rem;
      font-size: 0.78rem;
      color: var(--muted);
    }
    .side-card .px strong {
      color: var(--ink);
      font-weight: 600;
      font-size: 1.05rem;
    }
    .market-meta {
      color: var(--muted);
      font-size: 0.75rem;
      line-height: 1.4;
      min-height: 1.1rem;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.6rem;
      margin-top: 0.2rem;
    }
    button.action {
      border-radius: 12px;
      padding: 0.75rem 1rem;
      cursor: pointer;
      font-weight: 600;
      background: transparent;
    }
    button.primary {
      color: var(--up);
      border: 1.5px solid var(--up);
      background: transparent;
    }
    button.primary:hover {
      background: rgba(15, 110, 86, 0.08);
    }
    button.sell {
      color: var(--down);
      border: 1.5px solid var(--down);
      background: transparent;
    }
    button.sell:hover {
      background: rgba(154, 52, 18, 0.08);
    }
    button.ghost {
      color: var(--ink);
      border: 1px solid var(--line);
      background: transparent;
    }
    button:disabled { opacity: 0.55; cursor: wait; }
    .out {
      margin-top: 1rem;
      border-top: 1px dashed var(--line);
      padding-top: 1rem;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.78rem;
      line-height: 1.45;
      color: var(--ink);
      min-height: 4rem;
    }
    .out.err { color: var(--err); }
    .out.ok { color: var(--ok); }
    .brand-wrap {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 0.45rem;
    }
    .conn {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      border: 1px solid var(--line);
      background: #fffdf8;
      border-radius: 999px;
      padding: 0.35rem 0.7rem 0.35rem 0.55rem;
      font-size: 0.72rem;
      color: var(--muted);
      white-space: nowrap;
      align-self: center;
    }
    .conn-dot {
      width: 0.55rem;
      height: 0.55rem;
      border-radius: 50%;
      background: #a8a29a;
      flex-shrink: 0;
    }
    .conn.live .conn-dot { background: var(--ok); box-shadow: 0 0 0 3px rgba(22, 101, 52, 0.18); }
    .conn.live { color: var(--ok); border-color: #bbf7d0; }
    .conn.down .conn-dot { background: var(--err); box-shadow: 0 0 0 3px rgba(159, 18, 57, 0.15); }
    .conn.down { color: var(--err); border-color: #fecdd3; }
    .conn.wait .conn-dot {
      background: #ca8a04;
      animation: pulse 1s ease-in-out infinite;
    }
    .conn.wait { color: #a16207; border-color: #fde68a; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
  </style>
</head>
<body>
  <main>
    <div class="brand-wrap">
      <div class="brand">
        <img src="/logo.png" width="64" height="64" alt="BTC Manual Buy" />
        <h1>BTC Manual Buy</h1>
      </div>
      <div class="conn wait" id="connStatus" title="Server + market feed">
        <span class="conn-dot" aria-hidden="true"></span>
        <span id="connLabel">Connecting…</span>
      </div>
    </div>
    <section class="panel">
      <div class="chips" id="windowChips"></div>
      <form class="grid" id="buyForm">
        <label>
          Market slug
          <input id="slug" name="slug" autocomplete="off" placeholder="btc-updown-5m-…" required />
        </label>
        <p class="market-meta" id="marketMeta">Select a window to load prices.</p>
        <div>
          <label style="margin-bottom:0.45rem">Side</label>
          <div class="side-pick" role="radiogroup" aria-label="Side">
            <button type="button" class="side-card active-up" id="sideUp" data-side="Up" aria-pressed="true">
              <div class="name">Up</div>
              <div class="px"><strong id="upMid">—</strong></div>
            </button>
            <button type="button" class="side-card" id="sideDown" data-side="Down" aria-pressed="false">
              <div class="name">Down</div>
              <div class="px"><strong id="downMid">—</strong></div>
            </button>
          </div>
          <input type="hidden" id="side" name="side" value="Up" />
        </div>
        <label>
          Amount (USDC)
          <input id="amount" name="amount" type="number" min="0.01" step="0.01" value="10" placeholder="Buy size · blank = sell all" />
        </label>
        <div class="actions">
          <button type="button" class="action ghost" id="previewBtn">Preview</button>
          <button type="submit" class="action primary" id="buyBtn">Buy</button>
          <button type="button" class="action sell" id="sellBtn">Sell</button>
        </div>
      </form>
      <div class="out" id="out">Load windows, pick a side, preview, then buy or sell.</div>
    </section>
  </main>
  <script>
    const out = document.getElementById("out");
    const slugEl = document.getElementById("slug");
    const sideEl = document.getElementById("side");
    const amountEl = document.getElementById("amount");
    const chips = document.getElementById("windowChips");
    const marketMeta = document.getElementById("marketMeta");
    const sideUp = document.getElementById("sideUp");
    const sideDown = document.getElementById("sideDown");
    const buttons = [
      document.getElementById("previewBtn"),
      document.getElementById("buyBtn"),
      document.getElementById("sellBtn"),
    ];
    /** @type {{ interval: string, label: string } | null} */
    let follow = { interval: "5m", label: "current" };
    let latestWindows = [];
    let priceSeq = 0;
    let priceInFlight = false;
    let windowInFlight = false;

    const connEl = document.getElementById("connStatus");
    const connLabel = document.getElementById("connLabel");
    let lastOkAt = 0;
    let failStreak = 0;

    function setConn(state, text) {
      connEl.className = "conn " + state;
      connLabel.textContent = text;
    }

    function markLive(detail) {
      failStreak = 0;
      lastOkAt = Date.now();
      setConn("live", detail || "Connected");
    }

    function markFail(err) {
      failStreak += 1;
      if (!navigator.onLine) {
        setConn("down", "Offline");
        return;
      }
      if (failStreak === 1 && lastOkAt && Date.now() - lastOkAt < 4000) {
        setConn("wait", "Reconnecting…");
        return;
      }
      setConn("down", err ? "Disconnected · " + err : "Disconnected");
    }

    function setBusy(busy) {
      for (const b of buttons) b.disabled = busy;
      sideUp.disabled = busy;
      sideDown.disabled = busy;
    }

    function show(msg, cls) {
      out.className = "out" + (cls ? " " + cls : "");
      out.textContent = typeof msg === "string" ? msg : JSON.stringify(msg, null, 2);
    }

    function fmt(n) {
      if (n == null || !Number.isFinite(n)) return "—";
      return n.toFixed(2);
    }

    function setSide(side) {
      sideEl.value = side;
      const upOn = side === "Up";
      sideUp.className = "side-card" + (upOn ? " active-up" : "");
      sideDown.className = "side-card" + (!upOn ? " active-down" : "");
      sideUp.setAttribute("aria-pressed", upOn ? "true" : "false");
      sideDown.setAttribute("aria-pressed", upOn ? "false" : "true");
    }

    function paintPrices(data) {
      marketMeta.textContent = (data.question || data.slug) + (data.endDate ? " · ends " + data.endDate : "");
      document.getElementById("upMid").textContent = fmt(data.up.mid);
      document.getElementById("downMid").textContent = fmt(data.down.mid);
    }

    function highlightChips() {
      for (const c of chips.querySelectorAll(".chip")) {
        const on =
          follow &&
          c.dataset.interval === follow.interval &&
          c.dataset.label === follow.label;
        c.classList.toggle("active", !!on);
      }
    }

    function applyFollowSlug(forcePrice) {
      if (!follow) return false;
      const hit = latestWindows.find(
        (w) => w.interval === follow.interval && w.label === follow.label
      );
      if (!hit) return false;
      const changed = slugEl.value !== hit.slug;
      if (changed) {
        slugEl.value = hit.slug;
        refreshPrices();
        return true;
      }
      if (forcePrice) refreshPrices();
      return false;
    }

    async function refreshPrices() {
      const slug = slugEl.value.trim();
      if (!slug || priceInFlight) return;
      priceInFlight = true;
      const seq = ++priceSeq;
      try {
        const res = await fetch("/api/prices?slug=" + encodeURIComponent(slug));
        const data = await res.json();
        if (seq !== priceSeq) return;
        if (!res.ok) throw new Error(data.error || "prices failed");
        paintPrices(data);
        markLive("Live · prices ok");
      } catch (e) {
        if (seq !== priceSeq) return;
        marketMeta.textContent = String(e.message || e);
        markFail(String(e.message || e));
      } finally {
        priceInFlight = false;
      }
    }

    function renderWindowChips() {
      chips.innerHTML = "";
      for (const w of latestWindows) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chip";
        btn.dataset.interval = w.interval;
        btn.dataset.label = w.label;
        btn.textContent = "BTC " + w.interval + " " + w.label;
        btn.title = w.slug;
        btn.addEventListener("click", () => {
          follow = { interval: w.interval, label: w.label };
          highlightChips();
          slugEl.value = w.slug;
          refreshPrices();
        });
        chips.appendChild(btn);
      }
      highlightChips();
    }

    async function syncWindows() {
      if (windowInFlight) return;
      windowInFlight = true;
      try {
        const res = await fetch("/api/windows");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "windows failed");
        const prev = latestWindows.map((w) => w.slug).join("|");
        latestWindows = data.windows || [];
        const next = latestWindows.map((w) => w.slug).join("|");
        if (prev !== next || !chips.childElementCount) {
          renderWindowChips();
        }
        applyFollowSlug(false);
        if (!slugEl.value.trim()) markLive("Connected");
      } catch (e) {
        if (!chips.childElementCount) show(String(e.message || e), "err");
        markFail(String(e.message || e));
      } finally {
        windowInFlight = false;
      }
    }

    async function pingHealth() {
      try {
        const res = await fetch("/api/health");
        const data = await res.json();
        if (!res.ok || data.ok !== true) throw new Error(data.error || "health failed");
        if (!slugEl.value.trim()) markLive("Connected · CLOB ready");
        return true;
      } catch (e) {
        markFail(String(e.message || e));
        return false;
      }
    }

    async function post(path, body) {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      return data;
    }

    function payload(dryRun) {
      const raw = amountEl.value.trim();
      const amountUsdc = raw === "" ? null : Number(raw);
      return {
        slug: slugEl.value.trim(),
        side: sideEl.value,
        amountUsdc,
        dryRun: !!dryRun,
      };
    }

    function requireBuyAmount(p) {
      if (!(p.amountUsdc > 0)) throw new Error("Enter a USDC amount to buy");
    }

    sideUp.addEventListener("click", () => setSide("Up"));
    sideDown.addEventListener("click", () => setSide("Down"));
    slugEl.addEventListener("input", () => {
      // Manual slug edit: stop auto-follow until a window chip is clicked again.
      follow = null;
      highlightChips();
    });
    slugEl.addEventListener("change", () => refreshPrices());
    slugEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        refreshPrices();
      }
    });

    document.getElementById("previewBtn").addEventListener("click", async () => {
      setBusy(true);
      try {
        const p = payload(true);
        requireBuyAmount(p);
        const data = await post("/api/preview", p);
        show(data, "ok");
        refreshPrices();
      } catch (e) {
        show(String(e.message || e), "err");
      } finally {
        setBusy(false);
      }
    });

    document.getElementById("sellBtn").addEventListener("click", async () => {
      const p = payload(false);
      const all = p.amountUsdc == null;
      const msg = all
        ? "Sell ALL " + sideEl.value + " shares on this market?"
        : "Sell ~$" + p.amountUsdc + " of " + sideEl.value + "?";
      if (!confirm(msg)) return;
      setBusy(true);
      try {
        const data = await post("/api/sell", p);
        show(data, "ok");
        refreshPrices();
      } catch (e) {
        show(String(e.message || e), "err");
      } finally {
        setBusy(false);
      }
    });

    document.getElementById("buyForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        const p = payload(false);
        requireBuyAmount(p);
        if (!confirm("Place a real BUY for $" + p.amountUsdc + " on " + sideEl.value + "?")) return;
        setBusy(true);
        try {
          const data = await post("/api/buy", p);
          show(data, "ok");
          refreshPrices();
        } finally {
          setBusy(false);
        }
      } catch (e) {
        show(String(e.message || e), "err");
      }
    });

    setSide("Up");
    window.addEventListener("online", () => {
      setConn("wait", "Reconnecting…");
      pingHealth();
      syncWindows();
      refreshPrices();
    });
    window.addEventListener("offline", () => setConn("down", "Offline"));

    pingHealth()
      .then(() => syncWindows())
      .then(() => {
        applyFollowSlug(true);
        setInterval(syncWindows, 1000);
        setInterval(refreshPrices, 500);
        setInterval(pingHealth, 5000);
      })
      .catch((e) => {
        markFail(String(e.message || e));
        show(String(e.message || e), "err");
      });
  </script>
</body>
</html>`;

async function main(): Promise<void> {
  const cwd = process.cwd();
  await mkdir(resolve(cwd, "logs"), { recursive: true });

  console.log("Loading wallet / CLOB credentials…");
  const shared = await loadCopyTradeSharedCredentials();
  const cfg = mergeCopyTradeConfig(shared, dummyTargetParams(cwd));
  const client = await ensureClobClient(cfg);
  console.log("CLOB client ready.");

  let logoPng: Buffer;
  try {
    logoPng = await readFile(LOGO_PATH);
  } catch {
    throw new Error(`Logo missing at ${LOGO_PATH}`);
  }

  const host = process.env["BUY_UI_HOST"]?.trim() || DEFAULT_HOST;
  const port = Math.max(1, parseInt(process.env["BUY_UI_PORT"]?.trim() || String(DEFAULT_PORT), 10) || DEFAULT_PORT);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/") {
        sendHtml(res, PAGE_HTML);
        return;
      }

      if (req.method === "GET" && (pathname === "/logo.png" || pathname === "/favicon.ico")) {
        sendPng(res, logoPng);
        return;
      }

      if (req.method === "GET" && pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          clob: true,
          funder: shared.funderAddress ?? null,
          ts: Date.now(),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/windows") {
        sendJson(res, 200, { windows: btcWindows(), now: Date.now() });
        return;
      }

      if (req.method === "GET" && pathname === "/api/prices") {
        const slug = url.searchParams.get("slug")?.trim() || "";
        if (!slug) {
          sendJson(res, 400, { error: "slug query param is required" });
          return;
        }
        const prices = await fetchMarketPrices(client, slug);
        sendJson(res, 200, prices);
        return;
      }

      if (req.method === "POST" && (pathname === "/api/preview" || pathname === "/api/buy")) {
        const raw = await readBody(req);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw || "{}") as Record<string, unknown>;
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" });
          return;
        }

        const slug = String(body.slug ?? "").trim();
        const sideRaw = String(body.side ?? "Up").trim();
        const side = (sideRaw === "Down" ? "Down" : sideRaw === "Up" ? "Up" : "") as SideLabel | "";
        const amountUsdc = Number(body.amountUsdc);
        const dryRun = body.dryRun === true || pathname === "/api/preview";

        if (!slug) {
          sendJson(res, 400, { error: "slug is required" });
          return;
        }
        if (side !== "Up" && side !== "Down") {
          sendJson(res, 400, { error: 'side must be "Up" or "Down"' });
          return;
        }
        if (!(amountUsdc > 0)) {
          sendJson(res, 400, { error: "amountUsdc must be > 0" });
          return;
        }

        const plan = await planBuy(client, slug, side, amountUsdc);
        if (dryRun || pathname === "/api/preview") {
          sendJson(res, 200, { dryRun: true, plan });
          return;
        }

        const resp = await withSuppressedPolymarketClobConsole(() =>
          client.createAndPostOrder(
            {
              tokenID: plan.tokenId,
              price: plan.limitPrice,
              side: Side.BUY,
              size: plan.shares,
            },
            { tickSize: plan.tickSize, negRisk: plan.negRisk },
            OrderType.GTC
          )
        );

        console.log(
          `buy · ${plan.slug} ${plan.side} · $${plan.usdc.toFixed(2)} · ${plan.shares.toFixed(4)} sh @ ${plan.limitPrice}`
        );
        sendJson(res, 200, { dryRun: false, plan, response: resp });
        return;
      }

      if (req.method === "POST" && pathname === "/api/sell") {
        const raw = await readBody(req);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw || "{}") as Record<string, unknown>;
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" });
          return;
        }

        const slug = String(body.slug ?? "").trim();
        const sideRaw = String(body.side ?? "Up").trim();
        const side = (sideRaw === "Down" ? "Down" : sideRaw === "Up" ? "Up" : "") as SideLabel | "";
        const amountRaw = body.amountUsdc;
        const amountUsdc =
          amountRaw === null || amountRaw === undefined || amountRaw === ""
            ? null
            : Number(amountRaw);
        const dryRun = body.dryRun === true;

        if (!slug) {
          sendJson(res, 400, { error: "slug is required" });
          return;
        }
        if (side !== "Up" && side !== "Down") {
          sendJson(res, 400, { error: 'side must be "Up" or "Down"' });
          return;
        }
        if (amountUsdc !== null && !(amountUsdc > 0)) {
          sendJson(res, 400, { error: "amountUsdc must be > 0, or omit/blank to sell all" });
          return;
        }

        const plan = await planSell(client, slug, side, amountUsdc);
        if (dryRun) {
          sendJson(res, 200, { dryRun: true, plan });
          return;
        }

        const resp = await withSuppressedPolymarketClobConsole(() =>
          client.createAndPostOrder(
            {
              tokenID: plan.tokenId,
              price: plan.limitPrice,
              side: Side.SELL,
              size: plan.shares,
            },
            { tickSize: plan.tickSize, negRisk: plan.negRisk },
            OrderType.GTC
          )
        );

        console.log(
          `sell · ${plan.slug} ${plan.side} · ${plan.sellAll ? "ALL" : "$" + plan.usdc.toFixed(2)} · ${plan.shares.toFixed(4)} sh @ ${plan.limitPrice}`
        );
        sendJson(res, 200, { dryRun: false, plan, response: resp });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("request error:", msg);
      sendJson(res, 500, { error: msg });
    }
  });

  server.listen(port, host, () => {
    console.log(`BTC Manual Buy UI → http://${host}:${port}`);
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
