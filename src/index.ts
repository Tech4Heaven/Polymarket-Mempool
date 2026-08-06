import type { AbstractProvider } from "ethers";
import { getAddress } from "ethers";
import type { CopyDigest } from "./copyTrade.js";
import { buildCopyDigests, cancelAllStaleGtcOrders, ensureClobClient, executeCopyTrade } from "./copyTrade.js";
import { appendCopyTradeSuccessLine } from "./copyTradeSuccessLog.js";
import { extractCtf1155TransfersForTargets } from "./ctf1155Inbound.js";
import type { AppConfig, TargetCopyParams } from "./env.js";
import { loadAppConfig, mergeCopyTradeConfig } from "./env.js";
import { startMempoolWatcher } from "./mempool.js";
import { startDrawdownGuard } from "./drawdownGuard.js";
import { startPnlReconciler } from "./pnlReconciler.js";
import { warnIfChatNotPrivate } from "./telegram.js";
import { startTelegramCommandListener } from "./telegramCommands.js";
import { startPolynodeWatcher, type PolynodeMatch } from "./polynodeWatcher.js";
import { buildDigestsFromSettlement } from "./settlementDigest.js";
import { aggregatePusdForTargets } from "./pusdTransfers.js";
import { startWithdrawalWatcher } from "./withdrawalWatcher.js";

function formatLogErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Fan-out pipeline lines (RPC / websocket / reconnect) to every target copy log when copy trading is on. */
async function appendWatcherLineToAllTargetLogs(line: string, config: AppConfig): Promise<void> {
  if (!config.copyTradeShared) {
    return;
  }
  const paths = [...new Set([...config.targetCopyProfiles.values()].map((p) => p.copyTradeLogPath))];
  await Promise.all(paths.map((fp) => appendCopyTradeSuccessLine(line, fp)));
}

// Cross-source dedupe: a (tx, target) pair is copied at most once — whichever detection source
// (PolyNode pending or on-chain OrderFilled) claims it first wins. Prevents `both` mode from
// double-copying the same trade. Entries expire after the TTL.
const copiedTxTargets = new Map<string, number>();
const COPY_DEDUPE_TTL_MS = 5 * 60_000;
function claimCopy(txHash: string, targetLc: string): boolean {
  const now = Date.now();
  for (const [k, t] of copiedTxTargets) {
    if (now - t > COPY_DEDUPE_TTL_MS) {
      copiedTxTargets.delete(k);
    }
  }
  const key = `${txHash.toLowerCase()}:${targetLc}`;
  if (copiedTxTargets.has(key)) {
    return false;
  }
  copiedTxTargets.set(key, now);
  return true;
}

/** Fire copy orders for one target's digests, isolating per-digest errors. */
function copyForProfile(config: AppConfig, profile: TargetCopyParams, digests: CopyDigest[], txHash: string): void {
  if (!config.copyTradeShared) {
    return;
  }
  const copyCfg = mergeCopyTradeConfig(config.copyTradeShared, profile);
  for (const d of digests) {
    void executeCopyTrade(copyCfg, d, txHash).catch((e) => {
      console.error(`copy trade failed tx=${txHash} target=${profile.address} token=${d.tokenId}: ${formatLogErr(e)}`);
      void appendCopyTradeSuccessLine(
        `[copy-error] tx=${txHash} token=${d.tokenId} ${formatLogErr(e)}`,
        copyCfg.copyTradeLogPath
      );
    });
  }
}

/**
 * PolyNode pending-settlement path: build the digest directly from the decoded settlement — no
 * `waitForTransaction`, no receipt — and copy immediately. This is where the ~2-blocktime latency
 * is eliminated.
 */
function handlePolynodeMatch(config: AppConfig, match: PolynodeMatch): void {
  if (!config.copyTradeShared) {
    return;
  }
  for (const profile of config.targetCopyProfiles.values()) {
    const addrLc = profile.address.toLowerCase();
    if (!match.matchedTargets.includes(addrLc)) {
      continue;
    }
    const digests = buildDigestsFromSettlement(match.data, profile.address);
    if (digests.length === 0) {
      void appendCopyTradeSuccessLine(
        `[polynode] tx=${match.txHash} no copy digest for target=${profile.address} (needs a single outcome token / single side)`,
        profile.copyTradeLogPath
      );
      continue;
    }
    if (!claimCopy(match.txHash, addrLc)) {
      continue; // already copied via the on-chain fallback
    }
    void appendCopyTradeSuccessLine(
      `[polynode] pending settlement · target=${profile.address} tx=${match.txHash} digests=${digests.length} · pendingAge=${Date.now() - match.detectedAt}ms`,
      profile.copyTradeLogPath
    );
    copyForProfile(config, profile, digests, match.txHash);
  }
}

