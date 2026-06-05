import { readFile } from "fs/promises";
import { basename, resolve } from "path";

/**
 * Replays one or more copy-trade log files and finds the `max_price_difference`
 * (overbid skip) and `max_underbid_difference` (underbid skip) thresholds that
 * maximize realised P/L, by looking up each trade's actual Polymarket
 * resolution.
 *
 * Usage:
 *   npx tsx scripts/findThresholds.ts logs/foo.log [logs/bar.log ...]
 *
 * Handles three event shapes per log:
 *   - `[DRY RUN] would post GTC` ........ has tokenID inline
 *   - `copy posted` (live)  ............. resolves tokenID via target activity
 *   - `copy skip · price drift buy` ..... overbid skipped by current config
 *
 * Cluster multiple addresses by passing all their log files together.
 */

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const DATA_API_BASE = "https://data-api.polymarket.com";

const POSTS_DRY =
  /\[DRY RUN\] would post GTC.*shares=([\d.]+).*outcome="([^"]+)".*tokenID=(\d+) limitPrice=([\d.]+).*implied=([\d.]+).*tx=(0x[a-f0-9]+)/;
const POSTS_NEW =
  /copy posted.*filled=([\d.]+) sh.*outcome="([^"]+)".*limit=([\d.]+) implied=([\d.]+).*tx=(0x[a-f0-9]+)/;
const POSTS_OLD =
  /copy posted.*shares=([\d.]+).*outcome="([^"]+)".*limit=([\d.]+) implied=([\d.]+).*tx=(0x[a-f0-9]+)/;
const DRIFT_NEW =
  /price drift buy.*implied\(on-chain\)=([\d.]+) effective=([\d.]+).*origin pUSD=([\d.]+) shares=[\d.]+.*outcome="([^"]+)".*tx=(0x[a-f0-9]+)/;
const DRIFT_OLD =
  /price drift buy.*implied\(on-chain\)=([\d.]+) clob=([\d.]+).*origin pUSD=([\d.]+) shares=[\d.]+.*outcome="([^"]+)".*tx=(0x[a-f0-9]+)/;

const ADDRESS_FROM_FILENAME = /_(0x[a-f0-9]{40})\.log$/i;

type Trade = {
  src: string;
  kind: "post" | "skip";
  shares: number;
  impl: number;
  limit: number;
  outcome: string;
  token: string | null;
  tx: string;
};

function parseLogContent(src: string, text: string): Trade[] {
  const out: Trade[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) continue;
    let m: RegExpMatchArray | null;
    if ((m = raw.match(POSTS_DRY))) {
      out.push({
        src,
        kind: "post",
        shares: Number(m[1]),
        outcome: m[2]!,
        token: m[3]!,
        limit: Number(m[4]),
        impl: Number(m[5]),
        tx: m[6]!.toLowerCase(),
      });
    } else if ((m = raw.match(POSTS_NEW))) {
      out.push({
        src,
        kind: "post",
        shares: Number(m[1]),
        outcome: m[2]!,
        limit: Number(m[3]),
        impl: Number(m[4]),
        tx: m[5]!.toLowerCase(),
        token: null,
      });
    } else if ((m = raw.match(POSTS_OLD))) {
      out.push({
        src,
        kind: "post",
        shares: Number(m[1]),
        outcome: m[2]!,
        limit: Number(m[3]),
        impl: Number(m[4]),
        tx: m[5]!.toLowerCase(),
        token: null,
      });
    } else if ((m = raw.match(DRIFT_NEW)) || (m = raw.match(DRIFT_OLD))) {
      const impl = Number(m[1]);
      const eff = Number(m[2]);
      const pu = Number(m[3]);
      const shares = eff > 0 ? pu / eff : 0;
      out.push({
        src,
        kind: "skip",
        shares,
        impl,
        limit: eff,
        outcome: m[4]!,
        token: null,
        tx: m[5]!.toLowerCase(),
      });
    }
  }
  return out;
}

