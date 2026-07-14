import { appendCopyTradeSuccessLine } from "./copyTradeSuccessLog.js";
import type { AppConfig } from "./env.js";
import { readRealizedPnl } from "./pnlRealized.js";

/**
 * Drawdown circuit breaker. Polls the realized-P&L feed and auto-halts NEW copies for any target
 * whose realized loss breaches its configured limit:
 *   - max_drawdown_total:   all-time realized P&L ≤ −limit  → stop (until P&L recovers / limit raised)
 *   - max_drawdown_per_day: today's (UTC) realized P&L ≤ −limit → stop for the day (auto-resumes next UTC day)
 *
 * Restart-safe: state is derived from the file each poll, not held only in memory. Sells/exits are
 * NOT blocked — only new buys — so a halted target's existing positions can still be exited.
 */

const POLL_MS = 30_000;

/** target(lowercase) → current stop reason. Absent = not stopped. Read synchronously by the copy path. */
const stoppedByTarget = new Map<string, string>();

/** Human reason if the target is currently halted by a drawdown limit, else null. */
export function isTargetStopped(targetAddress: string): string | null {
  return stoppedByTarget.get(targetAddress.toLowerCase()) ?? null;
}

/** UTC calendar day (YYYY-MM-DD) for a ms timestamp. */
function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Pure decision: given a target's realized P&L (all-time and today) and its limits, return the stop
 * reason or null. Total limit takes precedence (it's the permanent one). Limits are positive USD
 * loss caps, so a breach is P&L ≤ −limit.
 */
export function evaluateTargetStop(
  totalPnl: number,
  dailyPnl: number,
  maxDrawdownTotal?: number,
  maxDrawdownPerDay?: number
): string | null {
  if (maxDrawdownTotal !== undefined && totalPnl <= -maxDrawdownTotal) {
    return `total realized P&L $${totalPnl.toFixed(2)} ≤ −$${maxDrawdownTotal} (all-time)`;
  }
  if (maxDrawdownPerDay !== undefined && dailyPnl <= -maxDrawdownPerDay) {
    return `today's realized P&L $${dailyPnl.toFixed(2)} ≤ −$${maxDrawdownPerDay} (UTC day)`;
  }
  return null;
}

export function startDrawdownGuard(config: AppConfig): void {
  const limited = [...config.targetCopyProfiles.values()].some(
    (p) => p.maxDrawdownPerDay !== undefined || p.maxDrawdownTotal !== undefined
  );
  if (!limited) {
    return; // no target has a limit — guard is a no-op
  }

  const poll = async () => {
    try {
      const recs = await readRealizedPnl();
      const today = utcDay(Date.now());
      const total = new Map<string, number>();
      const daily = new Map<string, number>();
      for (const r of recs) {
        const t = r.target.toLowerCase();
        total.set(t, (total.get(t) ?? 0) + r.pnl);
        if (utcDay(r.ts) === today) {
          daily.set(t, (daily.get(t) ?? 0) + r.pnl);
        }
      }

      for (const profile of config.targetCopyProfiles.values()) {
        const t = profile.address.toLowerCase();
        const tot = total.get(t) ?? 0;
        const day = daily.get(t) ?? 0;

        const reason = evaluateTargetStop(tot, day, profile.maxDrawdownTotal, profile.maxDrawdownPerDay) ?? "";

        const prev = stoppedByTarget.get(t) ?? "";
        if (reason && prev !== reason) {
          stoppedByTarget.set(t, reason);
          if (!prev) {
            console.warn(`[drawdown] STOP ${profile.address}: ${reason}`);
            void appendCopyTradeSuccessLine(
              `[drawdown-stop] target=${profile.address} · ${reason} · new copies halted`,
              profile.copyTradeLogPath
            );
          }
        } else if (!reason && prev) {
          stoppedByTarget.delete(t);
          console.info(`[drawdown] RESUME ${profile.address}`);
          void appendCopyTradeSuccessLine(
            `[drawdown-resume] target=${profile.address} · back within limits · copies resumed`,
            profile.copyTradeLogPath
          );
        }
      }
    } catch (e) {
      console.warn(`[drawdown] poll error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  void poll(); // load current state immediately so we don't copy a stopped target before the first tick
  setInterval(() => void poll(), POLL_MS).unref();
  console.info("drawdown guard: on · auto-stops targets breaching max_drawdown_per_day / max_drawdown_total");
}
