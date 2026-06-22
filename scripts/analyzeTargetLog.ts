import { readFile } from "fs/promises";
import { basename, resolve } from "path";

/**
 * analyzeTargetLog.ts — assess whether a copy target is worth copying.
 *
 * Reads a per-target bot log (e.g. logs/<username>_<address>.log), parses all dry-run + live
 * post events and all skip events, joins them against the target's actual Polymarket history
 * (trades + resolved positions), and prints:
 *
 *   • activity range, total events, capital deployed
 *   • posts breakdown (dry / live)
 *   • skips breakdown by reason (size, drift, underbid, etc.)
 *   • hypothetical PnL on posts (treating dry-run as real, optionally)
 *   • hypothetical PnL on drift + underbid skips (what would have been captured)
 *   • win rate, return on capital, recommendation
 *
 * Usage:
 *   npx tsx scripts/analyzeTargetLog.ts <log-path> [options]
 *   npm run analyze-target -- <log-path> [options]
 *
 * Options:
 *   --mode <dry|live|both>     which posts to count (default: both)
 *   --target <0xAddr>          override target address (else parsed from filename)
 *   --include-skips            also analyze drift+underbid skips as hypothetical opportunities
 *   --verbose                  print per-trade detail rows
 *
 * Examples:
 *   npx tsx scripts/analyzeTargetLog.ts logs/Vagabund97_0xa53b....log
 *   npx tsx scripts/analyzeTargetLog.ts logs/foo_0xabc.log --mode dry --include-skips --verbose
 */

type PostRecord = {
  kind: "dry" | "live";
  side: "buy" | "sell";
  shares: number;
  pusd: number;
  limit: number;
  event: string;
  outcome: string;
  implied: number;
  tx: string;
  filledShares?: number;
  filledUsdc?: number;
};

type SkipRecord = {
  reason: string;
  pusd: number;
  effective: number;
  implied: number;
  event: string;
  outcome: string;
  tx: string;
};

type Args = {
  logPath: string;
  mode: "dry" | "live" | "both";
  targetOverride?: string;
  includeSkips: boolean;
  verbose: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    logPath: "",
    mode: "both",
    includeSkips: false,
    verbose: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") {
      const v = argv[++i];
      if (v !== "dry" && v !== "live" && v !== "both") {
        throw new Error(`--mode must be dry|live|both, got: ${String(v)}`);
      }
      args.mode = v;
    } else if (a === "--target") {
      args.targetOverride = argv[++i];
    } else if (a === "--include-skips") {
      args.includeSkips = true;
    } else if (a === "--verbose") {
      args.verbose = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a && !a.startsWith("--")) {
      rest.push(a);
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }
  if (rest.length === 0) {
    printHelp();
    throw new Error("missing <log-path>");
  }
  args.logPath = resolve(process.cwd(), rest[0]!);
  return args;
}

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/analyzeTargetLog.ts <log-path> [--mode dry|live|both] [--target 0x...] [--include-skips] [--verbose]

