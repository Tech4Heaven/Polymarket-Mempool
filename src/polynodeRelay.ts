import "dotenv/config";
import WebSocket, { WebSocketServer } from "ws";

/**
 * PolyNode fan-out relay.
 *
 * Opens ONE upstream connection to the PolyNode pending-settlement firehose and re-broadcasts every
 * `settlement` frame, VERBATIM, to any number of LOCAL bot processes over a plain WebSocket server.
 *
 * Why: each bot's polynodeWatcher subscribes to the FULL firehose (no wallet filter, for privacy) and
 * matches targets locally. Running N bots means PolyNode pushes the entire Polymarket settlement stream
 * N times over — N× the billed message volume and N connections against the per-key limit. This relay
 * collapses that to 1 upstream connection; the N local bot↔relay hops run on localhost and cost nothing.
 *
 * Design:
 *  - Dumb broadcast: the relay does NOT parse or filter settlements — it forwards the raw text frame to
 *    every client. Each bot keeps its existing local target-matching. Simplest and lowest-latency (a
 *    localhost forward is sub-ms; the upstream network hop — the only internet-exposed latency — is
 *    unchanged from connecting to PolyNode directly).
 *  - Privacy preserved: no `wallets` filter is ever sent upstream (identical subscribe to the watcher's).
 *  - Same firehose discipline as polynodeWatcher: status:pending, event_types:[settlement], no snapshot
 *    replay (snapshot_count:0) — acting on replayed/old trades is fatal on 5-minute markets.
 *  - Upstream reconnect with backoff + app-level ping (proxies strip native frames) + native-ping zombie
 *    detection, mirroring polynodeWatcher so the shared connection is as resilient as a per-bot one.
 *  - Local clients: the relay accepts (and ignores) their subscribe/ping frames so an unmodified watcher
 *    protocol just works, and answers app-level pings with a pong so the bot heartbeat stays green.
 *
 * Run: `npm run relay` (tsx src/polynodeRelay.ts). Env:
 *   POLYNODE_API_KEY   required — the single key the whole fleet now shares.
 *   POLYNODE_RELAY_PORT listen port (default 8787).
 *   POLYNODE_RELAY_HOST bind address (default 127.0.0.1 — localhost only; do NOT expose the firehose).
 */

const UPSTREAM_URL = "wss://ws.polynode.dev/ws";
const PING_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const STABILITY_MS = 30_000;

const apiKey = process.env["POLYNODE_API_KEY"]?.trim();
if (!apiKey) {
  console.error("[relay] POLYNODE_API_KEY missing — the relay holds the single shared key. Set it and restart.");
  process.exit(1);
}

const port = Number.parseInt(process.env["POLYNODE_RELAY_PORT"]?.trim() || "8787", 10) || 8787;
const host = process.env["POLYNODE_RELAY_HOST"]?.trim() || "127.0.0.1";

// ---- Local fan-out server -------------------------------------------------------------------------

const clients = new Set<WebSocket>();
const wss = new WebSocketServer({ port, host });

wss.on("listening", () => {
  console.log(`[relay] fan-out server listening on ws://${host}:${port} · point bots at POLYNODE_RELAY_URL=ws://${host}:${port}`);
});

wss.on("error", (err) => {
  // Port already bound = another relay is already running on this host. Exit LOUDLY rather than sit
  // "online" but not listening (a silent duplicate that serves no clients). One relay per host: run it
  // in the key-holding folder only; a new bot's ecosystem must NOT include the relay app.
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EADDRINUSE") {
    console.error(
      `[relay] port ${port} already in use — another relay is running on this host. ` +
        `Only ONE relay is needed for the whole fleet. Not starting a second. Exiting.`
    );
    process.exit(1);
  }
  console.error(`[relay] fan-out server error: ${err instanceof Error ? err.message : String(err)}`);
});

wss.on("connection", (client, req) => {
  clients.add(client);
  const who = req.socket.remoteAddress ?? "?";
  console.log(`[relay] client connected (${who}) · ${clients.size} client(s)`);

  client.on("message", (raw) => {
    // Bots may send an app-level {"action":"subscribe"} / {"action":"ping"} exactly as they would to
    // PolyNode. We ignore subscribe (the relay already streams the firehose) and answer ping so the
    // bot's heartbeat sees a reply.
    let text = "";
    try {
      text = raw.toString();
    } catch {
      return;
    }
    if (text.includes("\"action\":\"ping\"") || text.includes("'action':'ping'")) {
      try {
        client.send(JSON.stringify({ type: "pong" }));
      } catch {
        // client will be reaped by heartbeat / close
      }
    }
  });

  client.on("ping", () => {
    try {
      client.pong();
    } catch {
      // ignore
    }
  });

  client.on("close", () => {
    clients.delete(client);
    console.log(`[relay] client disconnected · ${clients.size} client(s)`);
  });

  client.on("error", () => {
    clients.delete(client);
    try {
      client.terminate();
    } catch {
      // ignore
    }
  });
});

