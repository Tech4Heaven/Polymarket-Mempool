import "dotenv/config";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { isAbsolute, resolve } from "path";
import { getAddress, isAddress } from "ethers";
import { EXCHANGE_V2_ADDRESSES } from "./contracts.js";
import { parseCopyTargetsTomlFile } from "./copyTargetsToml.js";
import { fetchPolymarketProfileLabel } from "./polymarketProfile.js";

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

export type CopyTradeShared = {
  privateKey: `0x${string}`;
  /** 0 EOA, 1 POLY_PROXY, 2 GNOSIS_SAFE, 3 POLY_1271 */
  signatureType: number;
  funderAddress?: string;
  polygonHttpUrl: string;
  clobHost: string;
  dryRun: boolean;
};

/** Per-target sizing and dedicated copy-trade log path (absolute). */
export type TargetCopyParams = {
  address: string;
  copyRatio: number;
  maxPriceDifference: number;
  /** Buy only: skip if limit price is below this (undefined = no floor). Outcome price in (0,1). */
  buyPriceMin?: number;
  /** Buy only: skip if limit price is above this (undefined = no cap). Outcome price in (0,1). */
  buyPriceMax?: number;
  minPositionUsdc: number;
  maxPositionUsdc: number;
  copyTradeLogPath: string;
};

export type CopyTradeConfig = CopyTradeShared & {
  copyRatio: number;
  maxPriceDifference: number;
  buyPriceMin?: number;
  buyPriceMax?: number;
  minPositionUsdc: number;
  maxPositionUsdc: number;
  /**
   * When set, copy-trade lines go here; otherwise {@link appendCopyTradeSuccessLine} uses env / default file.
   */
  copyTradeLogPath?: string;
};

export type AppConfig = {
  /** WebSocket RPC URL (must support eth_subscribe pending). */
  polygonWssUrl: string;
  /** Trader wallets to watch in the mempool matcher. */
  targetTraderAddresses: string[];
  /** Checksum address → sizing + log file; subset of targets that participate in copy trading. */
  targetCopyProfiles: Map<string, TargetCopyParams>;
  exchangeAddresses: string[];
  maxConcurrentTxLookups: number;
  /** Shared CLOB wallet and endpoints; null disables posting copy orders. */
  copyTradeShared: CopyTradeShared | null;
};

export function mergeCopyTradeConfig(shared: CopyTradeShared, p: TargetCopyParams): CopyTradeConfig {
  return {
    privateKey: shared.privateKey,
    signatureType: shared.signatureType,
    funderAddress: shared.funderAddress,
    polygonHttpUrl: shared.polygonHttpUrl,
    clobHost: shared.clobHost,
    dryRun: shared.dryRun,
    copyRatio: p.copyRatio,
    maxPriceDifference: p.maxPriceDifference,
    buyPriceMin: p.buyPriceMin,
    buyPriceMax: p.buyPriceMax,
    minPositionUsdc: p.minPositionUsdc,
    maxPositionUsdc: p.maxPositionUsdc,
    copyTradeLogPath: p.copyTradeLogPath,
  };
}

function parsePositiveFloatEnv(name: string): number {
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

function copyTradingFlagFromEnv(): boolean {
  const flag = process.env["COPY_TRADING_ENABLED"]?.trim().toLowerCase();
  return flag === "true" || flag === "1";
}

function loadCopyTradeSharedFromEnv(): CopyTradeShared | null {
  if (!copyTradingFlagFromEnv()) {
    return null;
  }

  const pk = normalizeCopyWalletPrivateKey(requireEnv("COPY_WALLET_PRIVATE_KEY"));
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
    privateKey: pk,
    signatureType,
    funderAddress,
    polygonHttpUrl,
    clobHost,
    dryRun,
  };
}

