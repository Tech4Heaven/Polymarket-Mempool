import {
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
import { fetchPolymarketEventLabel } from "./gammaEventName.js";

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

async function logCopySkip(reasonDetail: string, digest: CopyDigest, txHash: string): Promise<void> {
  const event = await fetchPolymarketEventLabel(digest.tokenId);
  console.log(`copy skip · ${reasonDetail} · tx=${txHash} · event=${JSON.stringify(event)}`);
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

/**
 * Sizes with **shares = (pUSD_notional × COPY_RATIO, clipped) / currentPrice**, where `currentPrice` comes from
 * the CLOB (`getMidpoint`, then `getPrice` fallback). Posts a marketable GTC limit at/through the book.
 */
export async function executeCopyTrade(cfg: CopyTradeConfig, digest: CopyDigest, txHash: string): Promise<void> {
  const implied = impliedPrice(digest.pusdRaw, digest.outcomeRaw);
  if (!Number.isFinite(implied) || implied <= 0) {
    await logCopySkip(`bad implied on-chain price · token=${digest.tokenId}`, digest, txHash);
    return;
  }

  const client = await ensureClobClient(cfg);

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
    await logCopySkip(`could not parse CLOB price · token=${digest.tokenId}`, digest, txHash);
    return;
  }

  if (digest.side === "buy") {
    const drift = currentPrice - implied;
    if (drift > cfg.maxPriceDifference) {
      await logCopySkip(
        `price drift buy · implied(on-chain)=${implied.toFixed(4)} clob=${currentPrice.toFixed(4)} drift=${drift.toFixed(4)} maxΔ=${cfg.maxPriceDifference}`,
        digest,
        txHash
      );
      return;
    }
  }

  const usdcNotional = parseFloat(formatUnits(digest.pusdRaw, 6)) * cfg.copyRatio;
  const clippedUsdc = clamp(usdcNotional, cfg.minPositionUsdc, cfg.maxPositionUsdc);
  const orderShares = clippedUsdc / currentPrice;

  const minOrder = parseFloat(book.min_order_size);
  if (!Number.isNaN(minOrder) && orderShares < minOrder) {
    await logCopySkip(`size ${orderShares} < min_order_size ${book.min_order_size}`, digest, txHash);
    return;
  }

  let limitPrice: number;
  if (digest.side === "buy") {
    const ask = bestAsk(book);
    if (ask === null) {
      await logCopySkip("empty asks", digest, txHash);
      return;
    }
    limitPrice = roundToTick(Math.max(currentPrice, ask), tickSize, "up");
  } else {
    const bid = bestBid(book);
    if (bid === null) {
      await logCopySkip("empty bids", digest, txHash);
      return;
    }
    limitPrice = roundToTick(Math.min(currentPrice, bid), tickSize, "down");
  }

  const side = digest.side === "buy" ? Side.BUY : Side.SELL;

  if (cfg.dryRun) {
    const eventLabel = await fetchPolymarketEventLabel(digest.tokenId);
    const msg =
      `[DRY RUN] would post GTC · side=${digest.side} tokenID=${digest.tokenId} size=${orderShares} limitPrice=${limitPrice} tickSize=${tickSize} negRisk=${negRisk} · implied=${implied.toFixed(4)} clobMid~${currentPrice.toFixed(4)} · tx=${txHash} · event=${JSON.stringify(eventLabel)}`;
    console.log(msg);
    void appendCopyTradeSuccessLine(msg);
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

  const eventLabel = await fetchPolymarketEventLabel(digest.tokenId);
  const msg = `copy posted · ${digest.side} shares=${orderShares} limit=${limitPrice} mid~${currentPrice} implied=${implied.toFixed(4)} · tx=${txHash} · ${JSON.stringify(resp)} · event=${JSON.stringify(eventLabel)}`;
  console.log(msg);
  void appendCopyTradeSuccessLine(msg);
}
