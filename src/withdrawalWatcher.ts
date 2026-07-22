import { Contract, JsonRpcProvider, formatUnits, getAddress } from "ethers";
import { CONDITIONAL_TOKENS, CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2, PUSD_TOKEN } from "./contracts.js";
import { appendCopyTradeSuccessLine } from "./copyTradeSuccessLog.js";
import type { AppConfig } from "./env.js";
import { fetchPolymarketProfileLabel } from "./polymarketProfile.js";
import { isTelegramEnabled, sendTelegram } from "./telegram.js";

const ERC20_BALANCE_ABI = ["function balanceOf(address owner) view returns (uint256)"];
const ERC20_TRANSFER_ABI = ["event Transfer(address indexed from, address indexed to, uint256 value)"];

/**
 * Non-archive RPCs (e.g. Chainstack's current plan) only serve eth_getLogs within a small recent
 * window — empirically ~128 blocks; a wider range errors as "archive". We cap each scan below that so
 * a delayed poll or long interval can't produce an ever-growing range that fails forever. At ~2s
 * Polygon blocks, 100 blocks ≈ 3.3 min, and the scan interval is capped (below) to stay well inside.
 */
const MAX_SCAN_BLOCKS = 100;
const MAX_SCAN_INTERVAL_MS = 120_000; // ≤2 min → ~60 blocks, comfortably inside the recent window

/**
 * Polymarket-internal destinations. pUSD sent here is trade settlement / redemption / merge — NOT a
 * withdrawal. Empirically EVERY trade settles collateral to the CTF Exchange, so excluding these
 * addresses makes trading (of any size) invisible to the watcher; only funds leaving to an external
 * address count. Extend via WITHDRAWAL_INTERNAL_ADDRESSES (comma-separated) without a code change.
 */
