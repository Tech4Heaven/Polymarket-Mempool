import { Contract, JsonRpcProvider } from "ethers";
import { appendFile, readFile } from "fs/promises";
import { basename, isAbsolute, resolve } from "path";
import { CONDITIONAL_TOKENS } from "./contracts.js";
import { ensureClobClient } from "./copyTrade.js";
import { appendCopyTradeSuccessLine } from "./copyTradeSuccessLog.js";
import { evaluateTargetStop } from "./drawdownGuard.js";
import { mergeCopyTradeConfig, type AppConfig, type CopyTradeConfig } from "./env.js";
import { readLedger, type LedgerRecord } from "./orderLedger.js";
import { appendRealizedPnl, readRealizedPnl } from "./pnlRealized.js";
import { isTelegramEnabled, sendTelegram, tgCode, tgEsc } from "./telegram.js";

/**
 * Per-target realized-P&L reconciler. Finds markets the bot traded (from the order ledger) that have
 * RESOLVED and writes ONE `[resolved]` line per (target, market) to that target's log.
 *
 * CRITICAL: fills come from the TRUE, final fill of each order — NOT the ledger's post-time fill. A
 * resting order shows `filled=0` at post time but often fills seconds/minutes later; the ledger never
 * sees that. So for every ledger order we look up its real `size_matched` via the CLOB by `orderId`
 * (`client.getOrder`). If that lookup is unavailable, we fall back to the wallet's on-chain trades for
 * the whole condition (data-api). Either way the numbers reflect what actually filled and redeemed.
 *
 * P&L per (target, condition):
 *   netShares[outcome] = Σ(buy shares) − Σ(sell shares)   // hedge legs are just buys of their side
 *   netUsdc            = Σ(buy usdc)   − Σ(sell usdc)      // net cash out
 *   payout             = max(0, netShares[winner]) × $1
 *   pnl                = payout − netUsdc
 */

const RECONCILE_INTERVAL_MS = 30_000;
const STARTUP_DELAY_MS = 30_000;
const MAX_CHECKS_PER_CYCLE = 25;
// Net shares below this (per outcome) mean the per-order fills are inconsistent — more was SOLD than
// bought, so the ledger is missing buys for this condition. Trusting it fabricates a phantom "win"
// (sell proceeds counted with no matching cost), so we fall back to the on-chain total instead.
const NEG_SHARE_TOLERANCE = 1;

type ClobClient = Awaited<ReturnType<typeof ensureClobClient>>;