async function logMinedTransfers(
  provider: AbstractProvider,
  txHash: string,
  matchedTargets: string[],
  config: AppConfig
): Promise<void> {
  try {
    const receipt = await provider.waitForTransaction(txHash);
    if (!receipt) {
      if (config.copyTradeShared) {
        for (const addrRaw of matchedTargets) {
          let addrKey: string;
          try {
            addrKey = getAddress(addrRaw);
          } catch {
            continue;
          }
          const profile = config.targetCopyProfiles.get(addrKey);
          if (!profile) {
            continue;
          }
          void appendCopyTradeSuccessLine(`[mined] tx=${txHash} no receipt`, profile.copyTradeLogPath);
        }
      }
      return;
    }

    if (!config.copyTradeShared) {
      return;
    }

    for (const addrRaw of matchedTargets) {
      let addrKey: string;
      try {
        addrKey = getAddress(addrRaw);
      } catch {
        continue;
      }
      const profile = config.targetCopyProfiles.get(addrKey);
      if (!profile) {
        continue;
      }

      const { received, sent } = aggregatePusdForTargets(receipt, [profile.address]);
      const { inbound, outbound } = extractCtf1155TransfersForTargets(receipt, [profile.address]);

      const digests = buildCopyDigests(received, sent, inbound, outbound);
      if (digests.length === 0) {
        void appendCopyTradeSuccessLine(
          `[skip] tx=${txHash} no copy digest for target=${profile.address} ` +
            `(buy needs sent PUSD + single inbound outcome token; sell needs received PUSD + single outbound outcome token); ` +
            `received=${received} sent=${sent} ctfInbound=${inbound.length} ctfOutbound=${outbound.length}`,
          profile.copyTradeLogPath
        );
        continue;
      }
      // In `both` mode PolyNode usually claims first (it's ~2 blocktimes faster); the on-chain path
      // then no-ops here. If PolyNode was down/missed it, on-chain claims and copies as the fallback.
      if (!claimCopy(txHash, profile.address.toLowerCase())) {
        continue;
      }
      copyForProfile(config, profile, digests, txHash);
    }
  } catch (e) {
    console.error(`mined error tx=${txHash}: ${formatLogErr(e)}`);
    if (config.copyTradeShared) {
      const msg = `[mined] tx=${txHash} error ${formatLogErr(e)}`;
      for (const addrRaw of matchedTargets) {
        let addrKey: string;
        try {
          addrKey = getAddress(addrRaw);
        } catch {
          continue;
        }
        const profile = config.targetCopyProfiles.get(addrKey);
        if (!profile) {
          continue;
        }
        void appendCopyTradeSuccessLine(msg, profile.copyTradeLogPath);
      }
    }
  }
}

