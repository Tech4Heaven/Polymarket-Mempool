import WebSocket from "ws";
import type { AppConfig } from "./env.js";
import { matchedMakerTargets, type SettlementData, type SettlementMessage } from "./settlementDigest.js";

/**
 * PolyNode pending-settlement watcher.
 *
 * Subscribes to the PolyNode `settlements` WebSocket as a FULL PENDING FIREHOSE (no `wallets`
 * filter) and matches our target wallets LOCALLY, so PolyNode is never told which wallets we copy.
 * Emits a match for every PENDING settlement involving a target (decoded from mempool calldata,
 * ~3–5s before on-chain confirmation) — replacing the ~2-blocktime `waitForTransaction` receipt wait.
 *
 * Design notes:
 *  - Firehose privacy: no wallet filter leaves this machine; local match-first drops non-target
 *    settlements immediately (one Set lookup) to keep the read loop cheap and avoid backpressure.
 *  - We deliberately do NOT replay a snapshot (`snapshot_count: 0`). Snapshot events are historical;
 *    acting on them would copy trades that already happened (fatal on 5-minute markets). Gap coverage
 *    during a disconnect is provided by the on-chain OrderFilled fallback in `both` mode.
 *  - Freshness guard: any settlement older than MAX_SETTLEMENT_AGE_MS is dropped as stale.
 *  - Dedupe by tx_hash so the same tx isn't emitted twice.
 *  - App-level `{"action":"ping"}` every 30s (cloud proxies strip native WS ping frames), plus a
 *    native ping heartbeat to detect zombie sockets.
 */

const WS_URL = "wss://ws.polynode.dev/ws";
const PING_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const STABILITY_MS = 30_000;
// Drop settlements older than this (guards against any replayed/snapshot event slipping through on
// a fast market). Kept generous so normal clock skew between our host and PolyNode can't silently
// drop live events; drops are logged, never silent.
const MAX_SETTLEMENT_AGE_MS = 15_000;
const DEDUPE_TTL_MS = 5 * 60_000;

export type PolynodeMatch = {
  txHash: string;
  /** Unix ms PolyNode detected the pending tx (fallback: message timestamp / now). */
  detectedAt: number;
  /** Lowercased target addresses present as a maker in this settlement's fills. */
  matchedTargets: string[];
  data: SettlementData;
};

export type PolynodeWatcher = {
  stop: () => void;
  /** Unix ms of the last message received from PolyNode (0 until first message). */
  lastMessageAt: () => number;
};

