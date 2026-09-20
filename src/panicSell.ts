import fs from "fs";
import path from "path";
import { formatUnits } from "ethers";
import { AssetType, OrderType, Side } from "@polymarket/clob-client-v2";
import type { AppConfig, CopyTradeConfig } from "./env.js";
import { ensureClobClient } from "./copyTrade.js";
import { appendCopyTradeSuccessLine } from "./copyTradeSuccessLog.js";
import { sendTelegram, tgEsc } from "./telegram.js";

/**
 * Fleet-wide PANIC exit + market blocklist.
 *
 * When the operator panics about a market, `/panic <slug> [up|down|both]` (Telegram) appends a line to
 * a SHARED file that EVERY bot watches. On seeing a new entry each bot, for that market:
 *   1. cancels its open orders on the market's token(s),
 *   2. SWEEP-SELLS its entire balance of the requested side(s) at any price (a marketable sell at the
 *      minimum tick — the matching engine fills best-bid-first, so you take the best available prices
 *      and only give up value as far down as the book forces; any remainder rests at the floor and
 *      fills on the next bid), and
 *   3. BLOCKS the panicked SIDE from any further copies — the OTHER outcome keeps copying normally
 *      (so a hedge/other-direction copy continues). Persisted, since the shared file is the source of
 *      truth (re-read on boot; removing the line via `/unpanic` lifts the block for that side).
 *
 * "All bots at once" comes from every bot watching the same shared file (default: ../panic.jsonl in the
 * common parent dir, so all sibling deployments share one file). The Telegram command only writes the
 * file — the per-bot watchers do the work, so a non-listener bot reacts too.
 */

const GAMMA_URL = "https://gamma-api.polymarket.com/markets";
const POLL_MS = 2000;

type Side3 = "up" | "down" | "both";
type PanicEntry = { slug: string; side: Side3; ts: number };
type MarketTokens = { up?: string; down?: string; condition?: string };

/** Tokens (normalized) currently blocked from copying. Rebuilt from the file on every read. */
const blockedTokens = new Set<string>();
/** slug → resolved tokens (gamma), cached so re-reads don't refetch. */
const slugResolveCache = new Map<string, MarketTokens>();
/** `${slug}|${side}` already sold in this process, so a poll/boot doesn't re-dump repeatedly. */
const processedKeys = new Set<string>();

function normKey(id: string): string {
  const s = id.trim();
  try {
    return BigInt(s).toString();
  } catch {
    return s.toLowerCase();
  }
}

/** True if this token belongs to a panicked (blocked) market — copy path skips it. */
export function isPanicBlocked(tokenId: string): boolean {
  return blockedTokens.has(normKey(tokenId));
}

function normalizeSide(raw: string | undefined): Side3 {
  const s = (raw ?? "both").trim().toLowerCase();
  if (s === "up" || s === "down") return s;
  return "both";
}

/** The token(s) an entry's side refers to — used for BOTH the block set and the sell. Side-specific:
 *  panicking one side blocks/sells only that side; the OTHER outcome keeps copying. */
function sideTokensFor(side: Side3, tokens: MarketTokens): { tok: string; label: string }[] {
  const out: { tok: string; label: string }[] = [];
  if ((side === "up" || side === "both") && tokens.up) out.push({ tok: tokens.up, label: "Up" });
  if ((side === "down" || side === "both") && tokens.down) out.push({ tok: tokens.down, label: "Down" });
  return out;
}

/** Resolve a market slug to its Up/Down token ids via gamma (cached). */
async function resolveSlugToTokens(slug: string): Promise<MarketTokens | null> {
  const cached = slugResolveCache.get(slug);
  if (cached) return cached;
  try {
    const url = new URL(GAMMA_URL);
    url.searchParams.set("slug", slug);
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>[];
    if (!Array.isArray(data) || data.length === 0) return null;
    const m = data[0]!;
    const tokenIds = parseJsonArray(m["clobTokenIds"]);
    const outcomes = parseJsonArray(m["outcomes"]);
    const out: MarketTokens = { condition: typeof m["conditionId"] === "string" ? (m["conditionId"] as string) : undefined };
    for (let i = 0; i < tokenIds.length; i++) {
      const oc = (outcomes[i] ?? "").toLowerCase();
      if (oc === "up") out.up = tokenIds[i];
      else if (oc === "down") out.down = tokenIds[i];
    }
    slugResolveCache.set(slug, out);
    return out;
  } catch {
    return null;
  }
}