Analyzes a per-target bot log file and computes whether the target is worth copying.
Joins log events against the target's Polymarket history (positions endpoint) to determine
resolved-market outcomes and compute realized + hypothetical PnL.`);
}

/**
 * Extract the target's 0x address from the log filename. Convention: <label>_<0xaddress>.log
 * (taking the last 0x-prefixed 42-char hex token). Returns null if not found.
 */
function targetAddressFromFilename(p: string): string | null {
  const m = basename(p).match(/0x[0-9a-fA-F]{40}/g);
  if (!m || m.length === 0) {
    return null;
  }
  return m[m.length - 1]!.toLowerCase();
}

function num(s: string | undefined): number {
  if (!s) {
    return 0;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function strField(line: string, re: RegExp): string {
  return (line.match(re) || [])[1] ?? "";
}

/** Parse a single log line. Returns null if not a relevant event. */
function parseLine(line: string): PostRecord | SkipRecord | null {
  if (line.includes("[DRY RUN] would post GTC")) {
    const side = strField(line, /side=(buy|sell)/);
    return {
      kind: "dry",
      side: side === "sell" ? "sell" : "buy",
      shares: num(strField(line, /shares=([\d.]+)/)),
      pusd: num(strField(line, /pUSD=([\d.]+)/)),
      limit: num(strField(line, /limitPrice=([\d.]+)/)),
      event: strField(line, /event="([^"]+)"/),
      outcome: strField(line, /outcome="([^"]+)"/),
      implied: num(strField(line, /implied=([\d.]+)/)),
      tx: strField(line, /tx=(0x[0-9a-fA-F]+)/),
    } as PostRecord;
  }
  if (line.includes("copy posted")) {
    const side = strField(line, /·\s+(buy|sell)\s/);
    // copy posted line format: ... submitted=X sh ($Y) filled=Z sh ($W) ... limit=L implied=I
    const submittedSh = num(strField(line, /submitted=([\d.]+)/));
    const submittedUsd = num(strField(line, /submitted=[\d.]+\s*sh\s*\(\$([\d.]+)\)/));
    const filledSh = num(strField(line, /filled=([\d.]+)/));
    const filledUsd = num(strField(line, /filled=[\d.]+\s*sh\s*\(\$([\d.]+)\)/));
    return {
      kind: "live",
      side: side === "sell" ? "sell" : "buy",
      shares: submittedSh,
      pusd: submittedUsd,
      limit: num(strField(line, /limit=([\d.]+)/)),
      event: strField(line, /event="([^"]+)"/),
      outcome: strField(line, /outcome="([^"]+)"/),
      implied: num(strField(line, /implied=([\d.]+)/)),
      tx: strField(line, /tx=(0x[0-9a-fA-F]+)/),
      filledShares: filledSh,
      filledUsdc: filledUsd,
    } as PostRecord;
  }
  if (line.includes("copy skip")) {
    let reason = "other";
    if (line.includes("price drift buy")) {
      reason = "drift";
    } else if (line.includes("underbid skip")) {
      reason = "underbid";
    } else if (/size [\d.]+ < min_order_size/.test(line)) {
      reason = "size";
    } else if (line.includes("empty asks")) {
      reason = "emptyAsks";
    } else if (line.includes("empty bids")) {
      reason = "emptyBids";
    } else if (line.includes("above buy_price_max")) {
      reason = "buyPriceMax";
    } else if (line.includes("below buy_price_min")) {
      reason = "buyPriceMin";
    } else if (line.includes("no balance to sell")) {
      reason = "noBalance";
    } else if (line.includes("already hedged")) {
      reason = "alreadyHedged";
    } else if (line.includes("MIN_POSITION_USDC")) {
      reason = "minPosition";
    } else if (line.includes("max_market_usdc")) {
      reason = "maxMarketUsdc";
    } else if (line.includes("accumulating below min")) {
      reason = "accumulating";
    }
    return {
      reason,
      pusd: num(strField(line, /origin pUSD=([\d.]+)/)) || num(strField(line, /pUSD ([\d.]+)/)),
      effective: num(strField(line, /effective=([\d.]+)/)),
      implied: num(strField(line, /implied\(on-chain\)=([\d.]+)/)),
      event: strField(line, /event="([^"]+)"/),
      outcome: strField(line, /outcome="([^"]+)"/),
      tx: strField(line, /tx=(0x[0-9a-fA-F]+)/),
    } as SkipRecord;
  }
  return null;
}

type PolymarketPosition = {
  conditionId?: string;
  asset?: string;
  size?: number;
  outcome?: string;
  oppositeOutcome?: string;
  redeemable?: boolean;
  mergeable?: boolean;
  eventSlug?: string;
  title?: string;
};

type PolymarketTrade = {
  title?: string;
  eventSlug?: string;
  outcome?: string;
};

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchPolymarketMaps(target: string): Promise<{
  titleToSlug: Map<string, string>;
  slugToWinner: Map<string, string>;
  resolvedCount: number;
}> {
  const positions =
    (await fetchJson<PolymarketPosition[]>(
      `https://data-api.polymarket.com/positions?user=${target}&limit=500`
    )) ?? [];
  const trades =
    (await fetchJson<PolymarketTrade[]>(
      `https://data-api.polymarket.com/trades?user=${target}&limit=500`
    )) ?? [];

  const titleToSlug = new Map<string, string>();
  [...trades, ...positions].forEach((r) => {
    if (r.title && r.eventSlug) {
      titleToSlug.set(r.title, r.eventSlug);
    }
  });

  const slugToWinner = new Map<string, string>();
  let resolvedCount = 0;
  positions.forEach((p) => {
    if (p.mergeable === false && p.eventSlug && p.outcome) {
      const winning = p.redeemable ? p.outcome : p.oppositeOutcome;
      if (winning) {
        slugToWinner.set(p.eventSlug, winning);
        resolvedCount += 1;
      }
    }
  });
  return { titleToSlug, slugToWinner, resolvedCount };
}