export function startPolynodeWatcher(
  config: AppConfig,
  onMatch: (m: PolynodeMatch) => void,
  onError: (err: unknown, context: string) => void
): PolynodeWatcher {
  const apiKey = config.polynodeApiKey;
  if (!apiKey) {
    onError(new Error("POLYNODE_API_KEY missing"), "polynode config");
    return { stop: () => undefined, lastMessageAt: () => 0 };
  }

  const targetsLower = new Set(config.targetTraderAddresses.map((a) => a.toLowerCase()));
  if (targetsLower.size === 0) {
    onError(new Error("no target addresses"), "polynode config");
    return { stop: () => undefined, lastMessageAt: () => 0 };
  }

  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnecting = false;
  let reconnectAttempt = 0;
  let fatal = false; // set on 4401 bad-key so we don't spin forever
  let lastMessage = 0;

  const seenTxs = new Map<string, number>();
  const dedupe = (txHash: string): boolean => {
    const now = Date.now();
    for (const [k, t] of seenTxs) {
      if (now - t > DEDUPE_TTL_MS) {
        seenTxs.delete(k);
      }
    }
    if (seenTxs.has(txHash)) {
      return true;
    }
    seenTxs.set(txHash, now);
    return false;
  };

  let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
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

  const handleSettlement = (data: SettlementData, msgTs: number) => {
    if (data.status !== "pending" || !data.tx_hash) {
      return;
    }
    // Firehose: match our targets locally BEFORE any other work. Non-target settlements (the vast
    // majority of the stream) are dropped here with a single Set lookup — nothing else touches them.
    // This keeps the dedupe map and logs holding ONLY our targets, and keeps the read loop cheap
    // enough that we don't create backpressure and miss (get dropped) target settlements.
    const matched = matchedMakerTargets(data, targetsLower);
    if (matched.length === 0) {
      return;
    }
    const detectedAt = data.detected_at ?? msgTs ?? Date.now();
    const age = Date.now() - detectedAt;
    if (age > MAX_SETTLEMENT_AGE_MS) {
      // Never copy old trades on fast markets. Log (not silent) so a replay burst or clock-skew
      // issue is visible rather than a mysterious "detected nothing".
      console.warn(`[polynode] dropping stale settlement tx=${data.tx_hash} age=${age}ms (>${MAX_SETTLEMENT_AGE_MS}ms)`);
      return;
    }
    if (dedupe(data.tx_hash)) {
      return;
    }
    onMatch({ txHash: data.tx_hash, detectedAt, matchedTargets: matched, data });
  };

  const onMessage = (raw: WebSocket.RawData) => {
    lastMessage = Date.now();
    let msg: SettlementMessage;
    try {
      msg = JSON.parse(raw.toString()) as SettlementMessage;
    } catch {
      return; // ignore non-JSON / pong text frames
    }
    if (msg.type === "settlement" && msg.data) {
      try {
        handleSettlement(msg.data, msg.timestamp ?? Date.now());
      } catch (e) {
        onError(e, `handleSettlement(${msg.data.tx_hash ?? "?"})`);
      }
      return;
    }
    // Control messages (subscribe ack, errors) — surface once for visibility.
    if (msg.type && msg.type !== "settlement") {
      const t = msg.type;
      if (/error|unauthor|forbidden/i.test(t)) {
        onError(new Error(`server message: ${t}`), "polynode message");
      }
    }
  };

  const bind = (socket: WebSocket) => {
    const wasReconnect = reconnectAttempt > 0;
    const attemptAtBind = reconnectAttempt;

    let awaitingPong = false;
    let pongTimer: ReturnType<typeof setTimeout> | null = null;
    const clearPongTimer = () => {
      if (pongTimer) {
        clearTimeout(pongTimer);
        pongTimer = null;
      }
    };

    socket.on("open", () => {
      // Full pending-settlement FIREHOSE — deliberately NO `wallets` filter, so PolyNode never
      // learns which wallets we copy. We match our targets locally in handleSettlement. status:pending
      // only, event_types settlement only (drops status_updates to cut volume), no snapshot replay.
      socket.send(
        JSON.stringify({
          action: "subscribe",
          type: "settlements",
          filters: {
            status: "pending",
            event_types: ["settlement"],
            snapshot_count: 0,
          },
        })
      );
      armStability();
      if (wasReconnect) {
        console.log(`[polynode] reconnected · resubscribed after ${attemptAtBind} attempt(s)`);
      } else {
        console.log(`[polynode] connected · pending-settlement firehose · filtering ${targetsLower.size} target(s) locally`);
      }
    });

    socket.on("message", onMessage);

    socket.on("error", (err) => {
      onError(err, "polynode websocket error");
      void reconnect("websocket error");
    });

    socket.on("close", (code: number) => {
      clearInterval(pingInterval);
      clearPongTimer();
      // 4401 = bad/missing key: retrying won't help. 4429 = connection-limit: back off (handled by delay).
      if (code === 4401) {
        fatal = true;
        onError(new Error("authentication failed (4401) — check POLYNODE_API_KEY"), "polynode auth");
        return;
      }
      onError(new Error(`websocket closed code=${String(code)}`), "polynode websocket close");
      void reconnect("websocket close");
    });

    // App-level ping (proxies strip native frames) + native ping zombie detection.
    const pingInterval = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        socket.send(JSON.stringify({ action: "ping" }));
      } catch {
        // next close/error path recovers
      }
      clearPongTimer();
      awaitingPong = true;
      try {
        socket.ping();
      } catch {
        // ignore
      }
      pongTimer = setTimeout(() => {
        if (awaitingPong) {
          console.warn(`[polynode] heartbeat timeout — no pong in ${HEARTBEAT_TIMEOUT_MS / 1000}s; terminating`);
          try {
            socket.terminate();
          } catch {
            // close handler recovers
          }
        }
      }, HEARTBEAT_TIMEOUT_MS);
      pongTimer.unref();
    }, PING_INTERVAL_MS);
    pingInterval.unref();

    socket.on("pong", () => {
      awaitingPong = false;
      clearPongTimer();
    });
  };

  const connect = () => {
    if (stopped || fatal) {
      return;
    }
    ws = new WebSocket(`${WS_URL}?key=${apiKey}`, {
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
    });
    bind(ws);
  };

  const reconnect = async (reason: string) => {
    if (stopped || reconnecting || fatal) {
      return;
    }
    reconnecting = true;
    clearStability();
    reconnectAttempt += 1;
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(5, reconnectAttempt - 1));
    onError(new Error(`reconnecting websocket (${reason}) in ${delayMs}ms`), "polynode reconnect");
    try {
      ws?.removeAllListeners();
      ws?.terminate();
    } catch (e) {
      onError(e, "polynode terminate");
    }
    await new Promise((r) => setTimeout(r, delayMs));
    reconnecting = false;
    if (!stopped && !fatal) {
      connect();
    }
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      clearStability();
      try {
        ws?.removeAllListeners();
        ws?.terminate();
      } catch {
        // best-effort
      }
    },
    lastMessageAt: () => lastMessage,
  };
}
