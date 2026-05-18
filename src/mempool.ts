import {
  JsonRpcProvider,
  WebSocketProvider,
  type AbstractProvider,
  type TransactionResponse,
} from "ethers";
import { SocketSubscriber } from "ethers";
import WebSocket from "ws";
import {
  collectOrderParticipantAddresses,
  decodeCtfExchangeCall,
  pendingTxSummary,
  type DecodedExchangeCall,
} from "./decodeExchangeCall.js";
import type { AppConfig } from "./env.js";

export type TargetMatch = {
  tx: TransactionResponse;
  /** HTTP provider used by callers for receipt fetching (routed off Alchemy to save quota). */
  provider: AbstractProvider;
  decoded: DecodedExchangeCall;
  /** Which configured target(s) appear in taker/maker order maker or signer fields. */
  matchedTargets: string[];
};

/**
 * Alchemy's filtered pending subscription. The push payload is the full tx (when `hashesOnly: false`),
 * so we never need a per-hash `getTransaction` call — that cut ~3M RPC requests/5h in the wild.
 *
 * Filter is `[ "alchemy_pendingTransactions", { toAddress: [...], hashesOnly: false } ]`.
 * On non-Alchemy WSS endpoints this subscription will fail at `eth_subscribe` time (the watcher
 * surfaces that via `onError` and the user must switch endpoints).
 */
class AlchemyPendingTxSubscriber extends SocketSubscriber {
  #onTx: (raw: unknown) => void;

  constructor(provider: WebSocketProvider, exchangeAddresses: string[], onTx: (raw: unknown) => void) {
    super(provider, [
      "alchemy_pendingTransactions",
      {
        toAddress: exchangeAddresses.map((a) => a.toLowerCase()),
        hashesOnly: false,
      },
    ]);
    this.#onTx = onTx;
  }

  /**
   * The parent `_handleMessage` short-circuits when its private `#filterId` is null —
   * and that field is *only* set inside the parent's `start()`. We deliberately don't call
   * `start()` (so subscribe errors are awaitable in `subscribeFiltered`), which left every push
   * silently dropped. Overriding here bypasses the stale guard and routes every message to onTx.
   */
  _handleMessage(message: unknown): void {
    this.#onTx(message);
  }
}

/**
 * Subscribes manually (instead of relying on `subscriber.start()`, which swallows the eth_subscribe
 * rejection) so we can surface failures — e.g. non-Alchemy endpoints that don't recognize
 * `alchemy_pendingTransactions`.
 */
async function subscribeFiltered(
  provider: WebSocketProvider,
  subscriber: AlchemyPendingTxSubscriber
): Promise<string> {
  const filter = subscriber.filter;
  const provAny = provider as unknown as {
    send: (method: string, params: unknown[]) => Promise<unknown>;
    _register: (filterId: string, subscriber: SocketSubscriber) => void;
  };
  const filterId = (await provAny.send("eth_subscribe", filter)) as string;
  provAny._register(filterId, subscriber);
  return filterId;
}

/**
 * Best-effort unsubscribe. The send is wrapped in a short timeout because on a broken
 * socket ethers' `send` queues forever waiting for a reconnection that never comes —
 * which was hanging the watcher's reconnect loop indefinitely on certain ws-protocol errors.
 */
async function unsubscribeFiltered(provider: WebSocketProvider, filterId: string): Promise<void> {
  const provAny = provider as unknown as {
    send: (method: string, params: unknown[]) => Promise<unknown>;
    destroyed?: boolean;
  };
  if (provAny.destroyed) {
    return;
  }
  await Promise.race([
    provAny.send("eth_unsubscribe", [filterId]).catch(() => undefined),
    new Promise<void>((r) => setTimeout(r, 1_000)),
  ]);
}

/**
 * Builds a `ws` WebSocket with `perMessageDeflate: false` to avoid compression-related
 * frame corruption that surfaces as `WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH` (RFC 6455 §5.5).
 * Cloud WSS providers + intermediate proxies sometimes negotiate compression and then deliver
 * a malformed control frame; turning compression off eliminates that failure mode.
 */
function makeWebSocket(url: string): WebSocket {
  return new WebSocket(url, {
    perMessageDeflate: false,
    handshakeTimeout: 10_000,
  });
}

/**
 * ethers' `formatTransactionResponse` already accepts JSON-RPC tx payloads
 * (input→data, gas→gasLimit aliasing), which is exactly the shape Alchemy pushes for
 * `alchemy_pendingTransactions` with `hashesOnly: false`. We just hand it to the provider's
 * wrapper so downstream `waitForTransaction` keeps working.
 */
function wrapAsTransactionResponse(
  raw: Record<string, unknown>,
  provider: AbstractProvider
): TransactionResponse {
  const provAny = provider as unknown as {
    _wrapTransactionResponse: (tx: unknown, network: unknown) => TransactionResponse;
  };
  const chainId = raw["chainId"] != null ? BigInt(raw["chainId"] as string) : 137n;
  return provAny._wrapTransactionResponse(raw, { chainId, name: "matic" });
}