function requireNum(name: string, v: number | undefined, ctx: string): number {
  if (v === undefined || !Number.isFinite(v) || v < 0) {
    throw new Error(`${ctx}: ${name} must be a non-negative number`);
  }
  return v;
}

/** Optional outcome price bound in [0, 1] from TOML row/default. */
function optionalProb01(name: string, v: number | undefined, ctx: string): number | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error(`${ctx}: ${name} must be between 0 and 1`);
  }
  return v;
}

/** Legacy env: omit or empty = no bound. */
function parseOptionalBuyPriceBoundEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${name} must be between 0 and 1 when set`);
  }
  return n;
}

function assertBuyPriceRange(minV: number | undefined, maxV: number | undefined, ctx: string): void {
  if (minV !== undefined && maxV !== undefined && minV > maxV) {
    throw new Error(`${ctx}: buy_price_min must be <= buy_price_max`);
  }
}

function sanitizeLogLabel(raw: string): string {
  const s = raw
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return s.slice(0, 80) || "unknown";
}

async function resolveLogBasename(
  address: string,
  usernameOverride: string | undefined
): Promise<string> {
  const addrLc = address.toLowerCase();
  let label: string;
  if (usernameOverride?.trim()) {
    label = sanitizeLogLabel(usernameOverride);
  } else {
    const fromApi = await fetchPolymarketProfileLabel(address);
    label = sanitizeLogLabel(fromApi ?? "unknown");
  }
  return `${label}_${addrLc}.log`;
}

function loadRpcOnly(): Pick<
  AppConfig,
  "polygonWssUrl" | "exchangeAddresses" | "maxConcurrentTxLookups"
> {
  const polygonWssUrl = requireEnv("POLYGON_WSS_URL");
  const rawExchanges = process.env["EXCHANGE_ADDRESSES"]?.trim();
  const exchangeAddresses = rawExchanges
    ? parseAddressList(rawExchanges)
    : [...EXCHANGE_V2_ADDRESSES];

  const maxRaw = process.env["MAX_CONCURRENT_TX_LOOKUPS"]?.trim();
  const maxConcurrentTxLookups = maxRaw ? Math.max(1, parseInt(maxRaw, 10) || 5) : 5;

  return { polygonWssUrl, exchangeAddresses, maxConcurrentTxLookups };
}

/**
 * Loads app config: optional `copy-targets.toml` (see `COPY_TARGETS_TOML`) for target list and per-target sizing.
 * Shared CLOB settings are always loaded from `.env` (`COPY_*`, signature/funder, host URLs).
 * Without TOML, legacy `.env` (`TARGET_TRADER_ADDRESSES` + global sizing) still works.
 */
export async function loadAppConfig(): Promise<AppConfig> {
  const rpc = loadRpcOnly();
  const cwd = process.cwd();
  const tomlRel = process.env["COPY_TARGETS_TOML"]?.trim() || "copy-targets.toml";
  const tomlAbs = resolve(cwd, tomlRel);

  if (existsSync(tomlAbs)) {
    const parsed = await parseCopyTargetsTomlFile(tomlAbs);
    const defaults = parsed.defaults ?? {};
    const shared = loadCopyTradeSharedFromEnv();

    const targetTraderAddresses = parsed.targets.map((t) => t.address);
    const targetCopyProfiles = new Map<string, TargetCopyParams>();

    if (shared) {
      const logsDir = resolve(cwd, "logs");
      await mkdir(logsDir, { recursive: true });

      for (const row of parsed.targets) {
        const copyRatio = requireNum("copy_ratio", row.copy_ratio ?? defaults.copy_ratio, `targets ${row.address}`);
        const maxPriceDifference = requireNum(
          "max_price_difference",
          row.max_price_difference ?? defaults.max_price_difference,
          `targets ${row.address}`
        );
        const minPositionUsdc = requireNum(
          "min_position_usdc",
          row.min_position_usdc ?? defaults.min_position_usdc,
          `targets ${row.address}`
        );
        const maxPositionUsdc = requireNum(
          "max_position_usdc",
          row.max_position_usdc ?? defaults.max_position_usdc,
          `targets ${row.address}`
        );
        if (minPositionUsdc > maxPositionUsdc) {
          throw new Error(
            `targets ${row.address}: min_position_usdc must be <= max_position_usdc (${tomlRel})`
          );
        }

        const buyPriceMin = optionalProb01(
          "buy_price_min",
          row.buy_price_min ?? defaults.buy_price_min,
          `targets ${row.address}`
        );
        const buyPriceMax = optionalProb01(
          "buy_price_max",
          row.buy_price_max ?? defaults.buy_price_max,
          `targets ${row.address}`
        );
        assertBuyPriceRange(buyPriceMin, buyPriceMax, `targets ${row.address} (${tomlRel})`);

        const base = await resolveLogBasename(row.address, row.username);
        const copyTradeLogPath = resolve(logsDir, base);

        targetCopyProfiles.set(row.address, {
          address: row.address,
          copyRatio,
          maxPriceDifference,
          buyPriceMin,
          buyPriceMax,
          minPositionUsdc,
          maxPositionUsdc,
          copyTradeLogPath,
        });
      }
    }

    return {
      ...rpc,
      targetTraderAddresses,
      targetCopyProfiles,
      copyTradeShared: shared,
    };
  }

  /** Legacy: env-only target list */
  const targetTraderAddresses = parseAddressList(requireEnv("TARGET_TRADER_ADDRESSES"));
  const shared = loadCopyTradeSharedFromEnv();
  const targetCopyProfiles = new Map<string, TargetCopyParams>();

  if (shared) {
    const copyRatio = parsePositiveFloatEnv("COPY_RATIO");
    const maxPriceDifference = parsePositiveFloatEnv("MAX_PRICE_DIFFERENCE");
    const minPositionUsdc = parsePositiveFloatEnv("MIN_POSITION_USDC");
    const maxPositionUsdc = parsePositiveFloatEnv("MAX_POSITION_USDC");
    if (minPositionUsdc > maxPositionUsdc) {
      throw new Error("MIN_POSITION_USDC must be <= MAX_POSITION_USDC");
    }
    const buyPriceMin = parseOptionalBuyPriceBoundEnv("COPY_BUY_PRICE_MIN");
    const buyPriceMax = parseOptionalBuyPriceBoundEnv("COPY_BUY_PRICE_MAX");
    assertBuyPriceRange(buyPriceMin, buyPriceMax, "COPY_BUY_PRICE_MIN / COPY_BUY_PRICE_MAX");

    if (targetTraderAddresses.length === 1) {
      const addr = targetTraderAddresses[0]!;
      const envLog = process.env["COPY_TRADE_LOG_PATH"]?.trim();
      const copyTradeLogPath = envLog
        ? isAbsolute(envLog)
          ? envLog
          : resolve(cwd, envLog)
        : resolve(cwd, "copy-trades.log");
      targetCopyProfiles.set(addr, {
        address: addr,
        copyRatio,
        maxPriceDifference,
        buyPriceMin,
        buyPriceMax,
        minPositionUsdc,
        maxPositionUsdc,
        copyTradeLogPath,
      });
    } else {
      const logsDir = resolve(cwd, "logs");
      await mkdir(logsDir, { recursive: true });
      for (const addr of targetTraderAddresses) {
        const base = await resolveLogBasename(addr, undefined);
        targetCopyProfiles.set(addr, {
          address: addr,
          copyRatio,
          maxPriceDifference,
          buyPriceMin,
          buyPriceMax,
          minPositionUsdc,
          maxPositionUsdc,
          copyTradeLogPath: resolve(logsDir, base),
        });
      }
    }
  }

  return {
    ...rpc,
    targetTraderAddresses,
    targetCopyProfiles,
    copyTradeShared: shared,
  };
}