function resolvedPath(): string {
  const raw = process.env["PNL_RESOLVED_PATH"]?.trim() || "logs/pnl-resolved.jsonl";
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

async function loadResolved(): Promise<Set<string>> {
  const s = new Set<string>();
  try {
    const txt = await readFile(resolvedPath(), "utf8");
    for (const line of txt.split("\n")) {
      const c = line.trim();
      if (c) {
        s.add(c);
      }
    }
  } catch {
    // no file yet
  }
  return s;
}

async function markResolved(conditionId: string): Promise<void> {
  try {
    await appendFile(resolvedPath(), conditionId + "\n");
  } catch {
    // best-effort
  }
}

const CTF_RESOLUTION_ABI = [
  "function payoutDenominator(bytes32) view returns (uint256)",
  "function payoutNumerators(bytes32, uint256) view returns (uint256)",
];

/**
 * Static outcome ordering per condition: index i (the ConditionalTokens outcome slot) → outcome label.
 * The token list and its order are fixed at market creation and available immediately — only the CLOB
 * `winner` flag lags. Cached forever since it never changes.
 */
type MarketToken = { tokenId: string; outcome: string; winner: boolean };
const marketTokenCache = new Map<string, MarketToken[]>();

/**
 * The market's outcome tokens in outcome-slot order: {tokenId, outcome, winner}. We key P&L on
 * `tokenId` (immutable, identical across CLOB/data-api/ledger) rather than the outcome LABEL, which
 * differs between sources (e.g. CLOB "O'connell" vs data-api "Oconnell") and silently zeroed payouts.
 */
async function fetchMarketTokens(conditionId: string): Promise<MarketToken[] | null> {
  const cached = marketTokenCache.get(conditionId);
  if (cached) {
    return cached;
  }
  try {
    const res = await fetch(`https://clob.polymarket.com/markets/${conditionId}`, {
      headers: { "user-agent": "copybot-pnl-reconciler" },
    });
    if (!res.ok) {
      return null;
    }
    const d = (await res.json()) as { tokens?: { token_id?: string; outcome?: string; winner?: boolean }[] };
    if (!Array.isArray(d.tokens) || d.tokens.length < 2) {
      return null;
    }
    const toks = d.tokens.map((t) => ({
      tokenId: String(t.token_id ?? ""),
      outcome: String(t.outcome ?? ""),
      winner: t.winner === true,
    }));
    if (toks.some((t) => !t.tokenId || !t.outcome)) {
      return null;
    }
    marketTokenCache.set(conditionId, toks);
    return toks;
  } catch {
    return null;
  }
}

/** tokenId → payout fraction in [0,1] (sums to ~1). Keyed by tokenId, NOT outcome label (labels differ across sources). */
export type Payouts = Map<string, number>;

/**
 * On-chain payout VECTOR from ConditionalTokens: fraction[i] = payoutNumerators[i] / denominator.
 * This is the AUTHORITATIVE, FAST source (set the instant the market resolves, ~1 min). Crucially it
 * handles BOTH a single winner ([1,0] → 1.0/0.0) AND a SPLIT resolution ([1,1]/2 → 0.5/0.5) — e.g. a
 * voided / walkover / tied sports market, where EVERY share pays $0.50, not $1-to-the-winner.
 * Returns null if unresolved (denominator 0) or on a read failure.
 */
async function onchainPayouts(
  provider: JsonRpcProvider,
  conditionId: string,
  outcomeCount: number
): Promise<number[] | null> {
  try {
    const ctf = new Contract(CONDITIONAL_TOKENS, CTF_RESOLUTION_ABI, provider) as unknown as {
      payoutDenominator: (c: string) => Promise<bigint>;
      payoutNumerators: (c: string, i: number) => Promise<bigint>;
    };
    const denom = await ctf.payoutDenominator(conditionId);
    if (denom === 0n) {
      return null; // not resolved yet
    }
    const d = Number(denom);
    const fr: number[] = [];
    for (let i = 0; i < outcomeCount; i++) {
      const n = await ctf.payoutNumerators(conditionId, i);
      fr.push(Number(n) / d);
    }
    return fr.some((x) => x > 0) ? fr : null;
  } catch {
    return null;
  }
}

/** CLOB `winner` flag — slower fallback, used only if the on-chain read is unavailable. */
async function clobWinner(conditionId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://clob.polymarket.com/markets/${conditionId}`, {
      headers: { "user-agent": "copybot-pnl-reconciler" },
    });
    if (!res.ok) {
      return null;
    }
    const d = (await res.json()) as { closed?: boolean; tokens?: { outcome?: string; winner?: boolean }[] };
    if (!d.closed || !Array.isArray(d.tokens)) {
      return null;
    }
    const w = d.tokens.find((t) => t.winner);
    return w?.outcome ?? null;
  } catch {
    return null;
  }
}

/**
 * Payout fractions per outcome for a resolved market, or null if unresolved / lookup failed. On-chain
 * payout vector is primary (handles 50:50 splits correctly). The CLOB single-winner flag is only a
 * fallback and CANNOT represent a split (it assumes winner=1, loser=0), so on-chain must lead.
 */
type Resolution = {
  /** tokenId → payout fraction. Used to compute P&L (matched by tokenId, robust to label differences). */
  byToken: Payouts;
  /** Human display: winner outcome, or "Up 50% / Down 50%" for a split. */
  label: string;
  /** tokenId of the highest-paying outcome (for the exit-before-payout heuristic). */
  topTokenId: string;
};