// Reap dead local clients (a bot that vanished without a close frame) so we never write to zombies.
const clientHeartbeat = setInterval(() => {
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) {
      clients.delete(client);
      continue;
    }
    try {
      client.ping();
    } catch {
      clients.delete(client);
    }
  }
}, PING_INTERVAL_MS);
clientHeartbeat.unref();

function broadcast(frame: string): void {
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) {
      continue;
    }
    try {
      client.send(frame);
    } catch {
      // drop; heartbeat/close reaps it
    }
  }
}

// ---- Upstream PolyNode connection (single) --------------------------------------------------------

let ws: WebSocket | null = null;
let stopped = false;
let reconnecting = false;
let reconnectAttempt = 0;
let fatal = false;
let lastUpstreamMsg = 0;

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

const bindUpstream = (socket: WebSocket) => {
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
    // Identical subscribe to polynodeWatcher — full pending firehose, NO wallet filter (privacy), no
    // snapshot replay. The relay never filters; bots match their own targets locally.
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
      console.log(`[relay] upstream reconnected · resubscribed after ${attemptAtBind} attempt(s)`);
    } else {
      console.log(`[relay] upstream connected · pending-settlement firehose`);
    }
  });

  // Forward every settlement frame verbatim. We do a cheap string check to skip control frames
  // (subscribe acks, pongs) so clients only ever receive settlement messages — same shape they'd get
  // straight from PolyNode. No JSON parse on the hot path.
  socket.on("message", (raw) => {
    lastUpstreamMsg = Date.now();
    let text = "";
    try {
      text = raw.toString();
    } catch {
      return;
    }
    if (text.includes("\"type\":\"settlement\"")) {
      broadcast(text);
    }
  });

  socket.on("error", (err) => {
    console.error(`[relay] upstream error: ${err instanceof Error ? err.message : String(err)}`);
    void reconnect("websocket error");
  });

  socket.on("close", (code: number) => {
    clearInterval(pingInterval);
    clearPongTimer();
    if (code === 4401) {
      fatal = true;
      console.error("[relay] upstream auth failed (4401) — check POLYNODE_API_KEY. Not retrying.");
      return;
    }
    console.warn(`[relay] upstream closed code=${String(code)}`);
    void reconnect("websocket close");
  });

  const pingInterval = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify({ action: "ping" }));
    } catch {
      // recovered by close/error path
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
        console.warn(`[relay] upstream heartbeat timeout — no pong in ${HEARTBEAT_TIMEOUT_MS / 1000}s; terminating`);
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
  ws = new WebSocket(`${UPSTREAM_URL}?key=${apiKey}`, {
    perMessageDeflate: false,
    handshakeTimeout: 10_000,
  });
  bindUpstream(ws);
};

const reconnect = async (reason: string) => {
  if (stopped || reconnecting || fatal) {
    return;
  }
  reconnecting = true;
  clearStability();
  reconnectAttempt += 1;
  const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(5, reconnectAttempt - 1));
  console.warn(`[relay] reconnecting upstream (${reason}) in ${delayMs}ms`);
  try {
    ws?.removeAllListeners();
    ws?.terminate();
  } catch {
    // best-effort
  }
  await new Promise((r) => setTimeout(r, delayMs));
  reconnecting = false;
  if (!stopped && !fatal) {
    connect();
  }
};

// Visibility: warn if the upstream goes quiet (mirrors the bot's own quiet-feed alarm). No settlements
// at all for a long stretch usually means the connection is a zombie the heartbeat hasn't reaped yet.
const quietWatch = setInterval(() => {
  if (lastUpstreamMsg === 0) {
    return;
  }
  const quiet = Date.now() - lastUpstreamMsg;
  if (quiet > 60_000) {
    console.warn(`[relay] no upstream messages for ${Math.round(quiet / 1000)}s — feed may be down`);
  }
}, 30_000);
quietWatch.unref();

const shutdown = () => {
  stopped = true;
  clearStability();
  clearInterval(clientHeartbeat);
  clearInterval(quietWatch);
  try {
    ws?.removeAllListeners();
    ws?.terminate();
  } catch {
    // ignore
  }
  for (const client of clients) {
    try {
      client.close();
    } catch {
      // ignore
    }
  }
  try {
    wss.close();
  } catch {
    // ignore
  }
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

connect();