function parseJsonArray(raw: unknown): string[] {
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

/** Cancel all resting orders for one token, then sweep-sell the full balance at any price. */
async function panicSellToken(
  cfg: CopyTradeConfig,
  token: string,
  label: string
): Promise<{ soldShares: number; soldUsdc: number; hadPosition: boolean }> {
  const client = await ensureClobClient(cfg);

  // 1. Cancel resting orders on this token (a leftover buy could otherwise still fill; a resting
  //    hedge/safe-sell would fight our sweep).
  try {
    const orders = await client.getOpenOrders();
    if (Array.isArray(orders)) {
      for (const o of orders as unknown as Record<string, unknown>[]) {
        const tok = String(o["asset_id"] ?? o["token_id"] ?? o["tokenID"] ?? "");
        if (tok && normKey(tok) === normKey(token)) {
          const id = typeof o["id"] === "string" ? (o["id"] as string) : undefined;
          if (id) {
            try {
              await client.cancelOrder({ orderID: id });
            } catch {
              // best-effort
            }
          }
        }
      }
    }
  } catch {
    // if we can't list orders, still attempt the sell
  }

  // 2. Read full conditional balance for this token.
  let shares = 0;
  try {
    const bal = await client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: token });
    shares = parseFloat(formatUnits(BigInt(String((bal as { balance?: unknown })?.balance ?? "0")), 6));
  } catch {
    shares = 0;
  }
  if (!Number.isFinite(shares) || shares <= 0) {
    return { soldShares: 0, soldUsdc: 0, hadPosition: false };
  }

  // 3. Sweep-sell at the minimum tick (crosses every bid, best-first). Remainder rests at the floor.
  let tick = "0.01";
  let negRisk = false;
  try {
    tick = String(await client.getTickSize(token));
  } catch {
    // default 0.01
  }
  try {
    negRisk = await client.getNegRisk(token);
  } catch {
    // default false
  }
  const price = parseFloat(tick) || 0.01;
  try {
    const resp = await client.createAndPostOrder(
      { tokenID: token, price, side: Side.SELL, size: shares },
      { tickSize: tick as never, negRisk },
      OrderType.GTC
    );
    const r = resp as { takingAmount?: string; makingAmount?: string; errorMsg?: string };
    const soldShares = parseFloat(r.makingAmount ?? "0") || 0; // SELL: makingAmount = shares given
    const soldUsdc = parseFloat(r.takingAmount ?? "0") || 0; //  SELL: takingAmount = USDC received
    const note = `[PANIC] ${label} sold ${soldShares.toFixed(2)}/${shares.toFixed(2)} sh → $${soldUsdc.toFixed(2)} @floor ${price}${r.errorMsg ? ` err=${r.errorMsg}` : ""}`;
    console.warn(note);
    void appendCopyTradeSuccessLine(note, cfg.copyTradeLogPath);
    return { soldShares, soldUsdc, hadPosition: true };
  } catch (e) {
    const note = `[PANIC] ${label} sell FAILED (holding ${shares.toFixed(2)} sh): ${e instanceof Error ? e.message : String(e)}`;
    console.error(note);
    void appendCopyTradeSuccessLine(note, cfg.copyTradeLogPath);
    return { soldShares: 0, soldUsdc: 0, hadPosition: true };
  }
}

/** Process one panic entry for THIS bot: block the market, sell the requested side(s). */
async function processEntry(entry: PanicEntry, cfg: CopyTradeConfig): Promise<void> {
  const key = `${entry.slug}|${entry.side}`;
  if (processedKeys.has(key)) return;
  processedKeys.add(key);

  const tokens = await resolveSlugToTokens(entry.slug);
  if (!tokens || (!tokens.up && !tokens.down)) {
    const msg = `🚨 ${botName()} PANIC: could not resolve market slug "${tgEsc(entry.slug)}" (not found on gamma) — nothing sold.`;
    console.error(msg);
    void sendTelegram(msg);
    return;
  }
  const sideTokens = sideTokensFor(entry.side, tokens);
  if (sideTokens.length === 0) {
    const msg = `🚨 ${botName()} PANIC: market "${tgEsc(entry.slug)}" has no ${entry.side.toUpperCase()} token — nothing sold.`;
    console.error(msg);
    void sendTelegram(msg);
    return;
  }
  // Block ONLY the panicked side(s) from further copies — the OTHER outcome keeps copying normally.
  for (const { tok } of sideTokens) blockedTokens.add(normKey(tok));

  let totalSh = 0;
  let totalUsd = 0;
  let anyPosition = false;
  for (const { tok, label } of sideTokens) {
    const r = await panicSellToken(cfg, tok, `${entry.slug} ${label}`);
    totalSh += r.soldShares;
    totalUsd += r.soldUsdc;
    anyPosition = anyPosition || r.hadPosition;
  }

  // Telegram: notify only when this bot actually had exposure (avoid 13× "flat" spam); always log.
  if (anyPosition) {
    void sendTelegram(
      `🚨 ${botName()} PANIC-SOLD ${entry.side.toUpperCase()} · ${tgEsc(entry.slug)}\n` +
        `sold ${totalSh.toFixed(2)} sh → $${totalUsd.toFixed(2)} · market blocked from further copies`
    );
  } else {
    console.warn(`[PANIC] ${botName()} ${entry.slug} ${entry.side}: flat (nothing to sell) · market blocked`);
  }
}

