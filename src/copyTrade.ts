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

async function logCopySkip(reasonDetail: string, digest: CopyDigest, txHash: string): Promise<void> {
  const { event, outcome } = await fetchPolymarketMarketLabels(digest.tokenId);
  const msg = `copy skip · ${reasonDetail} · event=${JSON.stringify(event)} outcome=${JSON.stringify(outcome)} · tx=${txHash}`;
  console.log(msg);
  void appendCopyTradeSuccessLine(msg);
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
  const originPusd = parseFloat(formatUnits(digest.pusdRaw, 6));
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
        `price drift buy · implied(on-chain)=${implied.toFixed(4)} clob=${currentPrice.toFixed(4)} drift=${drift.toFixed(4)} maxΔ=${cfg.maxPriceDifference} · ${formatOriginTradeSizing(digest)}`,
        digest,
        txHash
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
        txHash
      );
      return;
    }
    clippedUsdc = clamp(usdcNotional, cfg.minPositionUsdc, cfg.maxPositionUsdc);
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
      await logCopySkip(`invalid balance response · token=${digest.tokenId}`, digest, txHash);
      return;
    }
    if (!Number.isFinite(fullBalance) || fullBalance <= 0) {
      await logCopySkip(`no balance to sell · token=${digest.tokenId}`, digest, txHash);
      return;
    }
    orderShares = fullBalance;
  }

  const minOrder = parseFloat(book.min_order_size);
  if (!Number.isNaN(minOrder) && orderShares < minOrder) {
    await logCopySkip(`size ${orderShares} < min_order_size ${book.min_order_size}`, digest, txHash);
    return;
  }

  const side = digest.side === "buy" ? Side.BUY : Side.SELL;

  if (cfg.dryRun) {
    const { event, outcome } = await fetchPolymarketMarketLabels(digest.tokenId);
    const pUsdForLog = digest.side === "buy" ? (clippedUsdc ?? 0) : originPusd;
    const msg =
      `[DRY RUN] would post GTC · side=${digest.side} shares=${orderShares} pUSD=${pUsdForLog.toFixed(6)} · event=${JSON.stringify(event)} outcome=${JSON.stringify(outcome)} · tokenID=${digest.tokenId} limitPrice=${limitPrice} tickSize=${tickSize} negRisk=${negRisk} · implied=${implied.toFixed(4)} · tx=${txHash}`;
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

  const { event, outcome } = await fetchPolymarketMarketLabels(digest.tokenId);
  const pUsdForLog = digest.side === "buy" ? (clippedUsdc ?? 0) : originPusd;
  const msg = `copy posted · ${digest.side} shares=${orderShares} pUSD=${pUsdForLog.toFixed(6)} · event=${JSON.stringify(event)} outcome=${JSON.stringify(outcome)} · limit=${limitPrice} implied=${implied.toFixed(4)} · tx=${txHash} · ${JSON.stringify(resp)}`;
  console.log(msg);
  void appendCopyTradeSuccessLine(msg);
}
