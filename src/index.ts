import type { AbstractProvider } from "ethers";
import { getAddress } from "ethers";
import { buildCopyDigests, cancelAllStaleGtcOrders, ensureClobClient, executeCopyTrade } from "./copyTrade.js";
import { appendCopyTradeSuccessLine } from "./copyTradeSuccessLog.js";
import { extractCtf1155TransfersForTargets } from "./ctf1155Inbound.js";
import type { AppConfig } from "./env.js";
import { loadAppConfig, mergeCopyTradeConfig } from "./env.js";
import { startMempoolWatcher } from "./mempool.js";
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
      const copyCfg = mergeCopyTradeConfig(config.copyTradeShared, profile);

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
      for (const d of digests) {
        void executeCopyTrade(copyCfg, d, txHash).catch((e) => {
          console.error(`copy trade failed tx=${txHash} target=${profile.address} token=${d.tokenId}`, e);
          void appendCopyTradeSuccessLine(
            `[copy-error] tx=${txHash} token=${d.tokenId} ${formatLogErr(e)}`,
            copyCfg.copyTradeLogPath
          );
        });
      }
    }
  } catch (e) {
    console.error(`mined error tx=${txHash}`, e);
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
        console.error("CLOB: createOrDeriveApiKey failed — copy trades will fail until auth succeeds:", e);
      }
      // Restart safety: cancel orphan GTC orders from a prior run so they can't fill behind
      // the (now-empty) in-memory hedge state and create double-hedge / unexpected exposure.
      // Only runs if any target uses hedging — otherwise the bot doesn't post GTC itself either.
      const anyHedging = [...config.targetCopyProfiles.values()].some((p) => p.hedgePrice !== undefined);
      if (anyHedging && !probeCfg.dryRun) {
        await cancelAllStaleGtcOrders(probeCfg);
      }
    }
  }

  startMempoolWatcher(
    config,
    ({ txHash, provider, matchedTargets }) => {
      void logMinedTransfers(provider, txHash, matchedTargets, config);
    },
    (err, context) => {
      // One-line message only; stack traces are noise for recoverable network churn (1006s,
      // 502s, reconnects). The reconnect/recovery path already handles them.
      const msg = formatLogErr(err);
      // Use console.warn for "watcher" / "websocket" / "reconnect" events (routine, recoverable),
      // and console.error only for genuinely unexpected stuff (subscribe failed, processLog, etc.).
      const isRoutine = /watcher reconnect|websocket (close|error)|provider error|destroy provider/i.test(context);
      if (isRoutine) {
        console.warn(`${context}: ${msg}`);
      } else {
        console.error(`${context}: ${msg}`);
      }
      void appendWatcherLineToAllTargetLogs(`[watcher] ${context}: ${msg}`, config);
    }
  );

  // Watch enabled target wallets for fund withdrawals (funds leaving → trader may have rotated address).
  startWithdrawalWatcher(config);
  if (config.withdrawalWatchAddresses.length > 0) {
    console.info(
      `withdrawal watcher: polling ${config.withdrawalWatchAddresses.length} target(s) every ${config.withdrawalPollMinutes}m (alert threshold $${config.withdrawalAlertUsd})`
    );
  }
}

void main();