async function fetchPayouts(provider: JsonRpcProvider, conditionId: string): Promise<Resolution | null> {
  const toks = await fetchMarketTokens(conditionId);
  if (!toks) {
    return null; // can't resolve tokens → can't price by token; retry next cycle
  }
  let fr = await onchainPayouts(provider, conditionId, toks.length);
  if (!fr) {
    // Fallback: CLOB `winner` flag → 1.0 to the winning token, 0 to the rest (can't express a split).
    if (!toks.some((t) => t.winner)) {
      return null; // not resolved on-chain AND no CLOB winner → unresolved
    }
    fr = toks.map((t) => (t.winner ? 1 : 0));
  }
  const byToken: Payouts = new Map();
  const parts: { outcome: string; f: number; tokenId: string }[] = [];
  toks.forEach((t, i) => {
    const f = fr![i] ?? 0;
    byToken.set(t.tokenId, f);
    if (f > 0) {
      parts.push({ outcome: t.outcome, f, tokenId: t.tokenId });
    }
  });
  parts.sort((a, b) => b.f - a.f);
  const label =
    parts.length === 0
      ? "?"
      : parts.length === 1
        ? parts[0]!.outcome
        : parts.map((p) => `${p.outcome} ${Math.round(p.f * 100)}%`).join(" / ");
  return { byToken, label, topTokenId: parts[0]?.tokenId ?? "" };
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) {
      arr.push(it);
    } else {
      m.set(k, [it]);
    }
  }
  return m;
}

/**
 * Pure per-target P&L from records (whose fills are the TRUE fills). Accepts either a single winning
 * outcome (string → treated as {winner: 1}) or a full payout map (for 50:50 / split resolutions).
 * Payout = Σ over outcomes of held-shares × payout-fraction — so a "losing" side in a 50:50 still
 * contributes its $0.50/share instead of being counted as $0.
 */
export function computeTargetPnl(
  trs: LedgerRecord[],
  winnerOrPayouts: string | Payouts
): {
  netSharesByOutcome: Map<string, number>;
  netSharesByToken: Map<string, number>;
  netUsdc: number;
  payout: number;
  pnl: number;
} {
  const payouts: Payouts = typeof winnerOrPayouts === "string" ? new Map([[winnerOrPayouts, 1]]) : winnerOrPayouts;
  const netSharesByOutcome = new Map<string, number>();
  const netSharesByToken = new Map<string, number>();
  let netUsdc = 0;
  for (const r of trs) {
    const sgn = r.side === "buy" ? 1 : -1;
    netSharesByOutcome.set(r.outcome, (netSharesByOutcome.get(r.outcome) ?? 0) + sgn * r.filledShares);
    netSharesByToken.set(r.tokenId, (netSharesByToken.get(r.tokenId) ?? 0) + sgn * r.filledShares);
    netUsdc += sgn * r.filledUsdc;
  }
  // Payout matched by tokenId (robust to outcome-label differences across sources).
  let payout = 0;
  for (const [tok, sh] of netSharesByToken) {
    payout += Math.max(0, sh) * (payouts.get(tok) ?? 0);
  }
  return { netSharesByOutcome, netSharesByToken, netUsdc, payout, pnl: payout - netUsdc };
}

/**
 * Replace each record's post-time fill with its TRUE final fill from the CLOB (`getOrder.size_matched`).
 * Cost per order ≈ matched × order price (marketable copies fill at/near their limit). Returns null if
 * any order can't be looked up, so the caller can fall back to the on-chain condition total.
 */
async function correctFillsViaOrders(client: ClobClient, records: LedgerRecord[]): Promise<LedgerRecord[] | null> {
  const out: LedgerRecord[] = [];
  for (const r of records) {
    try {
      const o = (await client.getOrder(r.orderId)) as { size_matched?: string; price?: string };
      const matched = parseFloat(o.size_matched ?? "0") || 0;
      const p = parseFloat(o.price ?? "");
      const price = Number.isFinite(p) && p > 0 ? p : r.limitPrice;
      out.push({ ...r, filledShares: matched, filledUsdc: matched * price });
    } catch {
      return null; // order not queryable → fall back to on-chain for the whole condition
    }
  }
  return out;
}

