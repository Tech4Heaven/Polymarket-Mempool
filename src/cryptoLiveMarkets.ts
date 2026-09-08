/**
 * Live crypto 5m / 15m / 1h Up/Down market + ask cache.
 *
 * Pattern mirrors `/home/speed-outcome-entry`:
 *   - 5m/15m (UTC): `{asset}-updown-{5m|15m}-{windowStartUnix}`
 *   - 1h (ET):      `{fullName}-up-or-down-{month}-{day}-{year}-{hour}am-et`
 *     e.g. `bitcoin-up-or-down-september-8-2026-4am-et`
 * Resolve token IDs via Gamma `GET /markets/slug/{slug}`, then keep best asks
 * fresh via CLOB REST `/book`.
 *
 * Used by `order_type = "maker"` copy targets so PolyNode fires can price from a
 * pre-warmed ask without a cold gamma lookup, and so non-5m/15m/1h markets are skipped.
 */

import { normalizeAssetKey } from "./cryptoMarketPrewarm.js";

export type MarketInterval = "5m" | "15m" | "1h";

export type LiveCryptoTokenInfo = {
  asset: string;
  interval: MarketInterval;
  slug: string;
  outcome: "Up" | "Down";
  /** Opposite outcome token in the same market (Up↔Down). */
  oppositeTokenId: string;
  conditionId?: string;
  question?: string;
  tickSize?: string;
  negRisk?: boolean;
  windowStartSecs: number;
  windowEndSecs: number;
  /** Best ask from last successful book poll; undefined until first hydrate. */
  bestAsk?: number;
  /** Best bid from last successful book poll. */
  bestBid?: number;
  /** CLOB min_order_size from last book poll (typically 5). */
  minOrderSize?: number;
  updatedAtMs: number;
};

const GAMMA_HOST = "https://gamma-api.polymarket.com";
const CLOB_HOST = "https://clob.polymarket.com";
const ET_TZ = "America/New_York";

/** Same asset set as speed-outcome-entry defaults. */
const DEFAULT_ASSETS = ["btc", "eth", "xrp", "sol", "doge", "bnb", "hype"] as const;

/** Full name used in hourly slugs (bitcoin-up-or-down-…, not btc-updown-…). */
const HOURLY_SLUG_NAME: Record<string, string> = {
  btc: "bitcoin",
  eth: "ethereum",
  xrp: "xrp",
  sol: "solana",
  doge: "dogecoin",
  bnb: "bnb",
  hype: "hype",
};

const UTC_INTERVALS: { label: "5m" | "15m"; secs: number }[] = [
  { label: "5m", secs: 300 },
  { label: "15m", secs: 900 },
];

const DEFAULT_DISCOVER_MS = 15_000;
const DEFAULT_BOOK_MS = 2_000;

function normalizeTokenKey(id: string): string {
  const s = id.trim();
  try {
    return BigInt(s).toString();
  } catch {
    return s.toLowerCase();
  }
}

function windowStartSecs(nowMs: number, durationSecs: number): number {
  const nowSecs = Math.floor(nowMs / 1000);
  return Math.floor(nowSecs / durationSecs) * durationSecs;
}

type EtParts = { year: number; month: number; day: number; hour: number; minute: number };

function etParts(ms: number): EtParts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) {
    if (p.type !== "literal") {
      map[p.type] = p.value;
    }
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

/** UTC millis for a civil wall-clock time in America/New_York. */
function etWallToUtcMs(year: number, month: number, day: number, hour: number): number {
  let t = Date.UTC(year, month - 1, day, hour, 0, 0);
  for (let i = 0; i < 4; i++) {
    const p = etParts(t);
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, 0, 0);
    const want = Date.UTC(year, month - 1, day, hour, 0, 0);
    const delta = want - got;
    if (delta === 0) {
      break;
    }
    t += delta;
  }
  return t;
}

/** ET hour boundary containing `nowMs` (unix secs). */
function hourlyWindowStartSecs(nowMs: number): number {
  const p = etParts(nowMs);
  return Math.floor(etWallToUtcMs(p.year, p.month, p.day, p.hour) / 1000);
}

/** Next ET hour boundary after `startSecs` (an ET hour open). */
function hourlyNextWindowStartSecs(startSecs: number): number {
  const probe = startSecs * 1000 + 3600_000;
  const p = etParts(probe);
  return Math.floor(etWallToUtcMs(p.year, p.month, p.day, p.hour) / 1000);
}

function hourlyHourLabel(hour24: number): string {
  if (hour24 === 0) return "12am";
  if (hour24 < 12) return `${hour24}am`;
  if (hour24 === 12) return "12pm";
  return `${hour24 - 12}pm`;
}

