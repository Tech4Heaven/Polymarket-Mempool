import { Contract, JsonRpcProvider, formatUnits, getAddress } from "ethers";
import { PUSD_TOKEN } from "./contracts.js";
import { appendCopyTradeSuccessLine } from "./copyTradeSuccessLog.js";
import type { AppConfig } from "./env.js";
import { fetchPolymarketProfileLabel } from "./polymarketProfile.js";

const ERC20_BALANCE_ABI = ["function balanceOf(address owner) view returns (uint256)"];

/** On-chain pUSD (collateral) cash balance for a wallet, in USD (6 decimals → number). */
async function fetchCashBalance(provider: JsonRpcProvider, address: string): Promise<number | null> {
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
async function fetchPositionsValue(address: string): Promise<number | null> {
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

type Snapshot = { cash: number; positions: number };

/**
 * Watches each target wallet for fund withdrawals (USDC/pUSD leaving the proxy wallet) and alerts
 * on the console + the target's copy log. Some traders rotate to a fresh address to shake off copy
 * bots; the tell is funds draining out of the watched wallet.
 *
 * Detection (poll-based, every `withdrawalPollMinutes`): we read the wallet's cash (on-chain pUSD
 * `balanceOf`) and open-positions value (data API). A genuine withdrawal shows up as cash leaving
 * WITHOUT a matching increase in positions:
 *
 *     withdrawal ≈ cashDrop − positionsGrowth
 *
 * Buys convert cash → positions (no net outflow), price swings move positions value but not cash,
 * and selling raises cash — none of which trip the alert. Only cash that exits the account does.
 */
export function startWithdrawalWatcher(config: AppConfig): { stop: () => void } {
  const watched = config.withdrawalWatchAddresses;
  if (watched.length === 0) {
    console.info("withdrawal watcher: no targets have watch_withdrawals enabled — not started");
    return { stop: () => undefined };
  }

  const provider = new JsonRpcProvider(config.polygonMempoolHttpUrl);
  const last = new Map<string, Snapshot>();
  const labelCache = new Map<string, string>();
  const intervalMs = config.withdrawalPollMinutes * 60_000;
  const thresholdUsd = config.withdrawalAlertUsd;

  const labelFor = async (address: string): Promise<string> => {
    const key = address.toLowerCase();
    const cached = labelCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const label = (await fetchPolymarketProfileLabel(address)) ?? "unknown";
    labelCache.set(key, label);
    return label;
  };

  const logPathFor = (address: string): string | undefined => {
    try {
      return config.targetCopyProfiles.get(getAddress(address))?.copyTradeLogPath;
    } catch {
      return undefined;
    }
  };

  const pollOne = async (address: string): Promise<void> => {
    const [cash, positions] = await Promise.all([
      fetchCashBalance(provider, address),
      fetchPositionsValue(address),
    ]);
    if (cash === null || positions === null) {
      return; // transient read failure — skip this round, don't update baseline
    }

    const prev = last.get(address.toLowerCase());
    last.set(address.toLowerCase(), { cash, positions });
    if (!prev) {
      return; // first observation = baseline only, no alert
    }

    const cashDrop = prev.cash - cash;
    const positionsGrowth = positions - prev.positions;
    const withdrawal = cashDrop - Math.max(0, positionsGrowth);

    if (withdrawal > thresholdUsd) {
      const label = await labelFor(address);
      const total = cash + positions;
      const prevTotal = prev.cash + prev.positions;
      const msg =
        `⚠️ WITHDRAWAL ALERT · target=${address} (${label}) · net cash out ≈ $${withdrawal.toFixed(2)} · ` +
        `current balance: cash=$${cash.toFixed(2)} positions=$${positions.toFixed(2)} total=$${total.toFixed(2)} ` +
        `(was cash=$${prev.cash.toFixed(2)} positions=$${prev.positions.toFixed(2)} total=$${prevTotal.toFixed(2)}) · ` +
        `target may have moved funds to a new address — review before continuing to copy`;
      console.warn(msg);
      const logPath = logPathFor(address);
      if (logPath) {
        void appendCopyTradeSuccessLine(msg, logPath);
      }
    }
  };

  const poll = async (): Promise<void> => {
    for (const address of watched) {
      try {
        await pollOne(address);
      } catch (e) {
        console.warn(
          `withdrawal watcher · poll failed for ${address}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  };

  // Establish baselines immediately (no alert on first pass), then poll on the interval.
  void poll();
  const timer = setInterval(() => void poll(), intervalMs);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
  };
}
