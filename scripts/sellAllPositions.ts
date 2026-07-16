/**
 * Sell ALL open positions held by the copy wallet — a manual "flatten my account" tool. Independent
 * of copy targets: it lists every outcome token the wallet currently holds and posts a marketable
 * SELL (at the best bid) to liquidate each.
 *
 * SAFETY: preview-only by default. It prints what it WOULD sell and stops. Pass `--execute` to
 * actually place the sell orders (spends/moves real positions).
 *
 *   npm run sell-all                          # preview ALL positions
 *   npm run sell-all -- --execute             # actually sell everything
 *   npm run sell-all -- --min-usd 1           # skip positions worth less than $1 (default 0.01)
 *
 * Sell an INDIVIDUAL market/position (combine with --execute to actually sell):
 *   npm run sell-all -- --market "Bitcoin"    # only positions whose market/outcome matches (substring, case-insensitive)
 *   npm run sell-all -- --slug btc-updown-5m-1782372900   # only positions in this market/event slug
 *   npm run sell-all -- --token 1003138...    # only this exact outcome token
 *
 * Uses the same wallet/funder/signature as copy trading (env: FUNDER_ADDRESS, wallet key, CLOB_*).
 * Positions are enumerated from Polymarket's data-api; sizes are confirmed on-chain via the CLOB
 * balance before selling. Resolved markets (no live book) are skipped — redeem those separately.
 */

import "dotenv/config";
import { resolve } from "path";
import { formatUnits } from "ethers";
import { AssetType, OrderType, Side } from "@polymarket/clob-client-v2";
import { withSuppressedPolymarketClobConsole } from "../src/clobConsoleSuppress.js";
import { loadCopyTradeSharedCredentials, mergeCopyTradeConfig, type TargetCopyParams } from "../src/env.js";
import { ensureClobClient } from "../src/copyTrade.js";

const DATA_API = "https://data-api.polymarket.com/positions";

const execute = process.argv.includes("--execute");
const minUsdArg = process.argv.indexOf("--min-usd");
const minUsd = minUsdArg >= 0 ? Math.max(0, parseFloat(process.argv[minUsdArg + 1] ?? "0") || 0) : 0.01;
const tokenArg = process.argv.indexOf("--token");
const onlyToken = tokenArg >= 0 ? (process.argv[tokenArg + 1] ?? "").trim() : "";
const marketArg = process.argv.indexOf("--market");
const onlyMarket = marketArg >= 0 ? (process.argv[marketArg + 1] ?? "").trim().toLowerCase() : "";
const slugArg = process.argv.indexOf("--slug");
const onlySlug = slugArg >= 0 ? (process.argv[slugArg + 1] ?? "").trim().toLowerCase() : "";

type Position = { tokenId: string; title: string; outcome: string; slug: string; eventSlug: string };

function bestBid(book: { bids?: { price: string }[] }): number | null {
  if (!book?.bids?.length) return null;
  let max = -Infinity;
  for (const b of book.bids) {
    const p = parseFloat(b.price);
    if (!Number.isNaN(p)) max = Math.max(max, p);
  }
  return max === -Infinity ? null : max;
}

function roundDownTick(price: number, tickStr: string): number {
  const t = parseFloat(tickStr);
  return Math.max(0, Math.floor(price / t + 1e-12) * t);
}

function dummyTargetParams(cwd: string): TargetCopyParams {
  return {
    address: "0x0000000000000000000000000000000000000001",
    copyRatio: 1,
    maxPriceDifference: 1,
    minPositionUsdc: 0,
    maxPositionUsdc: 1e12,
    copyTradeLogPath: resolve(cwd, "logs", "sell-all.log"),
  };
}