async function loadTxTokenMap(address: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let offset = 0;
  const limit = 500;
  // Walk the address's full activity; data-api caps around 3500 events but
  // most targets fit. For longer histories use the `end` cursor trick.
  let endCursor: number | undefined;
  while (true) {
    let url = `${DATA_API_BASE}/activity?user=${address.toLowerCase()}&limit=${limit}&offset=${offset}`;
    if (endCursor !== undefined) {
      url = `${DATA_API_BASE}/activity?user=${address.toLowerCase()}&limit=${limit}&end=${endCursor}`;
    }
    let events: unknown;
    try {
      const r = await fetch(url);
      events = await r.json();
    } catch {
      break;
    }
    if (!Array.isArray(events) || events.length === 0) break;
    let added = 0;
    let minTs = Number.MAX_SAFE_INTEGER;
    for (const e of events as Array<Record<string, unknown>>) {
      const tx = typeof e["transactionHash"] === "string" ? e["transactionHash"].toLowerCase() : "";
      const asset = typeof e["asset"] === "string" ? e["asset"] : "";
      const ts = typeof e["timestamp"] === "number" ? e["timestamp"] : 0;
      if (tx && asset && !map.has(tx)) {
        map.set(tx, asset);
        added++;
      }
      if (ts && ts < minTs) minTs = ts;
    }
    offset += events.length;
    if (events.length < limit) break;
    if (offset >= 3000 && endCursor === undefined) {
      endCursor = minTs - 1;
      offset = 0;
    } else if (added === 0) {
      break;
    }
  }
  return map;
}

const tokenOutcomeCache = new Map<string, "WIN" | "LOSS" | "PEND">();

async function lookupOutcome(token: string): Promise<"WIN" | "LOSS" | "PEND"> {
  const cached = tokenOutcomeCache.get(token);
  if (cached) return cached;
  const url = `${GAMMA_BASE}/markets?clob_token_ids=${token}&closed=true`;
  let result: "WIN" | "LOSS" | "PEND" = "PEND";
  try {
    const r = await fetch(url);
    const arr = (await r.json()) as Array<Record<string, unknown>>;
    if (Array.isArray(arr) && arr.length > 0) {
      const m = arr[0]!;
      const tokens = JSON.parse(String(m["clobTokenIds"] ?? "[]")) as string[];
      const prices = JSON.parse(String(m["outcomePrices"] ?? "[]")) as string[];
      const idx = tokens.indexOf(token);
      if (idx >= 0) {
        const p = Number(prices[idx] ?? "0");
        if (p >= 1) result = "WIN";
        else if (p <= 0) result = "LOSS";
      }
    }
  } catch {
    // leave as PEND
  }
  tokenOutcomeCache.set(token, result);
  return result;
}