/** e.g. bitcoin-up-or-down-september-8-2026-4am-et */
export function hourlyMarketSlug(asset: string, windowStartSecs: number): string {
  const name = HOURLY_SLUG_NAME[normalizeAssetKey(asset)] ?? normalizeAssetKey(asset);
  const p = etParts(windowStartSecs * 1000);
  const monthName = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    month: "long",
  })
    .format(new Date(windowStartSecs * 1000))
    .toLowerCase();
  return `${name}-up-or-down-${monthName}-${p.day}-${p.year}-${hourlyHourLabel(p.hour)}-et`;
}

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

type GammaMarketRow = {
  id?: string;
  slug?: string;
  question?: string;
  conditionId?: string;
  clobTokenIds?: unknown;
  outcomes?: unknown;
  minimum_tick_size?: string;
  negRisk?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  endDate?: string;
};

async function fetchGammaBySlug(slug: string): Promise<GammaMarketRow | null> {
  const url = `${GAMMA_HOST}/markets/slug/${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`gamma slug ${slug}: HTTP ${res.status}`);
  }
  return (await res.json()) as GammaMarketRow;
}

async function fetchClobBook(
  tokenId: string
): Promise<{ bestAsk?: number; bestBid?: number; minOrderSize?: number }> {
  const url = `${CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    return {};
  }
  const data = (await res.json()) as {
    asks?: { price: string; size: string }[];
    bids?: { price: string; size: string }[];
    min_order_size?: string | number;
  };
  let bestAsk: number | undefined;
  let bestBid: number | undefined;
  for (const a of data.asks ?? []) {
    const p = parseFloat(a.price);
    const s = parseFloat(a.size);
    if (!(p > 0 && p < 1) || !(s > 0)) {
      continue;
    }
    if (bestAsk === undefined || p < bestAsk) {
      bestAsk = p;
    }
  }
  for (const b of data.bids ?? []) {
    const p = parseFloat(b.price);
    const s = parseFloat(b.size);
    if (!(p > 0 && p < 1) || !(s > 0)) {
      continue;
    }
    if (bestBid === undefined || p > bestBid) {
      bestBid = p;
    }
  }
  let minOrderSize: number | undefined;
  if (data.min_order_size !== undefined) {
    const m = parseFloat(String(data.min_order_size));
    if (Number.isFinite(m) && m > 0) {
      minOrderSize = m;
    }
  }
  return { bestAsk, bestBid, minOrderSize };
}

/** tokenId → live 5m/15m/1h crypto token info (swapped on each successful discovery). */
let cache = new Map<string, LiveCryptoTokenInfo>();
let started = false;
let everReady = false;
let assets: string[] = [...DEFAULT_ASSETS];

export function isCryptoLiveMarketsReady(): boolean {
  return everReady;
}

export function lookupLiveCryptoToken(tokenId: string): LiveCryptoTokenInfo | undefined {
  return cache.get(normalizeTokenKey(tokenId));
}

/** Snapshot of all currently cached live tokens (for diagnostics). */
export function listLiveCryptoTokens(): LiveCryptoTokenInfo[] {
  return [...cache.values()];
}

type DiscoverWindow = {
  asset: string;
  interval: MarketInterval;
  slug: string;
  start: number;
  end: number;
};

function buildDiscoverWindows(nowMs: number): DiscoverWindow[] {
  const out: DiscoverWindow[] = [];

  for (const { label, secs } of UTC_INTERVALS) {
    const currentStart = windowStartSecs(nowMs, secs);
    const nextStart = currentStart + secs;
    for (const asset of assets) {
      for (const start of [currentStart, nextStart]) {
        const end = start + secs;
        if (nowMs >= end * 1000) {
          continue;
        }
        out.push({
          asset,
          interval: label,
          slug: `${asset}-updown-${label}-${start}`,
          start,
          end,
        });
      }
    }
  }

  // Hourly ET windows (current + next), slug like bitcoin-up-or-down-september-8-2026-4am-et.
  const hourCurrent = hourlyWindowStartSecs(nowMs);
  const hourNext = hourlyNextWindowStartSecs(hourCurrent);
  for (const start of [hourCurrent, hourNext]) {
    const end = hourlyNextWindowStartSecs(start);
    if (nowMs >= end * 1000) {
      continue;
    }
    for (const asset of assets) {
      out.push({
        asset,
        interval: "1h",
        slug: hourlyMarketSlug(asset, start),
        start,
        end,
      });
    }
  }

  return out;
}

