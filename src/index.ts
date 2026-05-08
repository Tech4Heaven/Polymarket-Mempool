import type { AbstractProvider } from "ethers";
import { getAddress } from "ethers";
import { buildCopyDigests, ensureClobClient, executeCopyTrade } from "./copyTrade.js";
import { extractCtf1155TransfersForTargets } from "./ctf1155Inbound.js";
import type { AppConfig } from "./env.js";
import { loadAppConfig, mergeCopyTradeConfig } from "./env.js";
import { startMempoolWatcher } from "./mempool.js";
import { aggregatePusdForTargets } from "./pusdTransfers.js";

async function logMinedTransfers(
  provider: AbstractProvider,
  txHash: string,
  matchedTargets: string[],
  config: AppConfig
): Promise<void> {
  try {
    const receipt = await provider.waitForTransaction(txHash);
    if (!receipt) {
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
      for (const d of digests) {
        void executeCopyTrade(copyCfg, d, txHash).catch((e) => {
          console.error(`copy trade failed tx=${txHash} target=${profile.address} token=${d.tokenId}`, e);
        });
      }
    }
  } catch (e) {
    console.error(`mined error tx=${txHash}`, e);
  }
}

async function main() {
  const config = await loadAppConfig();

  if (config.copyTradeShared) {
    const probe = config.targetCopyProfiles.values().next().value;
    if (!probe) {
      console.error("CLOB: copy trading enabled but no target profiles — check copy-targets.toml / env.");
    } else {
      try {
        await ensureClobClient(mergeCopyTradeConfig(config.copyTradeShared, probe));
        console.info("CLOB: createOrDeriveApiKey OK (L2 credentials derived from wallet).");
      } catch (e) {
        console.error("CLOB: createOrDeriveApiKey failed — copy trades will fail until auth succeeds:", e);
      }
    }
  }

  startMempoolWatcher(
    config,
    ({ tx, provider, matchedTargets }) => {
      void logMinedTransfers(provider, tx.hash, matchedTargets, config);
    },
    (err, context) => {
      console.error(`${context}:`, err);
    }
  );
}

void main();