/** Enumerate the wallet's current positions from the data-api (retries on flaky 5xx). */
async function fetchPositions(wallet: string): Promise<Position[]> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${DATA_API}?user=${wallet}&limit=500&sizeThreshold=0.0001`, {
        headers: { "user-agent": "copybot-sell-all" },
      });
      if (res.ok) {
        const data = (await res.json()) as Array<Record<string, unknown>>;
        const out: Position[] = [];
        for (const p of data) {
          const tokenId = String(p["asset"] ?? "");
          if (tokenId) {
            out.push({
              tokenId,
              title: String(p["title"] ?? ""),
              outcome: String(p["outcome"] ?? ""),
              slug: String(p["slug"] ?? ""),
              eventSlug: String(p["eventSlug"] ?? ""),
            });
          }
        }
        return out;
      }
    } catch {
      // fall through to retry
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  throw new Error("data-api positions unavailable after retries");
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const shared = await loadCopyTradeSharedCredentials();
  const cfg = mergeCopyTradeConfig(shared, dummyTargetParams(cwd));
  const wallet = cfg.funderAddress;
  if (!wallet || /^0x0+$/.test(wallet)) {
    throw new Error("FUNDER_ADDRESS not set — cannot identify the wallet whose positions to sell");
  }

  console.log(`Wallet: ${wallet}`);
  console.log(execute ? "MODE: EXECUTE — will place real SELL orders" : "MODE: preview only (pass --execute to sell)");
  if (onlyToken) console.log(`Filter: token = ${onlyToken}`);
  if (onlyMarket) console.log(`Filter: market/outcome contains "${onlyMarket}"`);
  if (onlySlug) console.log(`Filter: slug contains "${onlySlug}"`);
  console.log(`Skipping positions worth < $${minUsd}\n`);

  let positions = await fetchPositions(wallet);
  const total = positions.length;
  if (onlyToken) positions = positions.filter((p) => p.tokenId === onlyToken);
  if (onlyMarket) positions = positions.filter((p) => `${p.title} ${p.outcome}`.toLowerCase().includes(onlyMarket));
  if (onlySlug) positions = positions.filter((p) => `${p.slug} ${p.eventSlug}`.toLowerCase().includes(onlySlug));
  if (positions.length === 0) {
    console.log(total === 0 ? "No open positions found." : `No positions matched the filter (of ${total} held).`);
    return;
  }

  const client = await ensureClobClient(cfg);
  let sold = 0;
  let skipped = 0;
  let estProceeds = 0;

  for (const pos of positions) {
    const label = `${pos.title || "?"} / ${pos.outcome || "?"}`;
    try {
      // True sellable balance from the CLOB (authoritative), not the data-api estimate.
      const bal = await client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: pos.tokenId });
      const size = parseFloat(formatUnits(BigInt(String(bal.balance)), 6));
      if (!Number.isFinite(size) || size <= 0) {
        continue; // nothing actually held (already sold/redeemed)
      }

      const [tickSize, negRisk, book] = await Promise.all([
        client.getTickSize(pos.tokenId),
        client.getNegRisk(pos.tokenId),
        client.getOrderBook(pos.tokenId),
      ]);
      const bid = bestBid(book);
      if (bid === null) {
        console.log(`SKIP  ${label} · ${size.toFixed(2)} sh · no bids (market resolved? redeem instead) · token=${pos.tokenId}`);
        skipped++;
        continue;
      }
      const price = roundDownTick(bid, tickSize);
      const value = size * price;
      const minOrder = parseFloat(book.min_order_size);
      if (value < minUsd || (Number.isFinite(minOrder) && size < minOrder)) {
        console.log(`SKIP  ${label} · ${size.toFixed(2)} sh @ ${price} ≈ $${value.toFixed(2)} · below min · token=${pos.tokenId}`);
        skipped++;
        continue;
      }

      if (!execute) {
        console.log(`WOULD SELL  ${label} · ${size.toFixed(2)} sh @ ${price} ≈ $${value.toFixed(2)} · token=${pos.tokenId}`);
        estProceeds += value;
        sold++;
        continue;
      }

      const resp = await withSuppressedPolymarketClobConsole(() =>
        client.createAndPostOrder(
          { tokenID: pos.tokenId, price, side: Side.SELL, size },
          { tickSize, negRisk },
          OrderType.GTC
        )
      );
      const r = resp as { takingAmount?: string; makingAmount?: string; status?: string };
      const filledSh = parseFloat(r.makingAmount ?? "0") || 0;
      const filledUsd = parseFloat(r.takingAmount ?? "0") || 0;
      console.log(
        `SOLD  ${label} · posted ${size.toFixed(2)} sh @ ${price} · filled ${filledSh.toFixed(2)} sh ($${filledUsd.toFixed(2)}) · status=${r.status ?? "?"} · token=${pos.tokenId}`
      );
      estProceeds += filledUsd;
      sold++;
    } catch (e) {
      console.log(`ERROR ${label} · ${e instanceof Error ? e.message : String(e)} · token=${pos.tokenId}`);
      skipped++;
    }
  }

  console.log(
    `\n${execute ? "Done" : "Preview"}: ${sold} position(s) ${execute ? "sold" : "to sell"}, ${skipped} skipped · ${execute ? "proceeds" : "est. proceeds"} ≈ $${estProceeds.toFixed(2)}`
  );
  if (!execute && sold > 0) {
    console.log("Re-run with --execute to actually place these sell orders.");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