/** On-chain condition-level realized P&L for the bot wallet (fallback), from data-api trades. */
async function conditionPnlFromChain(
  funder: string,
  conditionId: string,
  payouts: Payouts
): Promise<{ payout: number; netUsdc: number } | null> {
  try {
    // Filter to THIS market server-side (`market=<conditionId>`): returns just this condition's rows,
    // so it works no matter how active the wallet is. `limit` is hard-capped at 500 by the API — asking
    // for more returns `{"error":"max activity limit of 500 exceeded"}` (a non-array), which is exactly
    // what was making every card show "Target: n/a".
    const url = new URL("https://data-api.polymarket.com/activity");
    url.searchParams.set("user", funder);
    url.searchParams.set("market", conditionId);
    url.searchParams.set("limit", "500");
    const res = await fetch(url, { headers: { "user-agent": "copybot-pnl-reconciler" } });
    if (!res.ok) {
      return null;
    }
    const d = (await res.json()) as unknown;
    if (!Array.isArray(d)) {
      return null; // error object / unexpected shape — never iterate it
    }
    const cond = conditionId.toLowerCase();
    const sharesByToken = new Map<string, number>();
    let netUsdc = 0;
    for (const x of d as Array<Record<string, unknown>>) {
      if (x["type"] !== "TRADE" || String(x["conditionId"] ?? "").toLowerCase() !== cond) {
        continue;
      }
      const sgn = x["side"] === "BUY" ? 1 : -1;
      netUsdc += sgn * (parseFloat(String(x["usdcSize"] ?? "0")) || 0);
      const tok = String(x["asset"] ?? ""); // token id — matches the payout map's key
      sharesByToken.set(tok, (sharesByToken.get(tok) ?? 0) + sgn * (parseFloat(String(x["size"] ?? "0")) || 0));
    }
    // Payout = Σ over tokens of held-shares × payout-fraction (by tokenId; handles single-winner AND splits).
    let payout = 0;
    for (const [tok, sh] of sharesByToken) {
      payout += Math.max(0, sh) * (payouts.get(tok) ?? 0);
    }
    return { payout, netUsdc };
  } catch {
    return null;
  }
}

// ── Telegram resolution card ──────────────────────────────────────────────────

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
function money(x: number): string {
  return `${x >= 0 ? "+" : "-"}$${Math.abs(x).toFixed(2)}`;
}
function usernameFor(config: AppConfig, target: string): string {
  const lp = config.targetCopyProfiles.get(target)?.copyTradeLogPath;
  if (lp) {
    const name = basename(lp).replace(/\.log$/, "").split("_0x")[0];
    if (name) {
      return name;
    }
  }
  return "target";
}
/** Outcome the bot primarily bought — the "your side" line. */
function primaryBuySide(recs: LedgerRecord[]): string {
  const cnt = new Map<string, number>();
  for (const r of recs) {
    if (r.side === "buy") {
      cnt.set(r.outcome, (cnt.get(r.outcome) ?? 0) + 1);
    }
  }
  let best = "";
  let n = -1;
  for (const [oc, c] of cnt) {
    if (c > n) {
      best = oc;
      n = c;
    }
  }
  return best || recs[0]?.outcome || "?";
}
/** If the bot bought the winning side but sold most of it before resolution, describe it. */
function exitBeforePayout(trs: LedgerRecord[], winnerTokenId: string, heldWinner: number): string | undefined {
  let bSh = 0;
  let bUsd = 0;
  let sSh = 0;
  let sUsd = 0;
  for (const r of trs) {
    if (r.tokenId !== winnerTokenId) {
      continue;
    }
    if (r.side === "buy") {
      bSh += r.filledShares;
      bUsd += r.filledUsdc;
    } else {
      sSh += r.filledShares;
      sUsd += r.filledUsdc;
    }
  }
  if (bSh > 0.5 && sSh > bSh * 0.5 && heldWinner < bSh * 0.5) {
    return `bought ${bSh.toFixed(0)} @${(bUsd / bSh).toFixed(2)}, sold ${sSh.toFixed(0)} @${(sUsd / sSh).toFixed(2)}`;
  }
  return undefined;
}

