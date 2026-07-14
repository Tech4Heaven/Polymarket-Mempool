import { appendFile, readFile } from "fs/promises";
import { isAbsolute, resolve } from "path";
import { appendCopyTradeSuccessLine } from "./copyTradeSuccessLog.js";
import type { AppConfig } from "./env.js";
import { readLedger, type LedgerRecord } from "./orderLedger.js";
import { appendRealizedPnl } from "./pnlRealized.js";

/**
 * Per-target P&L reconciler. Periodically finds markets the bot traded (from the order ledger) that
 * have RESOLVED and writes ONE `[resolved]` line per (target, market) to that target's log — with the
 * winner, realized shares, cost and net P&L. Computed once at resolution, then readable forever from
 * the log with zero API calls. Idempotent + restart-safe via a resolved-markers file.
 *
 * P&L per (target, condition), from the ledger's fills:
 *   netShares[outcome] = Σ(buy shares) − Σ(sell shares)      // hedge legs are just buys of their side
 *   netUsdc            = Σ(buy usdc)   − Σ(sell usdc)        // net cash out
 *   payout             = max(0, netShares[winner]) × $1
 *   pnl                = payout − netUsdc
 */

const RECONCILE_INTERVAL_MS = 2 * 60_000;
const STARTUP_DELAY_MS = 30_000;
const MAX_CHECKS_PER_CYCLE = 25; // cap resolution lookups per cycle

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
    // best-effort; worst case we re-check (and re-log) next run — rare
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
      return null; // still open
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

/**
 * Pure per-target P&L from a set of ledger records for one condition, given the winning outcome.
 * Hedge legs are just buys of their own outcome, so they fold in naturally.
 */
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
  const payout = Math.max(0, netSharesByOutcome.get(winner) ?? 0); // $1 per winning share
  return { netSharesByOutcome, netUsdc, payout, pnl: payout - netUsdc };
}

async function reconcileOnce(config: AppConfig): Promise<void> {
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
      continue; // not resolved yet — retry next cycle
    }

    for (const [target, trs] of groupBy(recs, (r) => r.target)) {
      const { netSharesByOutcome, netUsdc, payout, pnl } = computeTargetPnl(trs, winner);
      const breakdown = [...netSharesByOutcome.entries()]
        .map(([oc, sh]) => `${oc}=${sh.toFixed(2)}sh`)
        .join(" ");
      const event = trs.find((r) => r.event)?.event ?? "";

      const line =
        `[resolved] target=${target} market=${JSON.stringify(event)} condition=${conditionId} winner=${winner} · ` +
        `${breakdown} · payout=$${payout.toFixed(4)} cost=$${netUsdc.toFixed(4)} · pnl=$${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)}`;

      const logPath = config.targetCopyProfiles.get(target)?.copyTradeLogPath;
      if (logPath) {
        void appendCopyTradeSuccessLine(line, logPath);
      } else {
        console.log(line);
      }
      // Structured feed for the drawdown guard (pollable, no API/log-parsing).
      void appendRealizedPnl({ ts: Date.now(), target, conditionId, pnl });
    }

    await markResolved(conditionId);
  }
}

/** Start the periodic per-target P&L reconciler. No-op when copy trading is disabled. */
export function startPnlReconciler(config: AppConfig): void {
  if (!config.copyTradeShared) {
    return;
  }
  const run = () => {
    void reconcileOnce(config).catch((e) => {
      console.warn(`[pnl] reconcile error: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  setTimeout(run, STARTUP_DELAY_MS).unref();
  setInterval(run, RECONCILE_INTERVAL_MS).unref();
  console.info(`pnl reconciler: on · [resolved] lines written to per-target logs as markets settle`);
}