function ingestMarket(
  next: Map<string, LiveCryptoTokenInfo>,
  prev: Map<string, LiveCryptoTokenInfo>,
  win: DiscoverWindow,
  row: GammaMarketRow,
  nowMs: number
): void {
  if (row.closed === true || row.acceptingOrders === false || row.enableOrderBook === false) {
    return;
  }
  const tokenIds = parseJsonStringArray(row.clobTokenIds);
  if (tokenIds.length < 2) {
    return;
  }
  const upId = normalizeTokenKey(tokenIds[0]!);
  const downId = normalizeTokenKey(tokenIds[1]!);
  const base = {
    asset: win.asset,
    interval: win.interval,
    slug: win.slug,
    conditionId: typeof row.conditionId === "string" ? row.conditionId : undefined,
    question: typeof row.question === "string" ? row.question : undefined,
    tickSize: typeof row.minimum_tick_size === "string" ? row.minimum_tick_size : undefined,
    negRisk: typeof row.negRisk === "boolean" ? row.negRisk : undefined,
    windowStartSecs: win.start,
    windowEndSecs: win.end,
    updatedAtMs: nowMs,
  } as const;

  const prevUp = prev.get(upId);
  const prevDown = prev.get(downId);
  next.set(upId, {
    ...base,
    outcome: "Up",
    oppositeTokenId: downId,
    bestAsk: prevUp?.bestAsk,
    bestBid: prevUp?.bestBid,
    minOrderSize: prevUp?.minOrderSize,
    updatedAtMs: prevUp?.updatedAtMs ?? nowMs,
  });
  next.set(downId, {
    ...base,
    outcome: "Down",
    oppositeTokenId: upId,
    bestAsk: prevDown?.bestAsk,
    bestBid: prevDown?.bestBid,
    minOrderSize: prevDown?.minOrderSize,
    updatedAtMs: prevDown?.updatedAtMs ?? nowMs,
  });
}

async function discoverOnce(): Promise<void> {
  const nowMs = Date.now();
  const next = new Map<string, LiveCryptoTokenInfo>();
  // Preserve prior asks across discovery so we don't blank prices while gamma refreshes.
  const prev = cache;
  const windows = buildDiscoverWindows(nowMs);

  for (const win of windows) {
    let row: GammaMarketRow | null;
    try {
      row = await fetchGammaBySlug(win.slug);
    } catch {
      continue;
    }
    if (!row) {
      continue;
    }
    ingestMarket(next, prev, win, row, nowMs);
  }

  if (next.size > 0) {
    cache = next;
    if (!everReady) {
      everReady = true;
      const slugs = [...new Set([...next.values()].map((v) => v.slug))].sort();
      const byIv = { "5m": 0, "15m": 0, "1h": 0 };
      for (const v of next.values()) {
        byIv[v.interval]++;
      }
      console.info(
        `crypto live 5m/15m/1h cache ready · ${next.size} tokens · ${slugs.length} markets` +
          ` · 5m=${byIv["5m"] / 2} 15m=${byIv["15m"] / 2} 1h=${byIv["1h"] / 2}`
      );
    }
  }
}

async function hydrateBooksOnce(): Promise<void> {
  if (cache.size === 0) {
    return;
  }
  const tokenIds = [...cache.keys()];
  // Parallel but bounded: small universe (~assets × intervals × 2 windows × 2 outcomes).
  await Promise.all(
    tokenIds.map(async (tid) => {
      const info = cache.get(tid);
      if (!info) {
        return;
      }
      try {
        const { bestAsk, bestBid, minOrderSize } = await fetchClobBook(tid);
        const cur = cache.get(tid);
        if (!cur) {
          return;
        }
        if (bestAsk !== undefined) {
          cur.bestAsk = bestAsk;
        }
        if (bestBid !== undefined) {
          cur.bestBid = bestBid;
        }
        if (minOrderSize !== undefined) {
          cur.minOrderSize = minOrderSize;
        }
        cur.updatedAtMs = Date.now();
      } catch {
        // keep prior ask
      }
    })
  );
}

/**
 * Starts discovery + book poll loops (idempotent). Resolves after the first discovery attempt.
 * Optional `assetFilter` restricts which slug prefixes are tracked (normalized keys).
 */
export function startCryptoLiveMarkets(opts?: {
  assets?: string[];
  discoverMs?: number;
  bookMs?: number;
}): Promise<void> {
  if (started) {
    return Promise.resolve();
  }
  started = true;
  if (opts?.assets && opts.assets.length > 0) {
    assets = [...new Set(opts.assets.map(normalizeAssetKey).filter(Boolean))];
  }
  const discoverMs = opts?.discoverMs ?? DEFAULT_DISCOVER_MS;
  const bookMs = opts?.bookMs ?? DEFAULT_BOOK_MS;

  const first = discoverOnce()
    .then(() => hydrateBooksOnce())
    .catch(() => undefined);

  setInterval(() => {
    void discoverOnce().catch(() => undefined);
  }, discoverMs).unref();

  setInterval(() => {
    void hydrateBooksOnce().catch(() => undefined);
  }, bookMs).unref();

  return first.then(() => undefined);
}