type CardOpts = {
  target: string;
  conditionId: string;
  event: string;
  winner: string; // display label (e.g. "Up", or "Up 50% / Down 50%" for a split)
  payouts: Payouts; // outcome → fraction; needed to compute the TARGET's P&L correctly (incl. splits)
  yourSide: string;
  breakdown: string;
  cost: number;
  payout: number;
  pnl: number;
  exitFlag?: string;
};

// One target usually resolves several markets around the same time (multiple 5-min coins). Rather
// than a card per market, we buffer a target's freshly-resolved markets and send ONE card with the
// TOTAL P&L (yours vs the target's), so you compare like-for-like at that moment.
//   - FLUSH_QUIET: flush this many ms after the LAST new resolution for the target (debounce).
//   - FLUSH_MAX:   but never hold a batch longer than this from its first market.
const FLUSH_QUIET_MS = 45_000;
const FLUSH_MAX_MS = 4 * 60_000;

type PendingBatch = {
  markets: CardOpts[];
  /** conditionIds already queued in THIS batch — guards against the same market being listed/summed
   * twice when a market is enqueued more than once (overlapping reconcile cycles, a crash-loop /
   * double-started instance, or any re-processing before the resolved-cache write lands). Without this,
   * N re-enqueues produced an N× inflated card (e.g. 3 markets × 8 cycles → "24 markets", 8× the P&L). */
  seen: Set<string>;
  firstTs: number;
  timer: ReturnType<typeof setTimeout>;
};
const pendingByTarget = new Map<string, PendingBatch>();

/** Add a resolved market to its target's pending batch and (re)arm the debounced flush. */
function enqueueResolutionCard(config: AppConfig, o: CardOpts): void {
  const key = o.target.toLowerCase();
  let p = pendingByTarget.get(key);
  const now = Date.now();
  if (!p) {
    p = { markets: [], seen: new Set(), firstTs: now, timer: setTimeout(() => undefined, 0) };
    pendingByTarget.set(key, p);
  }
  if (p.seen.has(o.conditionId)) {
    return; // already queued this market for this target in the current batch — never list/sum it twice
  }
  p.seen.add(o.conditionId);
  p.markets.push(o);
  clearTimeout(p.timer);
  const delay = Math.min(FLUSH_QUIET_MS, Math.max(0, FLUSH_MAX_MS - (now - p.firstTs)));
  p.timer = setTimeout(() => void flushBatch(config, key), delay);
  p.timer.unref();
}

async function flushBatch(config: AppConfig, key: string): Promise<void> {
  const p = pendingByTarget.get(key);
  if (!p) {
    return;
  }
  pendingByTarget.delete(key);
  await sendAggregatedCard(config, p.markets);
}

/**
 * One card per target for a batch of just-resolved markets: total your-P&L vs total target-P&L (with
 * the delta), a compact per-market win/loss list, and the target's running today / all-time totals.
 * Best-effort; never throws to the caller.
 */
