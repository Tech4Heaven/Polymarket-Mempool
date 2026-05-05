import type { AbstractProvider } from "ethers";
import { buildCopyDigests, ensureClobClient, executeCopyTrade } from "./copyTrade.js";
import { extractCtf1155TransfersForTargets } from "./ctf1155Inbound.js";
import type { CopyTradeConfig } from "./env.js";
import { loadConfig } from "./env.js";
import { startMempoolWatcher } from "./mempool.js";
import { aggregatePusdForTargets } from "./pusdTransfers.js";

async function logMinedTransfers(
  provider: AbstractProvider,
  txHash: string,
  matchedTargets: string[],
  copyTrade: CopyTradeConfig | null
): Promise<void> {
  try {
    const receipt = await provider.waitForTransaction(txHash);
    if (!receipt) {
      return;
    }

    const { received, sent } = aggregatePusdForTargets(receipt, matchedTargets);
    const { inbound, outbound } = extractCtf1155TransfersForTargets(receipt, matchedTargets);

    if (copyTrade) {
      const digests = buildCopyDigests(received, sent, inbound, outbound);
      for (const d of digests) {
        void executeCopyTrade(copyTrade, d, txHash).catch((e) => {
          console.error(`copy trade failed tx=${txHash} token=${d.tokenId}`, e);
        });
      }
    }
  } catch (e) {
    console.error(`mined error tx=${txHash}`, e);
  }
}

async function main() {
  const config = loadConfig();

  if (config.copyTrade) {
    try {
      await ensureClobClient(config.copyTrade);
      console.info("CLOB: createOrDeriveApiKey OK (L2 credentials derived from wallet).");
    } catch (e) {
      console.error("CLOB: createOrDeriveApiKey failed — copy trades will fail until auth succeeds:", e);
    }
  }

  if (config.copyTrade?.dryRun) {
    console.info("COPY_TRADING_DRY_RUN=1 — copy logic runs; orders are not submitted.");
  }

  const { provider } = startMempoolWatcher(
    config,
    ({ tx, matchedTargets }) => {
      void logMinedTransfers(provider, tx.hash, matchedTargets, config.copyTrade);
    },
    (err, context) => {
      console.error(`${context}:`, err);
    }
  );
}

void main();