function botName(): string {
  return process.env["BOT_NAME"]?.trim() || "bot";
}

function readEntries(file: string): PanicEntry[] {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: PanicEntry[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as { slug?: unknown; side?: unknown; ts?: unknown };
      if (typeof o.slug === "string" && o.slug) {
        out.push({ slug: o.slug, side: normalizeSide(typeof o.side === "string" ? o.side : undefined), ts: Number(o.ts) || 0 });
      }
    } catch {
      // ignore malformed line
    }
  }
  return out;
}

/**
 * Start watching the shared panic file. On each change (and at boot): rebuild the block set from ALL
 * current entries (so `/unpanic` removing a line lifts the block), and sell any entry not yet handled
 * by this process.
 */
export function startPanicWatcher(config: AppConfig, cfg: CopyTradeConfig): { stop: () => void } {
  const file = config.panicFile;
  let running = false;

  const refresh = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const entries = readEntries(file);
      // Rebuild blocked set from the current file — only the panicked SIDE of each entry (the other
      // outcome stays copyable). Removing an entry via /unpanic thus unblocks exactly that side.
      const nextBlocked = new Set<string>();
      for (const e of entries) {
        const tokens = await resolveSlugToTokens(e.slug);
        if (!tokens) continue;
        for (const { tok } of sideTokensFor(e.side, tokens)) nextBlocked.add(normKey(tok));
      }
      blockedTokens.clear();
      for (const t of nextBlocked) blockedTokens.add(t);
      // Drop processed keys no longer present so a re-added slug can fire again.
      const present = new Set(entries.map((e) => `${e.slug}|${e.side}`));
      for (const k of [...processedKeys]) if (!present.has(k)) processedKeys.delete(k);
      // Sell any new entries.
      for (const e of entries) {
        await processEntry(e, cfg);
      }
    } catch (e) {
      console.warn(`[PANIC] refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };

  // Poll-based watch (robust across editors / network filesystems).
  fs.watchFile(file, { interval: POLL_MS }, () => void refresh());
  void refresh(); // boot: establish blocks + catch anything added while down
  console.info(`[PANIC] watching ${file} · /panic <slug> [up|down|both] to trigger fleet-wide exit`);

  return {
    stop: () => {
      try {
        fs.unwatchFile(file);
      } catch {
        // ignore
      }
    },
  };
}

/** Append a panic entry to the shared file (used by the Telegram /panic command in the listener bot). */
export async function appendPanicEntry(config: AppConfig, slug: string, side: Side3): Promise<void> {
  const line = JSON.stringify({ slug, side, ts: Date.now() }) + "\n";
  await fs.promises.mkdir(path.dirname(config.panicFile), { recursive: true }).catch(() => undefined);
  await fs.promises.appendFile(config.panicFile, line, "utf8");
}

/** Remove all entries for a slug from the shared file (used by /unpanic). Returns how many removed. */
export async function removePanicEntries(config: AppConfig, slug: string): Promise<number> {
  const entries = readEntries(config.panicFile);
  const keep = entries.filter((e) => e.slug !== slug);
  const removed = entries.length - keep.length;
  if (removed > 0) {
    const text = keep.map((e) => JSON.stringify({ slug: e.slug, side: e.side, ts: e.ts })).join("\n") + (keep.length ? "\n" : "");
    await fs.promises.writeFile(config.panicFile, text, "utf8");
  }
  return removed;
}