async function main() {
  const config = await loadAppConfig();

  if (config.copyTradeShared) {
    const probe = config.targetCopyProfiles.values().next().value;
    if (!probe) {
      console.error("CLOB: copy trading enabled but no target profiles — check copy-targets.toml / env.");
    } else {
      const probeCfg = mergeCopyTradeConfig(config.copyTradeShared, probe);
      try {
        await ensureClobClient(probeCfg);
        console.info("CLOB: createOrDeriveApiKey OK (L2 credentials derived from wallet).");
      } catch (e) {
        console.error(`CLOB: createOrDeriveApiKey failed — copy trades will fail until auth succeeds: ${formatLogErr(e)}`);
      }
      // Restart safety: cancel orphan GTC orders from a prior run so they can't fill behind
      // the (now-empty) in-memory hedge state and create double-hedge / unexpected exposure.
      // Only runs if any target uses hedging — otherwise the bot doesn't post GTC itself either.
      const hedgePrices = [...config.targetCopyProfiles.values()]
        .map((p) => p.hedgePrice)
        .filter((x): x is number => x !== undefined);
      const anyHedging = hedgePrices.length > 0;
      if (anyHedging && !probeCfg.dryRun) {
        // Cancels ONLY stale hedge orders; every target's resting copy orders are left alone.
        await cancelAllStaleGtcOrders(probeCfg, hedgePrices);
      }
      // Mark the boot in every per-target log. Without this, a restart looks identical to
      // continuous operation when reading a per-target file later — and lost in-memory state
      // (absorbed-side markers, accumulator buffers, hedge tracking) looks like a code bug.
      const gtcNote = anyHedging && !probeCfg.dryRun ? "ran" : "skipped (no hedging or dry-run)";
      await appendWatcherLineToAllTargetLogs(
        `bot started · pid=${process.pid} · in-memory state cleared (hedge tracking, absorbed-side markers, accumulator buffers all empty) · GTC cleanup ${gtcNote}`,
        config
      );
    }
  }

  // Shared error/log sink for both detection watchers.
  const onWatcherError = (err: unknown, context: string) => {
    // One-line message only; stack traces are noise for recoverable network churn (1006s,
    // 502s, reconnects). The reconnect/recovery path already handles them.
    const msg = formatLogErr(err);
    // Use console.warn for "watcher" / "websocket" / "reconnect" events (routine, recoverable),
    // and console.error only for genuinely unexpected stuff (subscribe failed, processLog, etc.).
    const isRoutine = /reconnect|websocket (close|error)|provider error|destroy provider|terminate/i.test(context);
    if (isRoutine) {
      console.warn(`${context}: ${msg}`);
    } else {
      console.error(`${context}: ${msg}`);
    }
    void appendWatcherLineToAllTargetLogs(`[watcher] ${context}: ${msg}`, config);
  };

  const usePolynode = config.detectionSource === "polynode" || config.detectionSource === "both";
  const useOnchain = config.detectionSource === "onchain" || config.detectionSource === "both";
  console.info(`detection source: ${config.detectionSource} (polynode=${usePolynode} onchain=${useOnchain})`);

  // PolyNode pending-settlement feed — primary, ~2 blocktimes faster (no receipt wait).
  if (usePolynode) {
    const pn = startPolynodeWatcher(config, (m) => handlePolynodeMatch(config, m), onWatcherError);
    // Feed-stall alarm: if PolyNode goes quiet, warn (in `both` mode the on-chain path still copies).
    const STALL_MS = 60_000;
    let stallWarned = false;
    const stallCheck = setInterval(() => {
      const last = pn.lastMessageAt();
      if (last === 0) {
        return; // not connected yet
      }
      const quiet = Date.now() - last;
      if (quiet > STALL_MS && !stallWarned) {
        stallWarned = true;
        const msg = `[polynode] no messages for ${Math.round(quiet / 1000)}s${useOnchain ? " — relying on on-chain fallback" : " — DETECTION MAY BE DOWN"}`;
        console.warn(msg);
        void appendWatcherLineToAllTargetLogs(msg, config);
      } else if (quiet <= STALL_MS && stallWarned) {
        stallWarned = false;
        void appendWatcherLineToAllTargetLogs(`[polynode] feed recovered`, config);
      }
    }, 15_000);
    stallCheck.unref();
  }

  // On-chain OrderFilled subscription — fallback in `both`, or sole source in `onchain`.
  if (useOnchain) {
    startMempoolWatcher(
      config,
      ({ txHash, provider, matchedTargets }) => {
        void logMinedTransfers(provider, txHash, matchedTargets, config);
      },
      onWatcherError
    );
  }

  // Per-target realized-P&L reconciler: writes `[resolved]` lines to per-target logs as markets settle.
  startPnlReconciler(config);

  // Drawdown breaker: auto-halt copies for targets that breach max_drawdown_per_day / max_drawdown_total.
  startDrawdownGuard(config);

  // P&L cards / balances are private — warn if they'd land in a group where others could read them.
  warnIfChatNotPrivate();

  // Telegram /balance command listener — only where TELEGRAM_COMMAND_LISTENER=true (Main), since one
  // token can have a single getUpdates poller. Reports every deployment wallet (addresses read live
  // from each sibling folder's .env).
  startTelegramCommandListener(config);

  // Watch enabled target wallets for fund withdrawals (funds leaving → trader may have rotated address).
  startWithdrawalWatcher(config);
  if (config.withdrawalWatchAddresses.length > 0) {
    console.info(
      `withdrawal watcher: polling ${config.withdrawalWatchAddresses.length} target(s) every ${config.withdrawalPollMinutes}m (alert threshold $${config.withdrawalAlertUsd})`
    );
  }
}

void main();
