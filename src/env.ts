import "dotenv/config";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { isAbsolute, resolve } from "path";
import { getAddress, isAddress } from "ethers";
import { EXCHANGE_V2_ADDRESSES } from "./contracts.js";
import { resolveCopyWalletPrivateKeyRaw, requirePrivateKeyHex } from "./copyWalletKeyJson.js";
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
};

/** Per-target sizing and dedicated copy-trade log path (absolute). */
export type TargetCopyParams = {
  address: string;
  copyRatio: number;
  maxPriceDifference: number;
  /** Buy only: skip if (implied - effectivePrice) > this. Undefined = no underbid skip. */
  maxUnderbidDifference?: number;
  /** Buy only: skip if limit price is below this (undefined = no floor). Outcome price in (0,1). */
  buyPriceMin?: number;
  /** Buy only: skip if limit price is above this (undefined = no cap). Outcome price in (0,1). */
  buyPriceMax?: number;
  minPositionUsdc: number;
  maxPositionUsdc: number;
  /** When true, copy decisions are logged but no order is posted to CLOB. Per-target. */
  dryRun: boolean;
  /**
   * Pre-hedge price in (0,1). When set, after each copy BUY we place a GTC limit BUY for the
   * opposite outcome at this price (size = our total holdings of the primary side in that
   * condition). Per-target. Omit = no hedging.
   */
  hedgePrice?: number;
  /**
   * Per-side max USDC cap. The most USDC we'll commit to this target's copies on a single
   * outcome token. Applied independently per outcome. Buys are clipped to fit; full sells
   * reset the side's bucket. Omit = no cap.
   */
  maxMarketUsdc?: number;
  /** If true, accumulate below-min buys per (target, tokenId) and post a combined order when their sum crosses min. */
  accumulateBelowMin?: boolean;
  copyTradeLogPath: string;
};

export type CopyTradeConfig = CopyTradeShared & {
  copyRatio: number;
  maxPriceDifference: number;
  maxUnderbidDifference?: number;
  buyPriceMin?: number;
  buyPriceMax?: number;
  minPositionUsdc: number;
  maxPositionUsdc: number;
  /** Per-target dry-run flag (merged from TargetCopyParams). */
  dryRun: boolean;
  /** Per-target hedge price (merged from TargetCopyParams). Omit = no hedging. */
  hedgePrice?: number;
  /** Per-target per-side max USDC cap. Omit = no cap. */
  maxMarketUsdc?: number;
  /** Per-target below-min accumulator toggle. */
  accumulateBelowMin?: boolean;
  /**
   * Target wallet address (checksum). Needed so per-target trackers (max_market_usdc, etc.)
   * can attribute spend to the right target across the shared copy wallet.
   */
  targetAddress: string;
  /**
   * When set, copy-trade lines go here; otherwise {@link appendCopyTradeSuccessLine} uses env / default file.
   */
  copyTradeLogPath?: string;
};

