/**
 * pendingProbe — measures whether monitoring PENDING txns would beat the current MINED-log
 * detection, and by how much, for the configured target wallets.
 *
 * It does NOT decode calldata. For coverage+lead it only needs the *arrival time* of each
 * pending txHash, matched by hash against target trades detected the current way (OrderFilled
 * logs, server-filtered by target topic). Cheap and provider-agnostic.
 *
 *   Baseline (always): OrderFilled logs on Chainstack WSS (POLYGON_WSS_URL) — the current method.
 *   Pending feed (choose): "alchemy"  -> alchemy_pendingTransactions {toAddress:exchanges} (full body, filtered)
 *                          "chainstack"-> newPendingTransactions (standard hashes, unfiltered)
 *
 * Usage:  npx tsx scripts/pendingProbe.ts <alchemy|chainstack> [runSeconds=600]
 * Compare the two runs' coverage% and lead-ms.
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { id, zeroPadValue } from "ethers";
import { EXCHANGE_V2_ADDRESSES } from "../src/contracts.js";

const WS: new (url: string) => any = (globalThis as { WebSocket?: unknown }).WebSocket as never;
if (!WS) {
  console.error("global WebSocket not available — need Node >=22");
  process.exit(1);
}

const which = (process.argv[2] ?? "alchemy").toLowerCase();
const RUN_MS = Number(process.argv[3] ?? 600) * 1000;

// Results are written here so they can be read back without copy-paste. Truncated per run.
const LOG_PATH = `logs/pendingProbe.${which}.log`;
mkdirSync("logs", { recursive: true });
writeFileSync(LOG_PATH, `pendingProbe run · pending=${which} · started(epochMs)=${Date.now()}\n`);
function out(s: string) {
  console.log(s);
  appendFileSync(LOG_PATH, s + "\n");
}

// --- env (.env, values kept in-process only) ---
const env: Record<string, string> = {};
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0 && !line.trimStart().startsWith("#")) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const CHAINSTACK_WSS = env["POLYGON_WSS_URL"];
const ALCHEMY_WSS = (env["POLYGON_ALCHEMY_URL"] ?? "").replace(/^https:/i, "wss:");
if (!CHAINSTACK_WSS) throw new Error("POLYGON_WSS_URL missing");
if (which === "alchemy" && !ALCHEMY_WSS) throw new Error("POLYGON_ALCHEMY_URL missing");

// --- targets (from copy-targets.toml) + exchanges ---
const toml = readFileSync("copy-targets.toml", "utf8");
const targets = [...toml.matchAll(/address\s*=\s*"(0x[0-9a-fA-F]{40})"/g)].map((m) => m[1]!.toLowerCase());
const paddedTargets = targets.map((a) => zeroPadValue(a, 32));
const exchanges = EXCHANGE_V2_ADDRESSES.map((a) => a.toLowerCase());
const ORDER_FILLED = id("OrderFilled(bytes32,address,address,uint8,uint256,uint256,uint256,uint256,bytes32,bytes32)");

// --- state ---
const TTL = 180_000;
const pendingSeen = new Map<string, number>(); // txHash -> first pending-arrival ms
const minedSeen = new Map<string, number>(); // target-trade txHash -> mined-log-arrival ms
const matched = new Set<string>();
let minedCount = 0;
let pendingRaw = 0; // total pending notifications received (feed liveness)
const leads: number[] = []; // ms; positive = pending arrived earlier than the mined log
setInterval(() => {
  const now = Date.now();
  for (const [h, t] of pendingSeen) if (now - t > TTL) pendingSeen.delete(h);
  for (const [h, t] of minedSeen) if (now - t > TTL) minedSeen.delete(h);
}, 30_000).unref();

function record(h: string, leadMs: number) {
  if (matched.has(h)) return;
  matched.add(h);
  leads.push(leadMs);
  const tag = leadMs >= 0 ? `COVERED lead=+${leadMs}ms` : `LATE    lead=${leadMs}ms`;
  out(`  [${tag}] tx=${h}`);
}

function onPending(hash: string) {
  pendingRaw++;
  const h = hash.toLowerCase();
  if (!pendingSeen.has(h)) pendingSeen.set(h, Date.now());
  const m = minedSeen.get(h);
  if (m !== undefined) record(h, m - Date.now()); // pending arrived after mining -> negative
}
function onMinedTargetTrade(hash: string) {
  const h = hash.toLowerCase();
  if (minedSeen.has(h)) return; // dedupe (multiple OrderFilled / maker+taker per tx)
  minedSeen.set(h, Date.now());
  minedCount++;
  const p = pendingSeen.get(h);
  if (p !== undefined) record(h, Date.now() - p);
  else out(`  [MINED, no pending yet] tx=${h}`);
}

// --- raw JSON-RPC WSS subscription helper ---
function connect(url: string, subs: { params: unknown[]; onData: (r: any) => void }[], label: string) {
  let idc = 1;
  const reqToSub = new Map<number, (r: any) => void>();
  const subToHandler = new Map<string, (r: any) => void>();
  const ws = new WS(url);
  ws.onopen = () => {
    for (const s of subs) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: idc, method: "eth_subscribe", params: s.params }));
      reqToSub.set(idc, s.onData);
      idc++;
    }
    console.error(`[${label}] connected, ${subs.length} subscription(s) sent`);
  };
  ws.onmessage = (ev: { data: string }) => {
    let msg: any;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id !== undefined && reqToSub.has(msg.id)) {
      if (typeof msg.result === "string") subToHandler.set(msg.result, reqToSub.get(msg.id)!);
      else console.error(`[${label}] subscribe error:`, JSON.stringify(msg.error ?? msg.result));
      return;
    }
    if (msg.method === "eth_subscription") {
      const h = subToHandler.get(msg.params?.subscription);
      if (h) h(msg.params.result);
    }
  };
  ws.onerror = (e: any) => console.error(`[${label}] ws error:`, e?.message ?? String(e));
  ws.onclose = () => console.error(`[${label}] ws closed`);
  return ws;
}

// --- baseline: OrderFilled logs (target-filtered) on Chainstack ---
connect(
  CHAINSTACK_WSS,
  [
    { params: ["logs", { address: exchanges, topics: [ORDER_FILLED, null, paddedTargets] }], onData: (l) => onMinedTargetTrade(l.transactionHash) },
    { params: ["logs", { address: exchanges, topics: [ORDER_FILLED, null, null, paddedTargets] }], onData: (l) => onMinedTargetTrade(l.transactionHash) },
  ],
  "mined/chainstack"
);

// --- pending feed under test ---
if (which === "alchemy") {
  connect(
    ALCHEMY_WSS,
    [{ params: ["alchemy_pendingTransactions", { toAddress: exchanges, hashesOnly: false }], onData: (tx) => onPending(tx.hash) }],
    "pending/alchemy"
  );
} else {
  connect(CHAINSTACK_WSS, [{ params: ["newPendingTransactions"], onData: (hash) => onPending(String(hash)) }], "pending/chainstack");
}

function pct(a: number, b: number) {
  return b ? ((100 * a) / b).toFixed(1) : "0.0";
}
function summary(final = false) {
  const s = [...leads].sort((a, b) => a - b);
  const med = s.length ? s[Math.floor(s.length / 2)] : 0;
  const covered = leads.filter((l) => l > 0).length;
  out(
    `${final ? "=== FINAL " : "--- "}[${which}] pending_feed=${pendingRaw} (live=${pendingSeen.size}) ` +
      `mined_target_trades=${minedCount} seen_pending=${matched.size} ` +
      `coverage=${pct(matched.size, minedCount)}% positive_lead=${covered} ` +
      `lead(ms) min=${s[0] ?? "-"} median=${med ?? "-"} max=${s[s.length - 1] ?? "-"} ${final ? "===" : "---"}`
  );
}

console.error(`probe: pending=${which}  targets=${targets.length}  exchanges=${exchanges.length}  run=${RUN_MS / 1000}s`);
const iv = setInterval(() => summary(false), 60_000);
setTimeout(() => {
  clearInterval(iv);
  summary(true);
  process.exit(0);
}, RUN_MS);
