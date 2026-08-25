/**
 * Crypto "Up or Down" market prewarm cache.
 *
 * The crypto up/down markets roll on several cadences — 5m, 15m, 1h, 4h, daily (e.g. "Bitcoin Up or
 * Down - August 25, 5:25PM-5:30PM ET"). Resolving a tokenId's market name via a gamma call ON the copy
 * hot path adds latency that can cost a fill. Instead we keep a rolling cache of the live markets for
 * every asset and cadence, refreshed in the background, so a tokenId arriving from the PolyNode
 * websocket maps instantly to { asset, event, outcome } with no network round-trip.
 *
 * Source of truth (verified against gamma, not assumed): every crypto up/down market carries the tag
 * "crypto-prices" (tag_id 1312), so `?tag_id=1312&closed=false` returns exactly the CRYPTO up/down
 * universe across ALL cadences with clobTokenIds — no forex / indices / commodities (those live under
 * the broader "up-or-down" tag 102127, which we deliberately do NOT use). A few non-up/down crypto
 * price markets share the tag; the slug filter below drops them. Two slug shapes exist, asset first:
 *   compact:   `<asset>-updown-<dur>-<startUnix>`      e.g. btc-updown-5m-…, sol-updown-15m-…, btc-updown-4h-…
 *   full-word: `<asset>-up-or-down-<date>[-<hour>-et]` e.g. bitcoin-up-or-down-august-27-2026-5pm-et (hourly/daily)
 * We take the asset as the first slug segment (duration-agnostic) and page through the tag so long
 * cadences aren't crowded out by the many 5m windows.
 */

import { fetchPolymarketMarketLabels, type PolymarketMarketLabels } from "./gammaEventName.js";

export type CryptoMarketInfo = {
  /** Short asset key from the slug prefix, lowercased (e.g. "btc", "eth", "sol", "xrp", "hype"). */
  asset: string;
  /** Market question / event name (e.g. "Bitcoin Up or Down - August 25, 5:25PM-5:30PM ET"). */
  event: string;
  /** Outcome label for THIS tokenId ("Up" / "Down"). */
  outcome: string;
  endMs: number;
};

const GAMMA_URL = "https://gamma-api.polymarket.com/markets";
/** gamma tag id for "crypto-prices" — the precise server-side filter for crypto up/down markets only. */
const CRYPTO_UPDOWN_TAG_ID = "1312";
const PAGE_SIZE = 100;
const MAX_PAGES = 20; // hard bound; pagination also stops early on a short page / the horizon
/**
 * Only cache markets ending within this window. The fetch is endDate-ascending, so once a market ends
 * beyond the horizon we stop paging — this drops the many far-future 5-minute windows (that won't be
 * traded until they roll into range) and keeps the background fetch to a few pages.
 * Trade-off: currently-active markets that END beyond the horizon (e.g. a 4h/daily window already in
 * progress) aren't cached; a trade on one is a cache miss → copied (the safe fallback).
 */
const HORIZON_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_REFRESH_MS = 20_000;

/**
 * Canonicalizes a CLOB tokenId so the map key is identical whether it arrived from PolyNode or gamma,
 * regardless of leading zeros / `0x` / whitespace. BigInt normalizes decimal AND hex ids to one form.
 */
function normalizeTokenKey(id: string): string {
  const s = id.trim();
  try {
    return BigInt(s).toString();
  } catch {
    return s.toLowerCase();
  }
}

/** tokenId → market info. Swapped wholesale on each successful refresh; misses fall back to gamma. */
let cache = new Map<string, CryptoMarketInfo>();
let started = false;
/** Flips true the first time the cache is populated — used to log a one-time "ready" line. */
let everReady = false;

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

/**
 * Asset key from an up/down slug, duration-agnostic. Handles both `<asset>-updown-<dur>-<unix>` and
 * `<asset>-up-or-down-…`, taking the first slug segment (e.g. "eth", "bitcoin", "spy") and normalizing
 * it. Returns null for a slug with neither marker.
 */
