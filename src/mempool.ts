import { WebSocketProvider, type TransactionResponse } from "ethers";
import {
  collectOrderParticipantAddresses,
  decodeCtfExchangeCall,
  pendingTxSummary,
  type DecodedExchangeCall,
} from "./decodeExchangeCall.js";
import type { AppConfig } from "./env.js";

export type TargetMatch = {
  tx: TransactionResponse;
  decoded: DecodedExchangeCall;
  /** Which configured target(s) appear in taker/maker order maker or signer fields. */
  matchedTargets: string[];
};

const exchangeSet = (addresses: string[]) =>
  new Set(addresses.map((a) => a.toLowerCase()));

/**
 * Subscribes to the provider's pending transaction stream (eth_subscribe newPendingTransactions
 * on most nodes), fetches each tx, filters by `to` = configured exchange, decodes CTF V2 calls,
 * then flags txs where any order's maker/signer is in the target set.
 *
 * Note: `matchOrders` is `onlyOperator`. The transaction `from` is usually the operator/relayer,
 * not the end user—use decoded order fields to attribute trades to traders.
 */
export function startMempoolWatcher(
  config: AppConfig,
  onTargetMatch: (m: TargetMatch) => void,
  onError: (err: unknown, context: string) => void
): { provider: WebSocketProvider; stop: () => void } {
  const provider = new WebSocketProvider(config.polygonWssUrl);
  const exSet = exchangeSet(config.exchangeAddresses);

  let active = 0;
  const queue: string[] = [];

  const processHash = async (hash: string) => {
    let tx: TransactionResponse | null;
    try {
      tx = await provider.getTransaction(hash);
    } catch (e) {
      onError(e, `getTransaction(${hash})`);
      return;
    }
    if (!tx || !tx.to) {
      return;
    }
    if (!exSet.has(tx.to.toLowerCase())) {
      return;
    }
    const decoded = decodeCtfExchangeCall(tx.data);
    if (!decoded) {
      return;
    }

    const participants = collectOrderParticipantAddresses(decoded);
    const matchedTargets = config.targetTraderAddresses.filter((t) => {
      const tl = t.toLowerCase();
      return participants.some((p) => p.toLowerCase() === tl);
    });
    if (matchedTargets.length === 0) {
      return;
    }
    onTargetMatch({ tx, decoded, matchedTargets });
  };

  const pump = () => {
    while (active < config.maxConcurrentTxLookups && queue.length > 0) {
      const h = queue.shift();
      if (!h) {
        break;
      }
      active += 1;
      void processHash(h)
        .catch((e) => onError(e, `processHash(${h})`))
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  const onPending = (hash: string) => {
    queue.push(hash);
    pump();
  };

  provider.on("pending", onPending);

  const stop = () => {
    provider.off("pending", onPending);
    void provider.destroy();
  };

  return { provider, stop };
}

export { pendingTxSummary };
