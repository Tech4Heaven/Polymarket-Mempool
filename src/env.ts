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

export type CopyTradeConfig = {
  copyRatio: number;
  /**
   * Buy: skip only if `clob − implied > this` (paying worse than target’s entry + margin).
   * Sell: skip only if `implied − clob > this` (selling worse than target’s exit + margin).
   * Cheaper buys / better sells vs implied are always allowed.
   */
  maxPriceDifference: number;
  minPositionUsdc: number;
  maxPositionUsdc: number;
  privateKey: `0x${string}`;
  /** 0 EOA, 1 POLY_PROXY, 2 GNOSIS_SAFE, 3 POLY_1271 */
  signatureType: number;
  funderAddress?: string;
  polygonHttpUrl: string;
  clobHost: string;
  /** When true, runs CLOB checks and sizing but does not submit `createAndPostOrder`. */
  dryRun: boolean;
};

export type AppConfig = {
  /** WebSocket RPC URL (must support eth_subscribe pending). */
  polygonWssUrl: string;
  /** One or more trader wallets/proxies to flag when they appear in orders. */
  targetTraderAddresses: string[];
  /** Optional subset of exchange contracts; defaults to both V2 exchanges. */
  exchangeAddresses: string[];
  /** Max concurrent eth_getTransactionByHash calls while draining pending. */
  maxConcurrentTxLookups: number;
  /** When set, posts copy trades after mined fills pass slip + size checks. */
  copyTrade: CopyTradeConfig | null;
};

function parsePositiveFloat(name: string): number {
  const v = requireEnv(name);
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return n;
}

/** MetaMask exports 64 hex chars without `0x`; viem expects `0x` + 32 bytes. */
function normalizeCopyWalletPrivateKey(raw: string): `0x${string}` {
  let s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  const lower = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2).toLowerCase() : s.toLowerCase();
  const pk = `0x${lower}`;
  if (!/^0x[0-9a-f]{64}$/.test(pk)) {
    throw new Error(
      "COPY_WALLET_PRIVATE_KEY must be 64 hex characters (32 bytes), with or without 0x — same as MetaMask private key export"
    );
  }
  return pk as `0x${string}`;
}

function loadCopyTradeConfig(): CopyTradeConfig | null {
  const flag = process.env["COPY_TRADING_ENABLED"]?.trim().toLowerCase();
  if (!flag || flag === "0" || flag === "false") {
    return null;
  }

  const pk = normalizeCopyWalletPrivateKey(requireEnv("COPY_WALLET_PRIVATE_KEY"));

  const copyRatio = parsePositiveFloat("COPY_RATIO");
  const maxPriceDifference = parsePositiveFloat("MAX_PRICE_DIFFERENCE");
  const minPositionUsdc = parsePositiveFloat("MIN_POSITION_USDC");
  const maxPositionUsdc = parsePositiveFloat("MAX_POSITION_USDC");
  if (minPositionUsdc > maxPositionUsdc) {
    throw new Error("MIN_POSITION_USDC must be <= MAX_POSITION_USDC");
  }

  const signatureType = parseInt(requireEnv("CLOB_SIGNATURE_TYPE"), 10);
  if (!Number.isFinite(signatureType) || signatureType < 0 || signatureType > 3) {
    throw new Error("CLOB_SIGNATURE_TYPE must be 0–3 (EOA, POLY_PROXY, GNOSIS_SAFE, POLY_1271)");
  }

  const funderRaw = process.env["FUNDER_ADDRESS"]?.trim();
  let funderAddress: string | undefined;
  if (funderRaw) {
    if (!isAddress(funderRaw)) {
      throw new Error("FUNDER_ADDRESS must be a valid address");
    }
    funderAddress = getAddress(funderRaw);
  } else if (signatureType === 1 || signatureType === 2) {
    throw new Error(
      "FUNDER_ADDRESS is required when CLOB_SIGNATURE_TYPE is 1 (POLY_PROXY) or 2 (GNOSIS_SAFE)"
    );
  }

  const polygonHttpUrl =
    process.env["POLYGON_HTTP_URL"]?.trim() || "https://polygon-bor.publicnode.com";
  const clobHost = process.env["CLOB_HOST"]?.trim() || "https://clob.polymarket.com";

  const dryRaw = process.env["COPY_TRADING_DRY_RUN"]?.trim().toLowerCase();
  const dryRun = dryRaw === "true" || dryRaw === "1";

  return {
    copyRatio,
    maxPriceDifference,
    minPositionUsdc,
    maxPositionUsdc,
    privateKey: pk,
    signatureType,
    funderAddress,
    polygonHttpUrl,
    clobHost,
    dryRun,
  };
}

export function loadConfig(): AppConfig {
  const polygonWssUrl = requireEnv("POLYGON_WSS_URL");
  const targetTraderAddresses = parseAddressList(requireEnv("TARGET_TRADER_ADDRESSES"));

  const rawExchanges = process.env["EXCHANGE_ADDRESSES"]?.trim();
  const exchangeAddresses = rawExchanges
    ? parseAddressList(rawExchanges)
    : [...EXCHANGE_V2_ADDRESSES];

  const maxRaw = process.env["MAX_CONCURRENT_TX_LOOKUPS"]?.trim();
  const maxConcurrentTxLookups = maxRaw ? Math.max(1, parseInt(maxRaw, 10) || 5) : 5;

  const copyTrade = loadCopyTradeConfig();

  return {
    polygonWssUrl,
    targetTraderAddresses,
    exchangeAddresses,
    maxConcurrentTxLookups,
    copyTrade,
  };
}
