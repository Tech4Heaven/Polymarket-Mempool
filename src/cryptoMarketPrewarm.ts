/**
 * Crypto 5-minute "Up or Down" market prewarm cache.
 *
 * The 5-minute crypto markets roll every 5 minutes (e.g. "Bitcoin Up or Down - August 25,
 * 5:25PM-5:30PM ET"). Resolving a tokenId's market name via a gamma call ON the copy hot path adds
 * latency that can cost a fill. Instead we keep a rolling cache of the CURRENT + next several windows
 * for every asset, refreshed in the background, so a tokenId arriving from the PolyNode websocket maps
 * instantly to { asset, event, outcome } with no network round-trip.
 *
 * The gamma slug encodes the asset and series: `btc-updown-5m-<startUnix>`, `eth-updown-5m-…`, etc.
 * Ordering gamma's open markets by endDate ascending surfaces the imminent 5-minute crypto markets
 * first, so one request per refresh captures the whole live window across all assets.
 */

import { fetchPolymarketMarketLabels, type PolymarketMarketLabels } from "./gammaEventName.js";

export type CryptoMarketInfo = {
  /** Short asset key from the slug prefix, lowercased (e.g. "btc", "eth", "sol", "xrp", "hype"). */
  asset: string;
  /** Market question / event name (e.g. "Bitcoin Up or Down - August 25, 5:25PM-5:30PM ET"). */
  event: string;
  /** Outcome label for THIS tokenId ("Up" / "Down"). */
  outcome: string;
  startMs: number;
  endMs: number;
};

const GAMMA_URL = "https://gamma-api.polymarket.com/markets";
const SLUG_RE = /^([a-z0-9]+)-updown-5m-(\d+)$/;
const DEFAULT_REFRESH_MS = 15_000;

/** tokenId → market info. Swapped wholesale on each successful refresh; misses fall back to gamma. */
let cache = new Map<string, CryptoMarketInfo>();
let started = false;

/**
 * Alias table so config `market = "bitcoin"` and the slug prefix `btc` resolve to the same key.
 * Short forms pass through unchanged (normalizeAssetKey lowercases + trims first).
 */
const ASSET_ALIASES: Record<string, string> = {
  bitcoin: "btc",
  ethereum: "eth",
  ether: "eth",
  solana: "sol",
  ripple: "xrp",
  hyperliquid: "hype",
  zcash: "zec",
  dogecoin: "doge",
  litecoin: "ltc",
  cardano: "ada",
  avalanche: "avax",
  chainlink: "link",
  binancecoin: "bnb",
};

/** Normalizes an asset string (config value or slug prefix) to the canonical short key. */
export function normalizeAssetKey(s: string): string {
  const k = s.trim().toLowerCase();
  return ASSET_ALIASES[k] ?? k;
}

function parseTokenIds(raw: unknown): string[] {
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

function parseOutcomes(raw: unknown): string[] {
  return parseTokenIds(raw); // same shape: a JSON string array or an array
}

async function refreshOnce(): Promise<void> {
  const url = new URL(GAMMA_URL);
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", "150");
  url.searchParams.set("order", "endDate");
  url.searchParams.set("ascending", "true");
  const res = await fetch(url);
  if (!res.ok) {
    return; // keep the previous cache; try again next tick
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) {
    return;
  }
  const now = Date.now();
  const next = new Map<string, CryptoMarketInfo>();
  for (const raw of data) {
    const m = raw as Record<string, unknown>;
    const slug = typeof m["slug"] === "string" ? (m["slug"] as string) : "";
    const mm = SLUG_RE.exec(slug);
    if (!mm) {
      continue;
    }
    const asset = normalizeAssetKey(mm[1]!);
    const startMs = Number(mm[2]) * 1000;
    const parsedEnd = m["endDate"] ? Date.parse(String(m["endDate"])) : NaN;
    const endMs = Number.isFinite(parsedEnd) ? parsedEnd : now + 300_000;
    // No end-time prune: the map is rebuilt fresh each refresh and `closed=false` already excludes
    // resolved markets, so stale windows can't accumulate — and this stays robust to clock skew.
    const event = typeof m["question"] === "string" ? (m["question"] as string).trim() : "";
    const tokenIds = parseTokenIds(m["clobTokenIds"]);
    const outcomes = parseOutcomes(m["outcomes"]);
    for (let i = 0; i < tokenIds.length; i++) {
      const tid = tokenIds[i]!;
      const outcome = i < outcomes.length ? outcomes[i]! : "(unknown)";
      next.set(tid, { asset, event, outcome, startMs, endMs });
    }
  }
  if (next.size > 0) {
    cache = next;
  }
}

/** Starts the background refresh loop (idempotent). Kicks an immediate refresh, then every `intervalMs`. */
export function startCryptoMarketPrewarm(intervalMs: number = DEFAULT_REFRESH_MS): void {
  if (started) {
    return;
  }
  started = true;
  void refreshOnce().catch(() => undefined);
  setInterval(() => {
    void refreshOnce().catch(() => undefined);
  }, intervalMs).unref();
}

/** Fast, network-free lookup of a crypto 5-minute market by tokenId. undefined = not in the cache. */
export function lookupCryptoMarket(tokenId: string): CryptoMarketInfo | undefined {
  return cache.get(tokenId);
}

/**
 * Resolves the asset key for a tokenId. Cache first (instant); on a miss, one gamma lookup that also
 * seeds the cache. Returns null when the market isn't a crypto up/down market (or can't be resolved),
 * so a `market` filter treats it as "not my asset". Used only when a target has a market filter set.
 */
export async function resolveCryptoAsset(tokenId: string): Promise<string | null> {
  const hit = cache.get(tokenId);
  if (hit) {
    return hit.asset;
  }
  try {
    const url = new URL(GAMMA_URL);
    url.searchParams.set("clob_token_ids", tokenId);
    url.searchParams.set("limit", "1");
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }
    const m = data[0] as Record<string, unknown>;
    const slug = typeof m["slug"] === "string" ? (m["slug"] as string) : "";
    const mm = SLUG_RE.exec(slug);
    if (!mm) {
      return null; // not a 5-minute crypto up/down market
    }
    const asset = normalizeAssetKey(mm[1]!);
    // Seed the cache so a repeat within this window is instant.
    const startMs = Number(mm[2]) * 1000;
    const endMs = m["endDate"] ? Date.parse(String(m["endDate"])) : Date.now() + 300_000;
    const event = typeof m["question"] === "string" ? (m["question"] as string).trim() : "";
    const tokenIds = parseTokenIds(m["clobTokenIds"]);
    const outcomes = parseOutcomes(m["outcomes"]);
    const seeded = new Map(cache);
    for (let i = 0; i < tokenIds.length; i++) {
      seeded.set(tokenIds[i]!, {
        asset,
        event,
        outcome: i < outcomes.length ? outcomes[i]! : "(unknown)",
        startMs,
        endMs,
      });
    }
    cache = seeded;
    return asset;
  } catch {
    return null;
  }
}

/**
 * Market labels (event + outcome) with the prewarm cache as a fast path, falling back to the direct
 * gamma lookup on a miss. Drop-in for `fetchPolymarketMarketLabels` on the copy hot path.
 */
export async function resolveMarketLabelsFast(tokenId: string): Promise<PolymarketMarketLabels> {
  const hit = cache.get(tokenId);
  if (hit && hit.event) {
    return { event: hit.event, outcome: hit.outcome };
  }
  return fetchPolymarketMarketLabels(tokenId);
}