type ResolvedPnL = {
  resolvable: number;
  unresolved: number;
  wins: number;
  losses: number;
  pnlWon: number;
  pnlLost: number;
  capitalDeployed: number;
};

/**
 * Compute hypothetical PnL on a set of buy records, given the resolved-market lookup.
 * For each buy: if outcome won → +shares*(1-limit); if lost → −pusd; else unresolved.
 */
function computeBuyPnL(
  buys: PostRecord[],
  titleToSlug: Map<string, string>,
  slugToWinner: Map<string, string>
): ResolvedPnL & { detail: Array<{ b: PostRecord; pnl: number; won: boolean; winner: string }> } {
  const out: ResolvedPnL & {
    detail: Array<{ b: PostRecord; pnl: number; won: boolean; winner: string }>;
  } = {
    resolvable: 0,
    unresolved: 0,
    wins: 0,
    losses: 0,
    pnlWon: 0,
    pnlLost: 0,
    capitalDeployed: 0,
    detail: [],
  };
  for (const b of buys) {
    if (b.side !== "buy" || b.limit <= 0 || b.pusd <= 0) {
      continue;
    }
    const slug = titleToSlug.get(b.event);
    const winner = slug ? slugToWinner.get(slug) : undefined;
    if (!winner) {
      out.unresolved += 1;
      continue;
    }
    out.resolvable += 1;
    out.capitalDeployed += b.pusd;
    const won = winner === b.outcome;
    const pnl = won ? b.shares * (1 - b.limit) : -b.pusd;
    if (won) {
      out.wins += 1;
      out.pnlWon += pnl;
    } else {
      out.losses += 1;
      out.pnlLost += pnl;
    }
    out.detail.push({ b, pnl, won, winner });
  }
  return out;
}

function computeSkipPnL(
  skips: SkipRecord[],
  titleToSlug: Map<string, string>,
  slugToWinner: Map<string, string>
): ResolvedPnL {
  const out: ResolvedPnL = {
    resolvable: 0,
    unresolved: 0,
    wins: 0,
    losses: 0,
    pnlWon: 0,
    pnlLost: 0,
    capitalDeployed: 0,
  };
  for (const s of skips) {
    if (s.effective <= 0 || s.pusd <= 0) {
      continue;
    }
    const slug = titleToSlug.get(s.event);
    const winner = slug ? slugToWinner.get(slug) : undefined;
    if (!winner) {
      out.unresolved += 1;
      continue;
    }
    out.resolvable += 1;
    out.capitalDeployed += s.pusd;
    const shares = s.pusd / s.effective;
    const won = winner === s.outcome;
    const pnl = won ? shares * (1 - s.effective) : -s.pusd;
    if (won) {
      out.wins += 1;
      out.pnlWon += pnl;
    } else {
      out.losses += 1;
      out.pnlLost += pnl;
    }
  }
  return out;
}