function internalAddresses(): Set<string> {
  const set = new Set(
    [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2, CONDITIONAL_TOKENS].map((a) => a.toLowerCase())
  );
  for (const a of (process.env["WITHDRAWAL_INTERNAL_ADDRESSES"] ?? "").split(",")) {
    const t = a.trim().toLowerCase();
    if (t) {
      set.add(t);
    }
  }
  return set;
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

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

/**
 * Watches each target wallet for fund withdrawals — pUSD leaving the proxy to a NON-Polymarket
 * address. Some traders rotate to a fresh address to shake off copy bots; the tell is funds draining
 * out of the watched wallet.
 *
 * Detection (poll-based, every `withdrawalPollMinutes`): scan the pUSD `Transfer` logs with the
 * wallet as sender over the blocks since the last poll, and sum only those whose recipient is NOT a
 * Polymarket contract (see internalAddresses). Because ALL trade collateral settles to the Exchange,
 * trading — at any volume — is excluded by destination and never trips the alert. This replaces the
 * old cash-vs-position-value heuristic, which could not tell a losing trade (cash gone, position now
 * worthless) apart from a real withdrawal and so false-alerted on active targets.
 */
export function startWithdrawalWatcher(config: AppConfig): { stop: () => void } {
  const watched = config.withdrawalWatchAddresses;
  if (watched.length === 0) {
    console.info("withdrawal watcher: no targets have watch_withdrawals enabled — not started");
    return { stop: () => undefined };
  }

  const provider = new JsonRpcProvider(config.polygonMempoolHttpUrl);
  const pusd = new Contract(PUSD_TOKEN, ERC20_TRANSFER_ABI, provider) as Contract & {
    filters: { Transfer: (from?: string | null, to?: string | null) => ReturnType<Contract["filters"][string]> };
  };
  const internal = internalAddresses();
  const lastBlock = new Map<string, number>(); // target(lowercase) → last block scanned
  const labelCache = new Map<string, string>();
  // Cap the interval so the per-poll block range stays inside the RPC's recent-getLogs window.
  const intervalMs = Math.min(config.withdrawalPollMinutes * 60_000, MAX_SCAN_INTERVAL_MS);
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

  const pollOne = async (address: string, currentBlock: number): Promise<void> => {
    const key = address.toLowerCase();
    const from = lastBlock.get(key);
    // First observation: set the baseline block and scan nothing historical (no alert on startup).
    if (from === undefined) {
      lastBlock.set(key, currentBlock);
      return;
    }
    if (currentBlock <= from) {
      return; // no new blocks
    }

    // Clamp the range to the RPC's recent window. If we've fallen further behind than that (a delayed
    // poll or a long downtime), we CAN'T read the older blocks on a non-archive RPC — so we skip the
    // gap and warn, rather than error forever on an ever-growing range.
    let fromBlock = from + 1;
    if (currentBlock - fromBlock > MAX_SCAN_BLOCKS) {
      const gapEnd = currentBlock - MAX_SCAN_BLOCKS - 1;
      const warn =
        `withdrawal watcher · GAP for ${address}: blocks ${fromBlock}–${gapEnd} not scanned ` +
        `(RPC recent-window limit) — a withdrawal in that gap could be missed`;
      console.warn(warn);
      const gapLog = logPathFor(address);
      if (gapLog) {
        void appendCopyTradeSuccessLine(warn, gapLog);
      }
      fromBlock = currentBlock - MAX_SCAN_BLOCKS;
    }

    // All pUSD transfers SENT by this wallet since we last looked.
    const logs = await pusd.queryFilter(pusd.filters.Transfer(address, null), fromBlock, currentBlock);

    // Sum only the ones leaving to a non-Polymarket address; group by destination for the alert.
    const byDest = new Map<string, number>();
    let externalOut = 0;
    for (const log of logs) {
      const args = (log as unknown as { args?: { to?: string; value?: bigint } }).args;
      if (!args?.to || args.value === undefined) {
        continue;
      }
      if (internal.has(args.to.toLowerCase())) {
        continue; // trade settlement / redemption — not a withdrawal
      }
      const usd = parseFloat(formatUnits(args.value, 6));
      if (!Number.isFinite(usd) || usd <= 0) {
        continue;
      }
      externalOut += usd;
      byDest.set(args.to.toLowerCase(), (byDest.get(args.to.toLowerCase()) ?? 0) + usd);
    }

    // Advance the cursor only after a successful scan (a throw skips this and we retry the range).
    lastBlock.set(key, currentBlock);

    if (externalOut > thresholdUsd) {
      const label = await labelFor(address);
      const cash = await fetchCashBalance(provider, address);
      const dests = [...byDest.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([addr, amt]) => `${addr} ($${amt.toFixed(2)})`)
        .join(", ");
      const msg =
        `⚠️ WITHDRAWAL ALERT · target=${address} (${label}) · $${externalOut.toFixed(2)} sent to ` +
        `non-Polymarket address(es): ${dests} · ` +
        `${cash !== null ? `current cash=$${cash.toFixed(2)} · ` : ""}` +
        `target may have moved funds out — review before continuing to copy`;
      console.warn(msg);
      const logPath = logPathFor(address);
      if (logPath) {
        void appendCopyTradeSuccessLine(msg, logPath);
      }
      if (isTelegramEnabled()) {
        const destLines = [...byDest.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([addr, amt]) => `   ${addr} ($${amt.toFixed(2)})`)
          .join("\n");
        const card =
          `⚠️ WITHDRAWAL ALERT\n\n` +
          `👤 ${label} (${shortAddr(address)})\n` +
          `💸 $${externalOut.toFixed(2)} sent to non-Polymarket address(es):\n${destLines}\n` +
          `${cash !== null ? `Current cash: $${cash.toFixed(2)}\n` : ""}` +
          `\nTarget may have moved funds out — review before continuing to copy.`;
        void sendTelegram(card);
      }
    }
  };

  const poll = async (): Promise<void> => {
    let currentBlock: number;
    try {
      currentBlock = await provider.getBlockNumber();
    } catch (e) {
      console.warn(`withdrawal watcher · getBlockNumber failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    for (const address of watched) {
      try {
        await pollOne(address, currentBlock);
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
