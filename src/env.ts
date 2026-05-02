import "dotenv/config";
import { getAddress, isAddress } from "ethers";
import { EXCHANGE_V2_ADDRESSES } from "./contracts.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

function parseAddressList(raw: string): string[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (!isAddress(p)) {
      throw new Error(`Invalid address in TARGET_TRADER_ADDRESSES: ${p}`);
    }
    out.push(getAddress(p));
  }
  return out;
}

export type AppConfig = {
  /** WebSocket RPC URL (must support eth_subscribe pending). */
  polygonWssUrl: string;
  /** One or more trader wallets/proxies to flag when they appear in orders. */
  targetTraderAddresses: string[];
  /** Optional subset of exchange contracts; defaults to both V2 exchanges. */
  exchangeAddresses: string[];
  /** Max concurrent eth_getTransactionByHash calls while draining pending. */
  maxConcurrentTxLookups: number;
};

export function loadConfig(): AppConfig {
  const polygonWssUrl = requireEnv("POLYGON_WSS_URL");
  const targetTraderAddresses = parseAddressList(requireEnv("TARGET_TRADER_ADDRESSES"));

  const rawExchanges = process.env["EXCHANGE_ADDRESSES"]?.trim();
  const exchangeAddresses = rawExchanges
    ? parseAddressList(rawExchanges)
    : [...EXCHANGE_V2_ADDRESSES];

  const maxRaw = process.env["MAX_CONCURRENT_TX_LOOKUPS"]?.trim();
  const maxConcurrentTxLookups = maxRaw ? Math.max(1, parseInt(maxRaw, 10) || 5) : 5;

  return {
    polygonWssUrl,
    targetTraderAddresses,
    exchangeAddresses,
    maxConcurrentTxLookups,
  };
}