function dollar(n: number): string {
  return (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(2);
}

function pad(s: string, n: number, right = false): string {
  if (s.length >= n) {
    return s.slice(0, n);
  }
  return right ? s.padStart(n) : s.padEnd(n);
}

function rate(n: number, d: number): string {
  if (d === 0) {
    return "n/a";
  }
  return ((n / d) * 100).toFixed(1) + "%";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const text = await readFile(args.logPath, "utf8");
  const lines = text.split(/\r?\n/);

  const posts: PostRecord[] = [];
  const skips: SkipRecord[] = [];
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  for (const line of lines) {
    const ts = line.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/);
    if (ts) {
      if (!firstTs) {
        firstTs = ts[1] ?? null;
      }
      lastTs = ts[1] ?? lastTs;
    }
    const rec = parseLine(line);
    if (!rec) {
      continue;
    }
    if ("kind" in rec) {
      posts.push(rec);
    } else {
      skips.push(rec);
    }
  }

  const target = (args.targetOverride ?? targetAddressFromFilename(args.logPath))?.toLowerCase();
  if (!target) {
    throw new Error(
      "Could not determine target address. Pass --target 0x... or use a log filename containing the address."
    );
  }

  const filteredPosts = posts.filter((p) => {
    if (args.mode === "dry") {
      return p.kind === "dry";
    }
    if (args.mode === "live") {
      return p.kind === "live";
    }
    return true;
  });
  const buys = filteredPosts.filter((p) => p.side === "buy");
  const sells = filteredPosts.filter((p) => p.side === "sell");

  // Skip counters
  const skipCounts = new Map<string, number>();
  const skipCapital = new Map<string, number>();
  skips.forEach((s) => {
    skipCounts.set(s.reason, (skipCounts.get(s.reason) ?? 0) + 1);
    skipCapital.set(s.reason, (skipCapital.get(s.reason) ?? 0) + s.pusd);
  });

  // Pull resolved-market lookup
  console.log("");
  console.log(`Fetching Polymarket data for ${target} ...`);
  const { titleToSlug, slugToWinner, resolvedCount } = await fetchPolymarketMaps(target);
  console.log(`  resolved markets in target's positions: ${resolvedCount}`);

  // Compute PnL
  const postPnL = computeBuyPnL(buys, titleToSlug, slugToWinner);
  const driftSkips = skips.filter((s) => s.reason === "drift");
  const underbidSkips = skips.filter((s) => s.reason === "underbid");
  const driftPnL = computeSkipPnL(driftSkips, titleToSlug, slugToWinner);
  const underbidPnL = computeSkipPnL(underbidSkips, titleToSlug, slugToWinner);

  // ─── Header ──────────────────────────────────────────────────────────────
  console.log("");
  console.log("=".repeat(72));
  console.log(`TARGET COPYABILITY REPORT — ${target}`);
  console.log("=".repeat(72));
  console.log(`Log:    ${args.logPath}`);
  console.log(`Mode:   ${args.mode} (treats ${args.mode === "both" ? "dry-run AND live posts" : args.mode === "dry" ? "ONLY dry-run posts" : "ONLY live posts"} as executed)`);
  console.log(`Range:  ${firstTs ?? "?"}  →  ${lastTs ?? "?"}`);

  // ─── Activity summary ────────────────────────────────────────────────────
  console.log("");
  console.log("── Activity ────────────────────────────────────────────────────────────");
  console.log(`Posts: ${filteredPosts.length}  (dry=${posts.filter((p) => p.kind === "dry").length}, live=${posts.filter((p) => p.kind === "live").length})`);
  console.log(`  Buys: ${buys.length}    Sells: ${sells.length}`);
  console.log(`Skips: ${skips.length}`);
  for (const [reason, cnt] of [...skipCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const cap = skipCapital.get(reason) ?? 0;
    console.log(`  ${pad(reason, 16)}  count=${pad(String(cnt), 4, true)}  origin pUSD ≈ $${cap.toFixed(2)}`);
  }
  const totalIntent = buys.reduce((a, b) => a + b.pusd, 0);
  console.log(`Buy capital INTENDED: $${totalIntent.toFixed(2)}`);

  // ─── PnL on posts ────────────────────────────────────────────────────────
  console.log("");
  console.log("── Hypothetical PnL on POSTS (treated as executed) ─────────────────────");
  console.log(`Resolvable buys: ${postPnL.resolvable}  (unresolved: ${postPnL.unresolved})`);
  console.log(`  Wins:   ${postPnL.wins}    sum PnL: ${dollar(postPnL.pnlWon)}`);
  console.log(`  Losses: ${postPnL.losses}    sum PnL: ${dollar(postPnL.pnlLost)}`);
  console.log(`  Net:    ${dollar(postPnL.pnlWon + postPnL.pnlLost)}`);
  console.log(`Capital deployed (resolved only): $${postPnL.capitalDeployed.toFixed(2)}`);
  console.log(`Win rate:  ${rate(postPnL.wins, postPnL.resolvable)}`);
  console.log(`Return on capital (resolved only): ${postPnL.capitalDeployed > 0 ? rate(postPnL.pnlWon + postPnL.pnlLost, postPnL.capitalDeployed) : "n/a"}`);

  if (args.verbose && postPnL.detail.length > 0) {
    console.log("");
    console.log("── Per-trade detail (posts) ───────────────────────────────────────────");
    for (const d of postPnL.detail) {
      const mark = d.won ? "✓" : "✗";
      console.log(
        `${mark} ${d.b.kind.padEnd(4)} pUSD=$${d.b.pusd.toFixed(2).padStart(8)}  limit=${d.b.limit.toFixed(4)}  sh=${d.b.shares.toFixed(2).padStart(8)}  pnl=${dollar(d.pnl).padStart(9)}  | ${d.b.event.slice(0, 50)} | ${d.b.outcome} vs winner=${d.winner}`
      );
    }
  }

  // ─── Skipped opportunities ───────────────────────────────────────────────
  if (args.includeSkips) {
    console.log("");
    console.log("── Hypothetical PnL on SKIPPED drift+underbid trades ──────────────────");
    console.log(`Drift skips    — resolvable=${driftPnL.resolvable}  wins=${driftPnL.wins}  losses=${driftPnL.losses}  net=${dollar(driftPnL.pnlWon + driftPnL.pnlLost)}`);
    console.log(`Underbid skips — resolvable=${underbidPnL.resolvable}  wins=${underbidPnL.wins}  losses=${underbidPnL.losses}  net=${dollar(underbidPnL.pnlWon + underbidPnL.pnlLost)}`);
    console.log(`Combined missed opportunity: ${dollar(driftPnL.pnlWon + driftPnL.pnlLost + underbidPnL.pnlWon + underbidPnL.pnlLost)}`);
  }

  // ─── Recommendation ──────────────────────────────────────────────────────
  const netPnL = postPnL.pnlWon + postPnL.pnlLost;
  const winRateNum = postPnL.resolvable > 0 ? postPnL.wins / postPnL.resolvable : 0;
  const roc = postPnL.capitalDeployed > 0 ? netPnL / postPnL.capitalDeployed : 0;
  let verdict: string;
  let reasoning: string;
  if (postPnL.resolvable < 5) {
    verdict = "INSUFFICIENT DATA";
    reasoning = "Need more resolved trades to judge. Run the bot longer (or set dry_run = true) and re-analyze.";
  } else if (netPnL > 0 && winRateNum >= 0.6 && roc >= 0.15) {
    verdict = "COPYABLE";
    reasoning = "Positive net PnL, good win rate, healthy return on capital. Consider live-trading.";
  } else if (netPnL > 0) {
    verdict = "MARGINAL";
    reasoning = "Slightly profitable but win rate or return on capital is modest. Watch longer before scaling up.";
  } else {
    verdict = "AVOID";
    reasoning = "Net negative. Even hypothetical PnL is a loss — copying live would lose real capital.";
  }

  console.log("");
  console.log("── Verdict ─────────────────────────────────────────────────────────────");
  console.log(`${verdict}`);
  console.log(`  Net PnL on resolved posts: ${dollar(netPnL)}`);
  console.log(`  Win rate: ${rate(postPnL.wins, postPnL.resolvable)}`);
  console.log(`  Return on capital: ${postPnL.capitalDeployed > 0 ? rate(netPnL, postPnL.capitalDeployed) : "n/a"}`);
  console.log(`  ${reasoning}`);

  // ─── Caveats ─────────────────────────────────────────────────────────────
  console.log("");
  console.log("── Caveats ─────────────────────────────────────────────────────────────");
  console.log(`• Unresolved posts (${postPnL.unresolved}): markets that haven't settled OR target merged/closed positions pre-settlement (so resolution isn't in the positions endpoint).`);
  console.log("• Real execution vs simulated: live orders pay fees (~2%), can partial-fill, and incur slippage — typical knockdown 15–25% off simulated PnL.");
  console.log("• Sample size matters: short log = high variance. Re-run after more days of activity for higher confidence.");
}

void main().catch((e) => {
  console.error(`\nERROR: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