async function sendAggregatedCard(config: AppConfig, markets: CardOpts[]): Promise<void> {
  if (markets.length === 0) {
    return;
  }
  try {
    const target = markets[0]!.target;
    const yourTotal = markets.reduce((s, m) => s + m.pnl, 0);

    // The target's own P&L for each market (on-chain), summed. Unknown markets are skipped.
    const targetPerMarket = await Promise.all(
      markets.map(async (m) => {
        const t = await conditionPnlFromChain(m.target, m.conditionId, m.payouts);
        return t ? t.payout - t.netUsdc : null;
      })
    );
    let targetTotal = 0;
    let targetKnown = false;
    for (const tp of targetPerMarket) {
      if (tp !== null) {
        targetTotal += tp;
        targetKnown = true;
      }
    }

    // Running totals: the batch's markets are already in the realized ledger by flush time, so sum directly.
    const realized = await readRealizedPnl();
    const today = utcDay(Date.now());
    let allTotal = 0;
    let dayTotal = 0;
    for (const r of realized) {
      if (r.target.toLowerCase() !== target.toLowerCase()) {
        continue;
      }
      allTotal += r.pnl;
      if (utcDay(r.ts) === today) {
        dayTotal += r.pnl;
      }
    }

    const profile = config.targetCopyProfiles.get(target);
    const stop = evaluateTargetStop(allTotal, dayTotal, profile?.maxDrawdownTotal, profile?.maxDrawdownPerDay);

    const n = markets.length;
    const lines: string[] = [
      `${yourTotal >= 0 ? "✅ WIN" : "🔴 LOSS"}  ·  ${money(yourTotal)}  ·  ${n} market${n > 1 ? "s" : ""} resolved`,
      "",
      `👤 ${tgEsc(usernameFor(config, target))}`,
      tgCode(target),
      "",
    ];
    for (const m of markets) {
      lines.push(`${m.pnl >= 0 ? "✅" : "🔴"} ${tgEsc(m.event)} — ${money(m.pnl)}${m.exitFlag ? " ⚠️" : ""}`);
    }
    lines.push("", `You:    ${money(yourTotal)}`);
    lines.push(
      targetKnown
        ? `Target: ${money(targetTotal)}     (Δ ${money(yourTotal - targetTotal)} vs target)`
        : "Target: n/a"
    );
    lines.push("", `This target — today: ${money(dayTotal)} · all-time: ${money(allTotal)}`);
    if (stop) {
      lines.push(`⛔ ${tgEsc(stop)} — copying paused`);
    }

    await sendTelegram(lines.join("\n"));
  } catch (e) {
    console.warn(`[telegram] card failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function reconcileOnce(
  config: AppConfig,
  client: ClobClient,
  funder: string | undefined,
  provider: JsonRpcProvider
): Promise<void> {
  const records = await readLedger();
  if (records.length === 0) {
    return;
  }
  const resolved = await loadResolved();
  const byCondition = groupBy(
    records.filter((r) => !resolved.has(r.conditionId)),
    (r) => r.conditionId
  );

  let checks = 0;
  for (const [conditionId, recs] of byCondition) {
    if (checks >= MAX_CHECKS_PER_CYCLE) {
      break;
    }
    checks += 1;
    const resolution = await fetchPayouts(provider, conditionId);
    if (resolution === null) {
      continue; // not resolved yet
    }
    const { byToken: payouts, label: winner, topTokenId } = resolution;

    const event = recs.find((r) => r.event)?.event ?? "";
    const corrected = await correctFillsViaOrders(client, recs);

    // Trust the exact per-order path only if it's internally consistent. If any target oversold an
    // outcome (net shares < −tolerance), the ledger is missing buys for this condition and the P&L is
    // fabricated — fall through to the on-chain total, which reflects real trades + redemptions.
    let trustCorrected = corrected !== null;
    if (corrected) {
      for (const [target, trs] of groupBy(corrected, (r) => r.target)) {
        const { netSharesByOutcome } = computeTargetPnl(trs, payouts);
        const oversold = [...netSharesByOutcome.entries()].find(([, sh]) => sh < -NEG_SHARE_TOLERANCE);
        if (oversold) {
          trustCorrected = false;
          console.warn(
            `[pnl] orderId fills inconsistent (oversold ${oversold[0]}=${oversold[1].toFixed(2)}sh) · ` +
              `condition=${conditionId} target=${target} → using on-chain fallback`
          );
          break;
        }
      }
    }

    if (corrected && trustCorrected) {
      // Exact, per-order → per-target.
      for (const [target, trs] of groupBy(corrected, (r) => r.target)) {
        const { netSharesByOutcome, netSharesByToken, netUsdc, payout, pnl } = computeTargetPnl(trs, payouts);
        const breakdown = [...netSharesByOutcome.entries()].map(([oc, sh]) => `${oc}=${sh.toFixed(2)}sh`).join(" ");
        writeResolved(config, target, event, conditionId, winner, breakdown, payout, netUsdc, pnl, "orderId");
        if (isTelegramEnabled()) {
          enqueueResolutionCard(config, {
            target,
            conditionId,
            event,
            winner,
            payouts,
            yourSide: primaryBuySide(trs),
            breakdown,
            cost: netUsdc,
            payout,
            pnl,
            exitFlag: exitBeforePayout(trs, topTokenId, netSharesByToken.get(topTokenId) ?? 0),
          });
        }
      }
    } else {
      // Fallback: on-chain condition total, split across the condition's targets by buy-order count.
      if (!funder) {
        continue; // no wallet to query on-chain — retry next cycle (getOrder may recover)
      }
      const chain = await conditionPnlFromChain(funder, conditionId, payouts);
      if (chain === null) {
        continue; // couldn't determine fills — retry next cycle (do NOT mark resolved)
      }
      const byTarget = groupBy(recs, (r) => r.target);
      const weights = new Map<string, number>();
      let totalW = 0;
      for (const [t, trs] of byTarget) {
        const w = trs.filter((r) => r.side === "buy").length || 1;
        weights.set(t, w);
        totalW += w;
      }
      for (const [target, trs] of byTarget) {
        const frac = (weights.get(target) ?? 0) / (totalW || 1);
        const payout = chain.payout * frac;
        const netUsdc = chain.netUsdc * frac;
        const pnl = payout - netUsdc;
        const note = byTarget.size > 1 ? `on-chain split ${byTarget.size}-way` : "on-chain";
        const ev = trs.find((r) => r.event)?.event ?? event;
        writeResolved(config, target, ev, conditionId, winner, "", payout, netUsdc, pnl, note);
        if (isTelegramEnabled()) {
          enqueueResolutionCard(config, {
            target,
            conditionId,
            event: ev,
            winner,
            payouts,
            yourSide: primaryBuySide(trs),
            breakdown: "",
            cost: netUsdc,
            payout,
            pnl,
          });
        }
      }
    }

    await markResolved(conditionId);
  }
}

function writeResolved(
  config: AppConfig,
  target: string,
  event: string,
  conditionId: string,
  winner: string,
  breakdown: string,
  payout: number,
  netUsdc: number,
  pnl: number,
  source: string
): void {
  const line =
    `[resolved] target=${target} market=${JSON.stringify(event)} condition=${conditionId} winner=${winner} · ` +
    `${breakdown ? breakdown + " · " : ""}payout=$${payout.toFixed(4)} cost=$${netUsdc.toFixed(4)} · ` +
    `pnl=$${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} · src=${source}`;
  const logPath = config.targetCopyProfiles.get(target)?.copyTradeLogPath;
  if (logPath) {
    void appendCopyTradeSuccessLine(line, logPath);
  } else {
    console.log(line);
  }
  void appendRealizedPnl({ ts: Date.now(), target, conditionId, pnl });
}

/** Start the periodic reconciler. No-op when copy trading is disabled or no targets exist. */
export function startPnlReconciler(config: AppConfig): void {
  if (!config.copyTradeShared) {
    return;
  }
  const probe = config.targetCopyProfiles.values().next().value;
  if (!probe) {
    return;
  }
  const cfg: CopyTradeConfig = mergeCopyTradeConfig(config.copyTradeShared, probe);
  let client: ClobClient | null = null;
  // Provider for reading ConditionalTokens resolution on-chain (fast winner detection).
  const provider = new JsonRpcProvider(config.polygonMempoolHttpUrl, 137, { staticNetwork: true });

  const run = async () => {
    try {
      if (!client) {
        client = await ensureClobClient(cfg);
      }
      await reconcileOnce(config, client, cfg.funderAddress, provider);
    } catch (e) {
      console.warn(`[pnl] reconcile error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Self-rescheduling timer: the NEXT cycle is scheduled only AFTER the current one finishes. This
  // guarantees cycles never overlap — overlapping cycles both saw a market as unresolved (it's marked
  // resolved only at the end) and each sent the resolution card, producing DUPLICATE notifications.
  // (A plain setInterval + a coinciding startup setTimeout previously fired two concurrent runs.)
  const scheduleNext = (delayMs: number): void => {
    const t = setTimeout(async () => {
      await run();
      scheduleNext(RECONCILE_INTERVAL_MS);
    }, delayMs);
    t.unref();
  };
  scheduleNext(STARTUP_DELAY_MS);
  console.info("pnl reconciler: on · winner from on-chain ConditionalTokens payout (CLOB fallback), fills from getOrder");
}