async function resolveOutcomes(
  trades: Trade[],
  concurrency = 8
): Promise<Map<string, "WIN" | "LOSS" | "PEND">> {
  const unique = Array.from(new Set(trades.map((t) => t.token).filter((t): t is string => !!t)));
  const out = new Map<string, "WIN" | "LOSS" | "PEND">();
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < unique.length) {
      const my = idx++;
      const tok = unique[my]!;
      const res = await lookupOutcome(tok);
      out.set(tok, res);
      if ((my + 1) % 25 === 0) {
        process.stderr.write(`  resolved ${my + 1}/${unique.length}\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

type Enriched = Trade & {
  gap: number;
  result: "WIN" | "LOSS" | "PEND";
  cost: number;
  pnl: number;
};

function enrich(trades: Trade[], outcomes: Map<string, "WIN" | "LOSS" | "PEND">): Enriched[] {
  const out: Enriched[] = [];
  for (const t of trades) {
    if (!t.token) continue;
    const res = outcomes.get(t.token) ?? "PEND";
    const cost = t.shares * t.limit;
    let pnl = 0;
    if (res === "WIN") pnl = t.shares * (1 - t.limit);
    else if (res === "LOSS") pnl = -cost;
    out.push({ ...t, gap: t.limit - t.impl, result: res, cost, pnl });
  }
  return out;
}

type SweepRow = {
  threshold: number;
  kept: number;
  w: number;
  l: number;
  cost: number;
  pnl: number;
  roi: number;
};

const THRESHOLDS = [
  0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.07, 0.1, 0.12, 0.15, 0.2, 0.3, 0.5, 1.0,
];

function sweep(side: Enriched[], gapFn: (t: Enriched) => number): SweepRow[] {
  const rows: SweepRow[] = [];
  for (const t of THRESHOLDS) {
    const kept = side.filter((x) => gapFn(x) <= t);
    const w = kept.filter((x) => x.result === "WIN").length;
    const l = kept.filter((x) => x.result === "LOSS").length;
    const cost = kept.reduce((s, x) => s + x.cost, 0);
    const pnl = kept.reduce((s, x) => s + x.pnl, 0);
    rows.push({ threshold: t, kept: kept.length, w, l, cost, pnl, roi: cost > 0 ? pnl / cost : 0 });
  }
  return rows;
}

function fmt(n: number, w: number, d: number): string {
  return n.toFixed(d).padStart(w);
}

function printTable(title: string, rows: SweepRow[]): SweepRow {
  console.log(`\n=== ${title} ===`);
  console.log(
    `${"max gap ≤ X".padEnd(14)} ${"kept".padStart(5)} ${"W".padStart(4)} ${"L".padStart(4)} ${"cost$".padStart(11)} ${"P/L$".padStart(11)} ${"ROI".padStart(8)}`
  );
  console.log("-".repeat(68));
  let best = rows[0]!;
  for (const r of rows) {
    if (r.pnl > best.pnl) best = r;
    console.log(
      `≤ ${r.threshold.toFixed(3).padEnd(12)} ${String(r.kept).padStart(5)} ${String(r.w).padStart(4)} ${String(r.l).padStart(4)} ${fmt(r.cost, 11, 2)} ${fmt(r.pnl, 11, 2)} ${(r.roi * 100).toFixed(1).padStart(7)}%`
    );
  }
  return best;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: npx tsx scripts/findThresholds.ts <log-file> [<log-file> ...]");
    process.exit(1);
  }

  // 1. Parse all logs
  const trades: Trade[] = [];
  const addresses = new Set<string>();
  for (const arg of args) {
    const path = resolve(process.cwd(), arg);
    const text = await readFile(path, "utf8");
    const tagged = parseLogContent(basename(path), text);
    trades.push(...tagged);
    const am = basename(path).match(ADDRESS_FROM_FILENAME);
    if (am) addresses.add(am[1]!.toLowerCase());
  }
  console.log(`Parsed ${trades.length} trade events from ${args.length} log file(s).`);
  console.log(`Detected addresses: ${[...addresses].join(", ") || "(none in filenames)"}`);

  // 2. Resolve missing tokens via each target's activity
  const missing = trades.filter((t) => !t.token);
  if (missing.length > 0 && addresses.size > 0) {
    console.log(`Fetching activity for ${addresses.size} address(es) to resolve ${missing.length} missing tokens...`);
    const txMap = new Map<string, string>();
    for (const addr of addresses) {
      const m = await loadTxTokenMap(addr);
      for (const [k, v] of m) txMap.set(k, v);
      console.log(`  ${addr}: ${m.size} tx → asset entries`);
    }
    let filled = 0;
    for (const t of trades) {
      if (!t.token) {
        const tok = txMap.get(t.tx);
        if (tok) {
          t.token = tok;
          filled++;
        }
      }
    }
    console.log(`Filled ${filled} of ${missing.length} missing tokens.`);
  }
  const withToken = trades.filter((t) => t.token);
  console.log(`Trades with resolvable token: ${withToken.length}`);

  // 3. Resolve outcomes for all unique tokens
  console.log("Looking up market resolutions via Polymarket gamma-api...");
  const outcomes = await resolveOutcomes(withToken);
  console.log(`Resolved ${outcomes.size} unique tokens.`);

  // 4. Enrich and split
  const enriched = enrich(withToken, outcomes);
  const overbids = enriched.filter((e) => e.gap > 0);
  const underbids = enriched.filter((e) => e.gap < 0);
  console.log(`\nOverbids: ${overbids.length}  Underbids: ${underbids.length}  Flat (gap=0): ${enriched.length - overbids.length - underbids.length}`);

  // 5. Sweep thresholds for both
  const overSweep = sweep(overbids, (t) => t.gap);
  const underSweep = sweep(underbids, (t) => -t.gap);

  const bestOver = printTable(
    "OVERBIDS — skip when (limit − implied) > X (the existing max_price_difference)",
    overSweep
  );
  const bestUnder = printTable(
    "UNDERBIDS — skip when (implied − limit) > X (the new max_underbid_difference)",
    underSweep
  );

  // 6. Summary
  console.log("\n=== BEST THRESHOLDS ===");
  console.log(
    `max_price_difference     = ${bestOver.threshold}   → keeps ${bestOver.kept} overbid trades, P/L $${bestOver.pnl.toFixed(2)} (ROI ${(bestOver.roi * 100).toFixed(1)}%)`
  );
  console.log(
    `max_underbid_difference  = ${bestUnder.threshold}   → keeps ${bestUnder.kept} underbid trades, P/L $${bestUnder.pnl.toFixed(2)} (ROI ${(bestUnder.roi * 100).toFixed(1)}%)`
  );
  const bestCombined = bestOver.pnl + bestUnder.pnl;
  const baselineCombined =
    overSweep[overSweep.length - 1]!.pnl + underSweep[underSweep.length - 1]!.pnl;
  console.log(
    `\nCombined P/L at best thresholds: $${bestCombined.toFixed(2)}  (baseline no-filter: $${baselineCombined.toFixed(2)}, edge: +$${(bestCombined - baselineCombined).toFixed(2)})`
  );
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
