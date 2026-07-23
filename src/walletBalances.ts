import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import { readFile, readdir } from "fs/promises";
import { dirname, join } from "path";
import { PUSD_TOKEN } from "./contracts.js";
import type { AppConfig } from "./env.js";
import { tgCode, tgEsc } from "./telegram.js";

const ERC20_BALANCE_ABI = ["function balanceOf(address owner) view returns (uint256)"];

/** A wallet to report on: a friendly name + its funder/proxy address. */
export type WalletRef = { name: string; address: string };

/** One wallet's balance snapshot. `cash`/`positions` are null on a read failure. */
export type WalletBalance = {
  name: string;
  address: string;
  cash: number | null;
  positions: number | null;
};

/** On-chain pUSD (collateral) cash balance for a wallet, in USD (6 decimals → number). */
export async function fetchCashBalance(provider: JsonRpcProvider, address: string): Promise<number | null> {
  try {
    const token = new Contract(PUSD_TOKEN, ERC20_BALANCE_ABI, provider) as unknown as {
      balanceOf: (owner: string) => Promise<bigint>;
    };
    const raw = await token.balanceOf(address);
    const v = parseFloat(formatUnits(raw, 6));
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Current open-positions value (mark-to-market, USD) via Polymarket data API. */
export async function fetchPositionsValue(address: string): Promise<number | null> {
  try {
    const url = new URL("https://data-api.polymarket.com/value");
    url.searchParams.set("user", address.toLowerCase());
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    const arr = (await res.json()) as unknown;
    if (!Array.isArray(arr) || arr.length === 0) {
      return 0;
    }
    const v = (arr[0] as { value?: unknown }).value;
    const n = typeof v === "number" ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Fetch cash + positions for every wallet (concurrently). Never throws. */
export async function fetchAllBalances(provider: JsonRpcProvider, refs: WalletRef[]): Promise<WalletBalance[]> {
  return Promise.all(
    refs.map(async (ref) => {
      const [cash, positions] = await Promise.all([
        fetchCashBalance(provider, ref.address),
        fetchPositionsValue(ref.address),
      ]);
      return { name: ref.name, address: ref.address, cash, positions };
    })
  );
}

function usd(n: number | null): string {
  return n === null ? "n/a" : `$${n.toFixed(2)}`;
}

/**
 * Build the balances card for Telegram (HTML). Each wallet's full address is a tap-to-copy <code>
 * span so it can be pasted straight into an explorer.
 */
export function formatBalancesMessage(rows: WalletBalance[]): string {
  const lines: string[] = ["💰 Wallet balances", ""];
  let sumCash = 0;
  let sumPos = 0;
  let anyCash = false;
  let anyPos = false;
  for (const r of rows) {
    const total = r.cash !== null && r.positions !== null ? r.cash + r.positions : null;
    lines.push(`${tgEsc(r.name)}  ${tgCode(r.address)}`);
    lines.push(`  cash ${usd(r.cash)} · pos ${usd(r.positions)} · total ${usd(total)}`);
    if (r.cash !== null) {
      sumCash += r.cash;
      anyCash = true;
    }
    if (r.positions !== null) {
      sumPos += r.positions;
      anyPos = true;
    }
  }
  lines.push("");
  const sumTotal = anyCash && anyPos ? sumCash + sumPos : null;
  lines.push(
    `Σ all: cash ${anyCash ? usd(sumCash) : "n/a"} · pos ${anyPos ? usd(sumPos) : "n/a"} · total ${usd(sumTotal)}`
  );
  return lines.join("\n");
}

/** Minimal .env parser: KEY=VALUE lines, skipping blanks/comments, stripping surrounding quotes. */
export async function parseEnvFile(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const raw = await readFile(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) {
        continue;
      }
      const eq = t.indexOf("=");
      if (eq < 0) {
        continue;
      }
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[k] = v;
    }
  } catch {
    // missing/unreadable → empty
  }
  return out;
}

/**
 * Wallets to report on — discovered LIVE from each deployment's `.env`, never stored on disk.
 *
 * Scans every sibling folder of this deployment (default: the parent of cwd, override with
 * WALLETS_ENV_DIR) for a `.env` containing FUNDER_ADDRESS, and labels it by that file's BOT_NAME
 * (folder name as fallback). So `/balance` always reflects the current addresses in those env files.
 * Falls back to this bot's own funder if nothing is found.
 */
export async function loadWalletList(config: AppConfig): Promise<WalletRef[]> {
  const baseDir = process.env["WALLETS_ENV_DIR"]?.trim() || dirname(process.cwd());
  const refs: WalletRef[] = [];
  const seen = new Set<string>();
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    for (const d of dirs) {
      const env = await parseEnvFile(join(baseDir, d, ".env"));
      const address = env["FUNDER_ADDRESS"]?.trim();
      if (!address) {
        continue;
      }
      const key = address.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      refs.push({ name: env["BOT_NAME"]?.trim() || d, address });
    }
  } catch {
    // base dir unreadable → fall through to single-wallet default
  }
  if (refs.length > 0) {
    return refs;
  }
  const self = config.copyTradeShared?.funderAddress;
  return self ? [{ name: process.env["BOT_NAME"]?.trim() || "this", address: self }] : [];
}
