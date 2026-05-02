import { formatUnits, getAddress, type AbstractProvider, type TransactionResponse } from "ethers";
import { extractCtf1155TransfersForTargets } from "./ctf1155Inbound.js";
import type { DecodedExchangeCall } from "./decodeExchangeCall.js";
import { loadConfig } from "./env.js";
import { startMempoolWatcher } from "./mempool.js";
import { aggregatePusdForTargets } from "./pusdTransfers.js";

function formatMatchBlock(tx: TransactionResponse, decoded: DecodedExchangeCall): string {
  const lines: string[] = [];
  lines.push(`MATCH tx=${tx.hash}`);
  lines.push(`from=${getAddress(tx.from)}`);
  lines.push(`to=${tx.to ? getAddress(tx.to) : "(none)"}`);

  if (decoded.kind === "matchOrders") {
    lines.push(`kind=matchOrders`);
    lines.push(`conditionId=${decoded.conditionId}`);
    lines.push(`takerMaker=${getAddress(decoded.takerOrder.maker)}`);
    lines.push(`takerSigner=${getAddress(decoded.takerOrder.signer)}`);
  } else {
    lines.push(`kind=preapproveOrder`);
    lines.push(`maker=${getAddress(decoded.order.maker)}`);
    lines.push(`signer=${getAddress(decoded.order.signer)}`);
  }

  return lines.join("\n");
}

async function logMinedTransfers(
  provider: AbstractProvider,
  txHash: string,
  matchedTargets: string[]
): Promise<void> {
  try {
    const receipt = await provider.waitForTransaction(txHash);
    if (!receipt) {
      return;
    }

    const { received, sent } = aggregatePusdForTargets(receipt, matchedTargets);
    const { inbound, outbound } = extractCtf1155TransfersForTargets(receipt, matchedTargets);

    const parts: string[] = [];
    if (received !== 0n || sent !== 0n) {
      const side: string[] = [];
      if (received !== 0n) {
        side.push(`+${formatUnits(received, 6)}`);
      }
      if (sent !== 0n) {
        side.push(`−${formatUnits(sent, 6)}`);
      }
      parts.push(`pUSD ${side.join(" / ")}`);
    }
    for (const o of inbound) {
      parts.push(`outcome +${o.amountPer1e6} tokenId=${o.tokenId}`);
    }
    for (const o of outbound) {
      parts.push(`outcome sent ${o.amountPer1e6} tokenId=${o.tokenId}`);
    }

    if (parts.length === 0) {
      return;
    }
    console.log(`mined tx=${txHash}`);
    console.log(parts.join("\n"));
    console.log("---------------------------------------------------\n");
  } catch (e) {
    console.error(`mined error tx=${txHash}`, e);
  }
}

function main() {
  const { provider } = startMempoolWatcher(
    loadConfig(),
    ({ tx, decoded, matchedTargets }) => {
      console.log(formatMatchBlock(tx, decoded));
      void logMinedTransfers(provider, tx.hash, matchedTargets);
    },
    (err, context) => {
      console.error(`${context}:`, err);
    }
  );
}

main();
