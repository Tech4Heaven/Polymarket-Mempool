import {
  JsonRpcProvider,
  WebSocketProvider,
  getAddress,
  id,
  zeroPadValue,
  type AbstractProvider,
  type Log,
} from "ethers";
import WebSocket from "ws";
import type { AppConfig } from "./env.js";

export type TargetMatch = {
  /** Hash of the mined tx that fired an OrderFilled event referencing one of our targets. */
  txHash: string;
  /** HTTP provider for receipt fetching — keeps the WSS sub on Alchemy and bulk reads on Chainstack. */
  provider: AbstractProvider;
  /** Configured target addresses present in this tx (matched via OrderFilled topic1/topic2). */
  matchedTargets: string[];
};

/**
 * Keccak256(OrderFilled(bytes32,address,address,uint8,uint256,uint256,uint256,uint256,bytes32,bytes32))
 * — topic0 of every Polymarket CTF Exchange V2 fill. Topics layout:
 *   topic0 = event sig (this constant)
 *   topic1 = orderHash (bytes32, indexed)
 *   topic2 = maker    (address, indexed)
 *   topic3 = taker    (address, indexed)
 */
const ORDER_FILLED_TOPIC = id(
  "OrderFilled(bytes32,address,address,uint8,uint256,uint256,uint256,uint256,bytes32,bytes32)"
);

/** Disable `permessage-deflate` to dodge the WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH frame-corruption bug. */
function makeWebSocket(url: string): WebSocket {
  return new WebSocket(url, {
    perMessageDeflate: false,
    handshakeTimeout: 10_000,
  });
}

/** Heartbeat tuning: ping the WSS this often, terminate if no pong within the timeout. */
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * Subscribes to `OrderFilled` logs on the CTF Exchange V2 contracts, filtered SERVER-SIDE
 * by maker/taker topic so the provider only pushes events where one of our configured target
 * addresses participated. Volume drops to a few hundred events/day regardless of overall
 * exchange traffic — fits in any free tier with no message drops.
 *
 * Latency is identical to the previous mempool-pending approach because the downstream code
 * already waited for the receipt (`waitForTransaction`) before building the copy digest. Logs
 * fire as soon as the block is broadcast → receipt is immediately available.
 *
 * Two filters are needed because Ethereum log filters can't OR across distinct topic positions:
 *   - filterMaker: OrderFilled where `topic2 (maker)` ∈ targets
 *   - filterTaker: OrderFilled where `topic3 (taker)` ∈ targets
 * A short-lived dedupe map suppresses double-fires when the same target appears as both
 * maker and taker in the same tx (rare but possible).
 */
