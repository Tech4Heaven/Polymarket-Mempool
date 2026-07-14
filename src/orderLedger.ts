import { appendFile, readFile } from "fs/promises";
import { isAbsolute, resolve } from "path";

/**
 * Append-only P&L order ledger (JSONL). One record per LIVE order the bot posts (copy or hedge),
 * capturing enough to reconcile realized profit per target once the market resolves — WITHOUT
 * re-calling any API at read time. The pnlReconciler stamps outcomes and writes `[resolved]` lines
 * to the per-target logs; this file is the durable source of what was posted/filled.
 *
 * Note (v1): `filledShares`/`filledUsdc` are the fill known at post time (the CLOB response). A
 * resting order that fills LATER is captured at its post-time value, so resting fills can be
 * undercounted. Good enough for per-target aggregation; a later pass can correct from on-chain
 * `OrderFilled` (orderId == orderHash) if exactness is needed.
 */
export type LedgerRecord = {
  ts: number;
  orderId: string;
  /** Checksum target address this order was copied for. */
  target: string;
  conditionId: string;
  tokenId: string;
  /** Outcome label of `tokenId` (e.g. "Up"/"Down") — used to match the resolved winner. */
  outcome: string;
  side: "buy" | "sell";
  isHedge: boolean;
  filledShares: number;
  filledUsdc: number;
  limitPrice: number;
  /** Market title, for human-readable `[resolved]` lines. */
  event: string;
};

function ledgerPath(): string {
  const raw = process.env["PNL_LEDGER_PATH"]?.trim() || "logs/pnl-ledger.jsonl";
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

/** Append one record. Never throws — P&L bookkeeping must never affect trading. */
export async function appendLedger(rec: LedgerRecord): Promise<void> {
  try {
    await appendFile(ledgerPath(), JSON.stringify(rec) + "\n");
  } catch {
    // swallow — bookkeeping is best-effort
  }
}

/** Read all ledger records. Skips malformed lines; returns [] if the file doesn't exist yet. */
export async function readLedger(): Promise<LedgerRecord[]> {
  let txt: string;
  try {
    txt = await readFile(ledgerPath(), "utf8");
  } catch {
    return [];
  }
  const out: LedgerRecord[] = [];
  for (const line of txt.split("\n")) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      out.push(JSON.parse(t) as LedgerRecord);
    } catch {
      // skip a partially-written / corrupt line
    }
  }
  return out;
}
