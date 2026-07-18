import { appendFile, readFile } from "fs/promises";
import { isAbsolute, resolve } from "path";
import { ensureClobClient } from "./copyTrade.js";
import { appendCopyTradeSuccessLine } from "./copyTradeSuccessLog.js";
import { mergeCopyTradeConfig, type AppConfig, type CopyTradeConfig } from "./env.js";
import { readLedger, type LedgerRecord } from "./orderLedger.js";
import { appendRealizedPnl } from "./pnlRealized.js";

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

const RECONCILE_INTERVAL_MS = 2 * 60_000;
const STARTUP_DELAY_MS = 30_000;
const MAX_CHECKS_PER_CYCLE = 25;

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

/** Winning outcome label for a resolved market, or null if not resolved / lookup failed. */
async function fetchWinner(conditionId: string): Promise<string | null> {
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

/** Pure per-target P&L from records (whose fills are the TRUE fills), given the winning outcome. */
export function computeTargetPnl(
  trs: LedgerRecord[],
  winner: string
): { netSharesByOutcome: Map<string, number>; netUsdc: number; payout: number; pnl: number } {
  const netSharesByOutcome = new Map<string, number>();
  let netUsdc = 0;
  for (const r of trs) {
    const sgn = r.side === "buy" ? 1 : -1;
    netSharesByOutcome.set(r.outcome, (netSharesByOutcome.get(r.outcome) ?? 0) + sgn * r.filledShares);
    netUsdc += sgn * r.filledUsdc;
  }
  const payout = Math.max(0, netSharesByOutcome.get(winner) ?? 0);
  return { netSharesByOutcome, netUsdc, payout, pnl: payout - netUsdc };
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
  winner: string
): Promise<{ payout: number; netUsdc: number } | null> {
  try {
    const res = await fetch(`https://data-api.polymarket.com/activity?user=${funder}&limit=1000`, {
      headers: { "user-agent": "copybot-pnl-reconciler" },
    });
    if (!res.ok) {
      return null;
    }
    const d = (await res.json()) as Array<Record<string, unknown>>;
    const cond = conditionId.toLowerCase();
    const sharesByOutcome = new Map<string, number>();
    let netUsdc = 0;
    for (const x of d) {
      if (x["type"] !== "TRADE" || String(x["conditionId"] ?? "").toLowerCase() !== cond) {
        continue;
      }
      const sgn = x["side"] === "BUY" ? 1 : -1;
      netUsdc += sgn * (parseFloat(String(x["usdcSize"] ?? "0")) || 0);
      const oc = String(x["outcome"] ?? "");
      sharesByOutcome.set(oc, (sharesByOutcome.get(oc) ?? 0) + sgn * (parseFloat(String(x["size"] ?? "0")) || 0));
    }
    return { payout: Math.max(0, sharesByOutcome.get(winner) ?? 0), netUsdc };
  } catch {
    return null;
  }
}

async function reconcileOnce(config: AppConfig, client: ClobClient, funder: string | undefined): Promise<void> {
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
    const winner = await fetchWinner(conditionId);
    if (winner === null) {
      continue; // not resolved yet
    }

    const event = recs.find((r) => r.event)?.event ?? "";
    const corrected = await correctFillsViaOrders(client, recs);

    if (corrected) {
      // Exact, per-order → per-target.
      for (const [target, trs] of groupBy(corrected, (r) => r.target)) {
        const { netSharesByOutcome, netUsdc, payout, pnl } = computeTargetPnl(trs, winner);
        const breakdown = [...netSharesByOutcome.entries()].map(([oc, sh]) => `${oc}=${sh.toFixed(2)}sh`).join(" ");
        writeResolved(config, target, event, conditionId, winner, breakdown, payout, netUsdc, pnl, "orderId");
      }
    } else {
      // Fallback: on-chain condition total, split across the condition's targets by buy-order count.
      if (!funder) {
        continue; // no wallet to query on-chain — retry next cycle (getOrder may recover)
      }
      const chain = await conditionPnlFromChain(funder, conditionId, winner);
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
        writeResolved(config, target, trs.find((r) => r.event)?.event ?? event, conditionId, winner, "", payout, netUsdc, pnl, note);
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

  const run = async () => {
    try {
      if (!client) {
        client = await ensureClobClient(cfg);
      }
      await reconcileOnce(config, client, cfg.funderAddress);
    } catch (e) {
      console.warn(`[pnl] reconcile error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  setTimeout(() => void run(), STARTUP_DELAY_MS).unref();
  setInterval(() => void run(), RECONCILE_INTERVAL_MS).unref();
  console.info("pnl reconciler: on · realized P&L from true order fills (getOrder), on-chain fallback");
}