export type AppConfig = {
  /** WebSocket RPC URL — must be Alchemy (uses `alchemy_pendingTransactions` filtered subscription). */
  polygonWssUrl: string;
  /** HTTP RPC URL used for receipt fetching (typically a cheaper provider like Chainstack). */
  polygonMempoolHttpUrl: string;
  /** Trader wallets to watch in the mempool matcher. */
  targetTraderAddresses: string[];
  /** Subset of targets the withdrawal watcher polls (per-target `watch_withdrawals`, default false). */
  withdrawalWatchAddresses: string[];
  /** Checksum address → sizing + log file; subset of targets that participate in copy trading. */
  targetCopyProfiles: Map<string, TargetCopyParams>;
  exchangeAddresses: string[];
  maxConcurrentTxLookups: number;
  /** Withdrawal watcher poll interval (minutes). */
  withdrawalPollMinutes: number;
  /** Withdrawal watcher alert threshold (USDC) — net cash outflow above this triggers an alert. */
  withdrawalAlertUsd: number;
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
    copyRatio: p.copyRatio,
    maxPriceDifference: p.maxPriceDifference,
    maxUnderbidDifference: p.maxUnderbidDifference,
    buyPriceMin: p.buyPriceMin,
    buyPriceMax: p.buyPriceMax,
    minPositionUsdc: p.minPositionUsdc,
    maxPositionUsdc: p.maxPositionUsdc,
    dryRun: p.dryRun,
    hedgePrice: p.hedgePrice,
    maxMarketUsdc: p.maxMarketUsdc,
    accumulateBelowMin: p.accumulateBelowMin,
    targetAddress: p.address,
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

function copyTradingFlagFromEnv(): boolean {
  const flag = process.env["COPY_TRADING_ENABLED"]?.trim().toLowerCase();
  return flag === "true" || flag === "1";
}

/**
 * Loads copy-wallet private key and shared CLOB settings from `.env` (same fields as copy trading).
 * Does **not** require `COPY_TRADING_ENABLED` — intended for standalone scripts (e.g. CLOB smoke tests).
 */
export async function loadCopyTradeSharedCredentials(): Promise<CopyTradeShared> {
  const { raw: rawPk, sourceLabel } = await resolveCopyWalletPrivateKeyRaw(process.cwd());
  const pk = requirePrivateKeyHex(rawPk, sourceLabel);
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

  return {
    privateKey: pk,
    signatureType,
    funderAddress,
    polygonHttpUrl,
    clobHost,
  };
}

async function loadCopyTradeSharedFromEnv(): Promise<CopyTradeShared | null> {
  if (!copyTradingFlagFromEnv()) {
    return null;
  }
  return loadCopyTradeSharedCredentials();
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
  | "polygonWssUrl"
  | "polygonMempoolHttpUrl"
  | "exchangeAddresses"
  | "maxConcurrentTxLookups"
  | "withdrawalPollMinutes"
  | "withdrawalAlertUsd"
> {
  const polygonWssUrl = requireEnv("POLYGON_WSS_URL");
  const polygonMempoolHttpUrl =
    process.env["POLYGON_MEMPOOL_HTTP_URL"]?.trim() ||
    process.env["POLYGON_HTTP_URL"]?.trim() ||
    "https://polygon-bor.publicnode.com";

  const rawExchanges = process.env["EXCHANGE_ADDRESSES"]?.trim();
  const exchangeAddresses = rawExchanges
    ? parseAddressList(rawExchanges)
    : [...EXCHANGE_V2_ADDRESSES];

  const maxRaw = process.env["MAX_CONCURRENT_TX_LOOKUPS"]?.trim();
  const maxConcurrentTxLookups = maxRaw ? Math.max(1, parseInt(maxRaw, 10) || 5) : 5;

  const pollRaw = process.env["WITHDRAWAL_POLL_MINUTES"]?.trim();
  const withdrawalPollMinutes = pollRaw ? Math.max(1, parseFloat(pollRaw) || 3) : 3;
  const alertRaw = process.env["WITHDRAWAL_ALERT_USD"]?.trim();
  const withdrawalAlertUsd = alertRaw ? Math.max(0, parseFloat(alertRaw) || 50) : 50;

  return {
    polygonWssUrl,
    polygonMempoolHttpUrl,
    exchangeAddresses,
    maxConcurrentTxLookups,
    withdrawalPollMinutes,
    withdrawalAlertUsd,
  };
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
    const shared = await loadCopyTradeSharedFromEnv();

    // Master gate: rows where `enabled = false` are dropped from EVERY downstream list — no copy,
    // no mempool match, no withdrawal poll. Default true (preserves backward compat).
    const activeTargets = parsed.targets.filter(
      (t) => (t.enabled ?? defaults.enabled ?? true) === true
    );
    if (activeTargets.length < parsed.targets.length) {
      const disabled = parsed.targets.length - activeTargets.length;
      console.info(`copy-targets.toml: ${disabled} target(s) disabled via enabled=false — bot will ignore them entirely.`);
    }

    const targetTraderAddresses = activeTargets.map((t) => t.address);
    // Withdrawal watch is independent of copy trading — built from the TOML flag (default false;
    // opt in per target or via [defaults]). Works even when copy trading is disabled.
    const withdrawalWatchAddresses = activeTargets
      .filter((t) => (t.watch_withdrawals ?? defaults.watch_withdrawals ?? false) === true)
      .map((t) => t.address);
    const targetCopyProfiles = new Map<string, TargetCopyParams>();

    if (shared) {
      const logsDir = resolve(cwd, "logs");
      await mkdir(logsDir, { recursive: true });

      for (const row of activeTargets) {
        const copyRatio = requireNum("copy_ratio", row.copy_ratio ?? defaults.copy_ratio, `targets ${row.address}`);
        const maxPriceDifference = requireNum(
          "max_price_difference",
          row.max_price_difference ?? defaults.max_price_difference,
          `targets ${row.address}`
        );
        const maxUnderbidDifferenceRaw =
          row.max_underbid_difference ?? defaults.max_underbid_difference;
        let maxUnderbidDifference: number | undefined;
        if (maxUnderbidDifferenceRaw !== undefined) {
          if (!Number.isFinite(maxUnderbidDifferenceRaw) || maxUnderbidDifferenceRaw < 0) {
            throw new Error(
              `targets ${row.address}: max_underbid_difference must be a non-negative number`
            );
          }
          maxUnderbidDifference = maxUnderbidDifferenceRaw;
        }
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

        const dryRun = row.dry_run ?? defaults.dry_run ?? false;

        const hedgePriceRaw = row.hedge_price ?? defaults.hedge_price;
        const hedgePrice = optionalProb01("hedge_price", hedgePriceRaw, `targets ${row.address}`);

        const maxMarketUsdcRaw = row.max_market_usdc ?? defaults.max_market_usdc;
        let maxMarketUsdc: number | undefined;
        if (maxMarketUsdcRaw !== undefined) {
          if (!Number.isFinite(maxMarketUsdcRaw) || maxMarketUsdcRaw <= 0) {
            throw new Error(`targets ${row.address}: max_market_usdc must be a positive number`);
          }
          maxMarketUsdc = maxMarketUsdcRaw;
        }

        const accumulateBelowMin = row.accumulate_below_min ?? defaults.accumulate_below_min ?? false;

        targetCopyProfiles.set(row.address, {
          address: row.address,
          copyRatio,
          maxPriceDifference,
          maxUnderbidDifference,
          buyPriceMin,
          buyPriceMax,
          minPositionUsdc,
          maxPositionUsdc,
          dryRun,
          hedgePrice,
          maxMarketUsdc,
          accumulateBelowMin,
          copyTradeLogPath,
        });
      }
    }

    return {
      ...rpc,
      targetTraderAddresses,
      withdrawalWatchAddresses,
      targetCopyProfiles,
      copyTradeShared: shared,
    };
  }

  /** Legacy: env-only target list */
  const targetTraderAddresses = parseAddressList(requireEnv("TARGET_TRADER_ADDRESSES"));
  const shared = await loadCopyTradeSharedFromEnv();
  const targetCopyProfiles = new Map<string, TargetCopyParams>();

  if (shared) {
    const copyRatio = parsePositiveFloatEnv("COPY_RATIO");
    const maxPriceDifference = parsePositiveFloatEnv("MAX_PRICE_DIFFERENCE");
    const maxUnderbidRaw = process.env["MAX_UNDERBID_DIFFERENCE"]?.trim();
    let maxUnderbidDifference: number | undefined;
    if (maxUnderbidRaw) {
      const n = parseFloat(maxUnderbidRaw);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error("MAX_UNDERBID_DIFFERENCE must be a non-negative number when set");
      }
      maxUnderbidDifference = n;
    }
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
      // Legacy env-only path: dry_run lives in TOML now; default to live trading here.
      targetCopyProfiles.set(addr, {
        address: addr,
        copyRatio,
        maxPriceDifference,
        maxUnderbidDifference,
        buyPriceMin,
        buyPriceMax,
        minPositionUsdc,
        maxPositionUsdc,
        dryRun: false,
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
          dryRun: false,
          copyTradeLogPath: resolve(logsDir, base),
        });
      }
    }
  }

  return {
    ...rpc,
    targetTraderAddresses,
    // Legacy env-only path has no per-target watch flag — default off (use TOML to enable).
    withdrawalWatchAddresses: [],
    targetCopyProfiles,
    copyTradeShared: shared,
  };
}