export function startMempoolWatcher(
  config: AppConfig,
  onTargetMatch: (m: TargetMatch) => void,
  onError: (err: unknown, context: string) => void
): { provider: WebSocketProvider; stop: () => void } {
  const makeProvider = () =>
    new WebSocketProvider(() => makeWebSocket(config.polygonWssUrl) as never);
  const httpProvider = new JsonRpcProvider(config.polygonMempoolHttpUrl);
  let provider = makeProvider();
  let stopped = false;
  let reconnecting = false;
  let reconnectAttempt = 0;

  // Pre-compute lookups: lowercased targets for matching, zero-padded for topic filter values.
  const targetsLc = new Set(config.targetTraderAddresses.map((a) => a.toLowerCase()));
  const paddedTargets = config.targetTraderAddresses.map((a) =>
    zeroPadValue(a.toLowerCase(), 32)
  );
  const exchangeAddrsLc = config.exchangeAddresses.map((a) => a.toLowerCase());

  const filterMaker = {
    address: exchangeAddrsLc,
    topics: [ORDER_FILLED_TOPIC, null, paddedTargets],
  };
  const filterTaker = {
    address: exchangeAddrsLc,
    topics: [ORDER_FILLED_TOPIC, null, null, paddedTargets],
  };

  // Dedupe identical txHashes — one matchOrders call can emit several OrderFilled events that
  // all reference our target. Entries older than 5 minutes are purged on each insert.
  const seenTxs = new Map<string, number>();
  const DEDUPE_TTL_MS = 5 * 60_000;
  const purgeOldDedupe = (now: number) => {
    for (const [k, t] of seenTxs) {
      if (now - t > DEDUPE_TTL_MS) {
        seenTxs.delete(k);
      }
    }
  };

  let eventCount = 0;
  let dupeCount = 0;
  setInterval(() => {
    if (eventCount > 0 || dupeCount > 0) {
      console.log(`[watcher] target events=${eventCount} duplicates=${dupeCount}`);
    }
    eventCount = 0;
    dupeCount = 0;
  }, 60_000).unref();

  // Reset backoff only after the connection has been alive for STABILITY_MS.
  // Resetting eagerly inside bindProvider caused a tight 1s retry loop when the WSS
  // dropped immediately after handshake (provider rate-limited / blocked).
  let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  const STABILITY_MS = 30_000;
  const clearStability = () => {
    if (stabilityTimer) {
      clearTimeout(stabilityTimer);
      stabilityTimer = null;
    }
  };
  const armStability = () => {
    clearStability();
    stabilityTimer = setTimeout(() => {
      reconnectAttempt = 0;
      stabilityTimer = null;
    }, STABILITY_MS);
    stabilityTimer.unref();
  };

  const extractMatchedTarget = (log: Log): string | null => {
    // topic2 = maker, topic3 = taker. Whichever matches our targets, return the checksum address.
    for (const topicIdx of [2, 3]) {
      const t = log.topics[topicIdx];
      if (!t) {
        continue;
      }
      // Extract address from padded 32-byte topic (last 20 bytes).
      const addrLc = `0x${t.slice(-40).toLowerCase()}`;
      if (targetsLc.has(addrLc)) {
        try {
          return getAddress(addrLc);
        } catch {
          return null;
        }
      }
    }
    return null;
  };

  const processLog = (log: Log) => {
    try {
      // ethers Log doesn't expose `removed`, but reorged logs come back through the same path
      // with the standard event behavior — we accept them; the receipt fetch downstream will
      // surface any final inconsistency.
      const matched = extractMatchedTarget(log);
      if (!matched) {
        return;
      }
      const txHash = log.transactionHash;
      const now = Date.now();
      if (seenTxs.has(txHash)) {
        dupeCount += 1;
        return;
      }
      seenTxs.set(txHash, now);
      purgeOldDedupe(now);
      eventCount += 1;
      onTargetMatch({ txHash, provider: httpProvider, matchedTargets: [matched] });
    } catch (e) {
      onError(e, `processLog(${log.transactionHash ?? "?"})`);
    }
  };

  const bindProvider = (p: WebSocketProvider) => {
    // Capture whether this bind is a reconnect (vs. the initial startup bind). We log a success
    // line only on reconnect so the user can tell when the bot is back online after a drop.
    const wasReconnect = reconnectAttempt > 0;
    const attemptAtBind = reconnectAttempt;

    // ethers handles eth_subscribe internally for log filters via SocketEventSubscriber.
    // Two listeners — one for maker-side fills, one for taker-side. Same processLog handles both.
    const subMaker = p.on(filterMaker, processLog);
    const subTaker = p.on(filterTaker, processLog);
    subMaker.catch?.((err: unknown) => {
      onError(err, "subscribe filterMaker failed");
      void reconnect("subscribe failed");
    });
    subTaker.catch?.((err: unknown) => {
      onError(err, "subscribe filterTaker failed");
      void reconnect("subscribe failed");
    });
    // Log when both subscribes resolve — proves WSS handshake + eth_subscribe both succeeded.
    Promise.all([subMaker, subTaker])
      .then(() => {
        if (wasReconnect) {
          console.log(
            `[watcher] reconnected · subscriptions re-armed after ${attemptAtBind} attempt(s)`
          );
        }
      })
      .catch(() => undefined); // individual catches above already handle the error/reconnect path

    // Backoff only resets after the new connection has survived STABILITY_MS without
    // erroring — proves the WSS is genuinely stable, not just initiating a handshake
    // that the provider is about to drop.
    armStability();

    p.on("error", (err) => {
      onError(err, "provider error");
      void reconnect("provider error");
    });

    const ws = (
      p as unknown as {
        websocket?: {
          on?: (evt: string, cb: (...args: unknown[]) => void) => void;
          ping?: (data?: unknown, mask?: boolean, cb?: (err?: Error) => void) => void;
          terminate?: () => void;
          readyState?: number;
        };
      }
    ).websocket;
    ws?.on?.("error", (err: unknown) => {
      onError(err, "websocket error");
      void reconnect("websocket error");
    });

    // Heartbeat: send a ws-level ping every HEARTBEAT_INTERVAL_MS. If no pong arrives within
    // HEARTBEAT_TIMEOUT_MS, terminate the socket — that fires `close` and the existing reconnect
    // path kicks in. Catches "zombie" connections where TCP appears alive (no FIN/RST received)
    // but no frames are flowing, which is the failure mode that caused us to silently miss the
    // target's 8:50PM ET BTC trade on June 19/20.
    let awaitingPong = false;
    let pongTimer: ReturnType<typeof setTimeout> | null = null;
    const clearPongTimer = () => {
      if (pongTimer) {
        clearTimeout(pongTimer);
        pongTimer = null;
      }
    };
    const pingInterval = setInterval(() => {
      if (!ws || ws.readyState !== 1 /* OPEN */) {
        return;
      }
      clearPongTimer();
      awaitingPong = true;
      try {
        ws.ping?.();
      } catch {
        // ignore — if ping throws, the next close/error path will handle reconnect
      }
      pongTimer = setTimeout(() => {
        if (awaitingPong) {
          console.warn(
            `[watcher] heartbeat timeout — no pong in ${HEARTBEAT_TIMEOUT_MS / 1000}s; terminating zombie connection`
          );
          try {
            ws.terminate?.();
          } catch {
            // terminate is best-effort; close handler will still recover
          }
        }
      }, HEARTBEAT_TIMEOUT_MS);
      pongTimer.unref();
    }, HEARTBEAT_INTERVAL_MS);
    pingInterval.unref();
    ws?.on?.("pong", () => {
      awaitingPong = false;
      clearPongTimer();
    });

    ws?.on?.("close", (code: unknown) => {
      // Stop pinging the dead socket; the reconnect path will create a fresh ws with fresh timers.
      clearInterval(pingInterval);
      clearPongTimer();
      awaitingPong = false;
      onError(new Error(`websocket closed code=${String(code)}`), "websocket close");
      void reconnect("websocket close");
    });
  };

  const reconnect = async (reason: string) => {
    if (stopped || reconnecting) {
      return;
    }
    reconnecting = true;
    clearStability();
    reconnectAttempt += 1;
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(5, reconnectAttempt - 1));
    onError(new Error(`reconnecting websocket (${reason}) in ${delayMs}ms`), "watcher reconnect");
    try {
      provider.removeAllListeners();
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
    clearStability();
    provider.removeAllListeners();
    void provider.destroy();
  };

  return { provider, stop };
}

/** Kept for backwards compat with any callers / scripts that imported it. */
export function pendingTxSummary(tx: { hash: string; from?: string; to?: string | null }): string {
  return `${tx.hash} from=${tx.from ?? "?"} to=${tx.to ?? "(contract creation)"}`;
}
