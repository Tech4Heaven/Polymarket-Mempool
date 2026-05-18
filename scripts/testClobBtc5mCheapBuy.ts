/**
 * Standalone CLOB smoke test: resolve the **current** Polymarket **BTC 5m Up/Down** market via Gamma
 * (`/events`, slug `btc-updown-5m-*`), buy the **cheaper** leg at CLOB mid (~`CLOB_TEST_USDC` USDC, raised
 * for `min_order_size`), and post a GTC buy using the same wallet/funder/`CLOB_SIGNATURE_TYPE` as copy trading.
 * Does **not** require `COPY_TRADING_ENABLED`.
 *
 * Usage: `npm run test-clob-btc-5m` — posts a real order (spends USDC). Pass `--dry-run` to print the plan only.
 *
 * Env: same as copy trading (`CLOB_SIGNATURE_TYPE`, `FUNDER_ADDRESS`, wallet JSON / key, `POLYGON_HTTP_URL`, …).
 * Optional: `CLOB_TEST_USDC` — target notional (default 1); bumped if below book minimum.
 */

import "dotenv/config";
import { mkdir } from "fs/promises";
import { resolve } from "path";
import { OrderType, Side } from "@polymarket/clob-client-v2";
import { withSuppressedPolymarketClobConsole } from "../src/clobConsoleSuppress.js";
import { loadCopyTradeSharedCredentials, mergeCopyTradeConfig, type TargetCopyParams } from "../src/env.js";
import { ensureClobClient } from "../src/copyTrade.js";
import { fetchPolymarketMarketLabels } from "../src/gammaEventName.js";

const GAMMA_EVENTS = "https://gamma-api.polymarket.com/events";
const EVENTS_PAGE = 500;

type GammaNestedMarket = {
  question?: string;
  endDate?: string;
  acceptingOrders?: boolean;
  closed?: boolean;
  enableOrderBook?: boolean;
  clobTokenIds?: unknown;
  outcomes?: unknown;
  outcomePrices?: unknown;
  orderMinSize?: unknown;
};

type GammaEvent = {
  slug?: string;
  title?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  markets?: GammaNestedMarket[];
};

function parseJsonStringArray(raw: unknown): string[] | null {
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw) as unknown;
      if (Array.isArray(p) && p.every((x) => typeof x === "string")) {
        return p as string[];
      }
    } catch {
      return null;
    }
  }
  if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) {
    return raw as string[];
  }
  return null;
}

