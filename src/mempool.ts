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
  provider: WebSocketProvider;
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
  const makeProvider = () => new WebSocketProvider(config.polygonWssUrl);
  let provider = makeProvider();
  const exSet = exchangeSet(config.exchangeAddresses);
  let stopped = false;
  let reconnecting = false;
  let reconnectAttempt = 0;

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
    onTargetMatch({ tx, provider, decoded, matchedTargets });
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

  const bindProvider = (p: WebSocketProvider) => {
    p.on("pending", onPending);
    p.on("error", (err) => {
      onError(err, "provider error");
      void reconnect("provider error");
    });

    const ws = (p as unknown as { websocket?: { on?: (evt: string, cb: (...args: unknown[]) => void) => void } })
      .websocket;
    ws?.on?.("error", (err: unknown) => {
      onError(err, "websocket error");
      void reconnect("websocket error");
    });
    ws?.on?.("close", (code: unknown) => {
      onError(new Error(`websocket closed code=${String(code)}`), "websocket close");
      void reconnect("websocket close");
    });
  };

  const reconnect = async (reason: string) => {
    if (stopped || reconnecting) {
      return;
    }
    reconnecting = true;
    reconnectAttempt += 1;
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(5, reconnectAttempt - 1));
    onError(new Error(`reconnecting websocket (${reason}) in ${delayMs}ms`), "watcher reconnect");
    try {
      provider.off("pending", onPending);
      void provider.destroy();
    } catch (e) {
      onError(e, "destroy provider");
    }

    await new Promise((r) => setTimeout(r, delayMs));
    if (stopped) {
      reconnecting = false;
      return;
    }

    provider = makeProvider();
    bindProvider(provider);
    reconnecting = false;
  };

  bindProvider(provider);

  const stop = () => {
    stopped = true;
    provider.off("pending", onPending);
    void provider.destroy();
  };

  return { provider, stop };
}

export { pendingTxSummary };