function assetFromSlug(slug: string): string | null {
  let cut = slug.indexOf("-updown-");
  if (cut < 0) {
    cut = slug.indexOf("-up-or-down");
  }
  if (cut <= 0) {
    return null;
  }
  const first = slug.slice(0, cut).split("-")[0];
  return first ? normalizeAssetKey(first) : null;
}

async function fetchPage(offset: number): Promise<Record<string, unknown>[] | null> {
  const url = new URL(GAMMA_URL);
  url.searchParams.set("closed", "false");
  url.searchParams.set("tag_id", CRYPTO_UPDOWN_TAG_ID);
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("order", "endDate");
  url.searchParams.set("ascending", "true");
  const res = await fetch(url);
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : null;
}

async function refreshOnce(): Promise<void> {
  const now = Date.now();
  const horizon = now + HORIZON_MS;
  const next = new Map<string, CryptoMarketInfo>();
  let reachedHorizon = false;
  for (let page = 0; page < MAX_PAGES && !reachedHorizon; page++) {
    const rows = await fetchPage(page * PAGE_SIZE);
    if (rows === null) {
      // On the very first page failing we keep the previous cache (return without swapping); a later
      // page failing just caps this refresh at what we already gathered.
      if (page === 0) {
        return;
      }
      break;
    }
    for (const m of rows) {
      const parsedEnd = m["endDate"] ? Date.parse(String(m["endDate"])) : NaN;
      const endMs = Number.isFinite(parsedEnd) ? parsedEnd : now + 300_000;
      // endDate-ascending: the first market past the horizon means every later one is too — stop.
      if (endMs > horizon) {
        reachedHorizon = true;
        break;
      }
      const slug = typeof m["slug"] === "string" ? (m["slug"] as string) : "";
      const asset = assetFromSlug(slug);
      if (!asset) {
        continue; // a non-up/down crypto price market sharing the tag — skip, but it still counted toward the horizon
      }
      const event = typeof m["question"] === "string" ? (m["question"] as string).trim() : "";
      const tokenIds = parseTokenIds(m["clobTokenIds"]);
      const outcomes = parseOutcomes(m["outcomes"]);
      for (let i = 0; i < tokenIds.length; i++) {
        const tid = normalizeTokenKey(tokenIds[i]!);
        const outcome = i < outcomes.length ? outcomes[i]! : "(unknown)";
        next.set(tid, { asset, event, outcome, endMs });
      }
    }
    if (rows.length < PAGE_SIZE) {
      break; // last page — no end-time prune needed; the map is rebuilt fresh each refresh
    }
  }
  if (next.size > 0) {
    cache = next;
    if (!everReady) {
      everReady = true;
      const assets = [...new Set([...next.values()].map((v) => v.asset))].sort();
      console.info(
        `crypto market cache ready · ${next.size} tokens · ${assets.length} assets [${assets.join(",")}]`
      );
    }
  }
}

/** True once the prewarm cache has been populated at least once. */
export function isCryptoCacheReady(): boolean {
  return everReady;
}

/**
 * Starts the background refresh loop (idempotent) and returns a promise that resolves once the FIRST
 * refresh has completed, so callers can await a warm cache before processing trades (kills the cold-
 * start miss window). Subsequent refreshes run every `intervalMs`.
 */
export function startCryptoMarketPrewarm(intervalMs: number = DEFAULT_REFRESH_MS): Promise<void> {
  if (started) {
    return Promise.resolve();
  }
  started = true;
  const first = refreshOnce().catch(() => undefined);
  setInterval(() => {
    void refreshOnce().catch(() => undefined);
  }, intervalMs).unref();
  return first.then(() => undefined);
}

/** Fast, network-free lookup of a crypto up/down market (any cadence) by tokenId. undefined = miss. */
export function lookupCryptoMarket(tokenId: string): CryptoMarketInfo | undefined {
  return cache.get(normalizeTokenKey(tokenId));
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
