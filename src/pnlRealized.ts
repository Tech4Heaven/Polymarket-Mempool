import { appendFile, readFile } from "fs/promises";
import { isAbsolute, resolve } from "path";

/**
 * Structured realized-P&L feed (JSONL): one record per (target, resolved market), written by the
 * pnlReconciler. This is the pollable source of truth for the drawdown guard — no API calls, no log
 * parsing. `ts` is the reconcile (≈ resolution) time, used for per-day (UTC) aggregation.
 */
export type RealizedPnl = { ts: number; target: string; conditionId: string; pnl: number };

function realizedPath(): string {
  const raw = process.env["PNL_REALIZED_PATH"]?.trim() || "logs/pnl-realized.jsonl";
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

export async function appendRealizedPnl(rec: RealizedPnl): Promise<void> {
  try {
    await appendFile(realizedPath(), JSON.stringify(rec) + "\n");
  } catch {
    // best-effort
  }
}

export async function readRealizedPnl(): Promise<RealizedPnl[]> {
  let txt: string;
  try {
    txt = await readFile(realizedPath(), "utf8");
  } catch {
    return [];
  }
  const out: RealizedPnl[] = [];
  for (const line of txt.split("\n")) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      out.push(JSON.parse(t) as RealizedPnl);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}