async function fetchRecentEvents(): Promise<GammaEvent[]> {
  const url = new URL(GAMMA_EVENTS);
  url.searchParams.set("limit", String(EVENTS_PAGE));
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("order", "id");
  url.searchParams.set("ascending", "false");
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gamma events HTTP ${res.status}`);
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("Gamma events: expected array");
  }
  return data as GammaEvent[];
}

/**
 * Current **active** BTC 5m window: Gamma lists many `btc-updown-5m-*` events; pick the open one whose
 * `endDate` is soonest in the future (the live candle).
 */
async function discoverCurrentBtc5mMarket(): Promise<GammaNestedMarket> {
  const now = Date.now();
  const events = await fetchRecentEvents();
  let best: { end: number; market: GammaNestedMarket } | null = null;

  for (const ev of events) {
    const slug = typeof ev.slug === "string" ? ev.slug : "";
    if (!slug.startsWith("btc-updown-5m-")) {
      continue;
    }
    if (ev.closed === true || ev.active === false) {
      continue;
    }
    const m0 = ev.markets?.[0];
    if (!m0) {
      continue;
    }
    if (m0.closed === true || m0.acceptingOrders === false || m0.enableOrderBook === false) {
      continue;
    }
    const endRaw = m0.endDate ?? ev.endDate;
    if (typeof endRaw !== "string") {
      continue;
    }
    const end = Date.parse(endRaw);
    if (!Number.isFinite(end) || end <= now) {
      continue;
    }
    if (!best || end < best.end) {
      best = { end, market: m0 };
    }
  }

  if (!best) {
    throw new Error(
      "No open btc-updown-5m event found in the latest Gamma events page. Polymarket may have changed slugs or the API; try again in a few seconds."
    );
  }
  return best.market;
}

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

async function midpointOrBuyPrice(
  client: Awaited<ReturnType<typeof ensureClobClient>>,
  tokenId: string
): Promise<number | null> {
  const midRaw = await client.getMidpoint(tokenId);
  let p = parseClobPrice(midRaw);
  if (p !== null) {
    return p;
  }
  const pxRaw = await client.getPrice(tokenId, Side.BUY);
  p = parseClobPrice(pxRaw);
  return p;
}

function bestAsk(book: { asks: { price: string }[] }): number | null {
  if (!book.asks.length) {
    return null;
  }
  let min = Infinity;
  for (const a of book.asks) {
    const x = parseFloat(a.price);
    if (!Number.isNaN(x)) {
      min = Math.min(min, x);
    }
  }
  return min === Infinity ? null : min;
}

function roundToTick(price: number, tickStr: string, mode: "up" | "down"): number {
  const t = parseFloat(tickStr);
  if (mode === "up") {
    return Math.min(1, Math.ceil(price / t - 1e-12) * t);
  }
  return Math.max(0, Math.floor(price / t + 1e-12) * t);
}

function dummyTargetParams(cwd: string): TargetCopyParams {
  return {
    address: "0x0000000000000000000000000000000000000001",
    copyRatio: 1,
    maxPriceDifference: 1,
    minPositionUsdc: 0,
    maxPositionUsdc: 1e12,
    copyTradeLogPath: resolve(cwd, "logs", "clob-test-smoke.log"),
  };
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const dryRun = process.argv.includes("--dry-run");
  const targetUsdc = Math.max(0.01, parseFloat(process.env["CLOB_TEST_USDC"]?.trim() || "1") || 1);

  const shared = await loadCopyTradeSharedCredentials();
  const cfg = mergeCopyTradeConfig(shared, dummyTargetParams(cwd));
  await mkdir(resolve(cwd, "logs"), { recursive: true });

  const gammaMarket = await discoverCurrentBtc5mMarket();
  const ids = parseJsonStringArray(gammaMarket.clobTokenIds);
  const outcomes = parseJsonStringArray(gammaMarket.outcomes);
  if (!ids || ids.length < 2) {
    throw new Error("BTC 5m Gamma market missing clobTokenIds");
  }

  console.log(`Gamma · ${gammaMarket.question ?? "?"} · endDate=${gammaMarket.endDate ?? "?"}`);

  const client = await ensureClobClient(cfg);

  const prices: number[] = [];
  for (const tid of ids) {
    const px = await midpointOrBuyPrice(client, tid);
    prices.push(px ?? Number.POSITIVE_INFINITY);
  }
  let cheapIdx = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i]! < prices[cheapIdx]!) {
      cheapIdx = i;
    }
  }
  if (!Number.isFinite(prices[cheapIdx]!) || prices[cheapIdx]! <= 0) {
    throw new Error("Could not read CLOB mid / buy price for BTC 5m legs (no book yet?)");
  }

  const tokenId = ids[cheapIdx]!;
  const label = outcomes?.[cheapIdx] ?? `index ${cheapIdx}`;
  console.log(
    `Cheap leg · ${label} · mid≈${prices[cheapIdx]!.toFixed(4)} · tokenId=${tokenId}`
  );

  const [tickSize, negRisk, book, midRaw] = await Promise.all([
    client.getTickSize(tokenId),
    client.getNegRisk(tokenId),
    client.getOrderBook(tokenId),
    client.getMidpoint(tokenId),
  ]);

  let currentPrice = parseClobPrice(midRaw);
  if (currentPrice === null) {
    const pxRaw = await client.getPrice(tokenId, Side.BUY);
    currentPrice = parseClobPrice(pxRaw);
  }
  if (currentPrice === null) {
    throw new Error("Could not parse CLOB midpoint/price for chosen leg");
  }

  const ask = bestAsk(book);
  if (ask === null) {
    throw new Error("No asks on book — cannot place a marketable buy");
  }
  const limitPrice = roundToTick(Math.max(currentPrice, ask), tickSize, "up");

  const minSharesRaw = gammaMarket.orderMinSize ?? book.min_order_size;
  const minShares = parseFloat(String(minSharesRaw));
  const minUsdc = Number.isFinite(minShares) && minShares > 0 ? minShares * limitPrice : 0;
  const usdc = Math.max(targetUsdc, minUsdc > 0 ? minUsdc * 1.000001 : targetUsdc);
  if (usdc > targetUsdc + 1e-9) {
    console.log(
      `Raised USDC notional from ${targetUsdc.toFixed(4)} to ${usdc.toFixed(4)} to satisfy min order size (~${minShares} shares @ ${limitPrice}).`
    );
  }

  const orderShares = usdc / limitPrice;
  const minOrder = parseFloat(book.min_order_size);
  if (!Number.isNaN(minOrder) && orderShares < minOrder) {
    throw new Error(`Computed shares ${orderShares} < min_order_size ${book.min_order_size}`);
  }

  const labels = await fetchPolymarketMarketLabels(tokenId);
  console.log(
    `Plan · BUY tokenId=${tokenId} shares=${orderShares.toFixed(6)} ~$${usdc.toFixed(2)} USDC @ limit=${limitPrice} tick=${tickSize} negRisk=${negRisk} · ${labels.event} / ${labels.outcome}`
  );

  if (dryRun) {
    console.log("Dry run: no order posted (omit `--dry-run` to submit).");
    return;
  }

  const resp = await withSuppressedPolymarketClobConsole(() =>
    client.createAndPostOrder(
      { tokenID: tokenId, price: limitPrice, side: Side.BUY, size: orderShares },
      { tickSize, negRisk },
      OrderType.GTC
    )
  );
  console.log("Posted ·", JSON.stringify(resp));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