const exchangeSet = (addresses: string[]) =>
  new Set(addresses.map((a) => a.toLowerCase()));

/**
 * Subscribes to Alchemy's `alchemy_pendingTransactions` with a `toAddress` filter so the WSS
 * provider only pushes us txs already addressed to a configured exchange. Each push carries the
 * full tx (calldata + from), so we decode + match traders inline with zero extra RPC.
 *
 * Receipts (when `logMinedTransfers` calls `waitForTransaction`) are fetched via the HTTP provider
 * built from `polygonMempoolHttpUrl` — typically a cheaper RPC like Chainstack, keeping Alchemy
 * usage essentially free (just the subscription + push messages, which Alchemy bills as CU not requests).
 *
 * Note: `matchOrders` is `onlyOperator`. The transaction `from` is usually the operator/relayer,
 * not the end user—use decoded order fields to attribute trades to traders.
 */
export function startMempoolWatcher(
  config: AppConfig,
  onTargetMatch: (m: TargetMatch) => void,
  onError: (err: unknown, context: string) => void
): { provider: WebSocketProvider; stop: () => void } {
  // Custom WebSocket creator → `perMessageDeflate: false` to dodge the invalid-control-frame bug.
  const makeProvider = () =>
    new WebSocketProvider(() => makeWebSocket(config.polygonWssUrl) as never);
  const httpProvider = new JsonRpcProvider(config.polygonMempoolHttpUrl);
  let provider = makeProvider();
  const exSet = exchangeSet(config.exchangeAddresses);
  let stopped = false;
  let reconnecting = false;
  let reconnectAttempt = 0;
  let subscriber: AlchemyPendingTxSubscriber | null = null;
  let subscriptionId: string | null = null;

  // Diagnostic counters so a silent "no matches" state is distinguishable from
  // "no pushes at all" (subscription wired wrong) vs "pushes but no target matches" (just no activity).
  let pushCount = 0;
  let decodedCount = 0;
  let nonMatchCount = 0;
  setInterval(() => {
    if (pushCount > 0 || decodedCount > 0) {
      console.log(
        `[mempool] pushes=${pushCount} decoded=${decodedCount} nonTargetMatches=${nonMatchCount}`
      );
    } else {
      console.log("[mempool] no pushes received in the last minute — check Alchemy filter / activity");
    }
    pushCount = 0;
    decodedCount = 0;
    nonMatchCount = 0;
  }, 60_000).unref();

  const processFullTx = (raw: Record<string, unknown>) => {
    try {
      pushCount += 1;
      const to = (raw["to"] as string | null | undefined)?.toLowerCase();
      // Defensive: Alchemy already filtered by toAddress, but verify in case of misconfig.
      if (!to || !exSet.has(to)) {
        return;
      }
      const data = (raw["input"] as string) ?? (raw["data"] as string) ?? "0x";
      const decoded = decodeCtfExchangeCall(data);
      if (!decoded) {
        return;
      }
      decodedCount += 1;
      const participants = collectOrderParticipantAddresses(decoded);
      const matchedTargets = config.targetTraderAddresses.filter((t) => {
        const tl = t.toLowerCase();
        return participants.some((p) => p.toLowerCase() === tl);
      });
      if (matchedTargets.length === 0) {
        nonMatchCount += 1;
        return;
      }
      const tx = wrapAsTransactionResponse(raw, httpProvider);
      onTargetMatch({ tx, provider: httpProvider, decoded, matchedTargets });
    } catch (e) {
      onError(e, `processFullTx(${(raw["hash"] as string) ?? "?"})`);
    }
  };

  const bindProvider = (p: WebSocketProvider) => {
    subscriber = new AlchemyPendingTxSubscriber(
      p,
      config.exchangeAddresses,
      (raw) => processFullTx(raw as Record<string, unknown>)
    );
    subscribeFiltered(p, subscriber)
      .then((id) => {
        subscriptionId = id;
        // Reset backoff: a healthy subscribe means the next disconnect should retry quickly,
        // not at whatever maxed-out 30s window the previous storm left us in.
        reconnectAttempt = 0;
      })
      .catch((err) => {
        onError(err, "alchemy_pendingTransactions subscribe failed (verify POLYGON_WSS_URL is Alchemy)");
        void reconnect("subscribe failed");
      });

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
      if (subscriptionId) {
        await unsubscribeFiltered(provider, subscriptionId).catch(() => undefined);
        subscriptionId = null;
      }
      subscriber = null;
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
    if (subscriptionId) {
      void unsubscribeFiltered(provider, subscriptionId).catch(() => undefined);
      subscriptionId = null;
    }
    subscriber = null;
    void provider.destroy();
  };

  return { provider, stop };
}

export { pendingTxSummary };
