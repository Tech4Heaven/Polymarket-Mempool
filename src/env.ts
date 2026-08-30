import "dotenv/config";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { isAbsolute, resolve } from "path";
import { getAddress, isAddress } from "ethers";
import { EXCHANGE_V2_ADDRESSES } from "./contracts.js";
import { resolveCopyWalletPrivateKeyRaw, requirePrivateKeyHex } from "./copyWalletKeyJson.js";
import { parseCopyTargetsTomlFile } from "./copyTargetsToml.js";
import { fetchPolymarketProfileLabel } from "./polymarketProfile.js";
import { normalizeAssetKey } from "./cryptoMarketPrewarm.js";

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
  /** Optional Polymarket username from the toml — shown in log lines alongside the address. */
  username?: string;
  copyRatio: number;
  maxPriceDifference: number;
  /** Buy only: skip if (implied - effectivePrice) > this. Undefined = no underbid skip. */
  maxUnderbidDifference?: number;
  /**
   * Buy only: skip if the price fell more than this FRACTION below the target's entry, i.e.
   * effectivePrice < implied × (1 - this). Unlike the absolute cap, the tolerance scales with the
   * entry price, so a genuine cheap entry (target also bought low) copies while a collapse from a
   * higher entry is skipped. Undefined = disabled.
   */
  maxUnderbidFrac?: number;
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
  /** Hedge size as a fraction of the filled main position (0 < x ≤ 1). Default 1 (fully balance). */
  hedgeTokenPercent?: number;
  /**
   * Per-side max USDC cap. The most USDC we'll commit to this target's copies on a single
   * outcome token. Applied independently per outcome. Buys are clipped to fit; full sells
   * reset the side's bucket. Omit = no cap.
   */
  maxMarketUsdc?: number;
  /** If true, accumulate below-min buys per (target, tokenId) and post a combined order when their sum crosses min. */
  accumulateBelowMin?: boolean;
  /**
   * Seconds to keep watching a market after a `price drift buy` skip and repost the buy if the CLOB
   * price returns to within max_price_difference. Default 120. 0 disables re-watching.
   */
  driftRewatchSeconds?: number;
  /**
   * Max drift (effective − implied) at skip time for a `price drift buy` to still be re-watched.
   * Larger drifts are dropped permanently. Should exceed max_price_difference. Default 0.2.
   */
  driftRewatchMax?: number;
  /** Auto-stop: max realized USD loss today (UTC) before halting new copies; omit to disable. */
  maxDrawdownPerDay?: number;
  /** Auto-stop: max realized USD loss all-time before halting new copies; omit to disable. */
  maxDrawdownTotal?: number;
  /** Taker fill: price amount (0–1) added above the ask so buys cross and fill. Omit/0 = maker-style. */
  takerBump?: number;
  /** Cap on the taker bump as a fraction of the ask (default 0.10 when takerBump set). */
  maxTakerBumpFrac?: number;
  /** Sell fill: price amount (0–1) subtracted below the bid so sells cross and fill. Omit/0 = maker-style. */
  sellBump?: number;
  /** Cap on the sell bump as a fraction of the bid (default 0.10 when sellBump set). */
  maxSellBumpFrac?: number;
  /** Reprice-until-filled for sells: max reprice cycles (0/omit = disabled). */
  sellRepriceAttempts?: number;
  /** Reprice deadline in ms since the first sell post (default 2500). */
  sellRepriceDeadlineMs?: number;
  /** Reprice slippage floor: never sell below implied × (1 − this). Omit = no floor. */
  sellMaxSlippageFrac?: number;
  /** Restrict copies to these crypto asset keys (normalized, e.g. ["btc"]). Empty/undefined = no filter. */
  marketFilter?: string[];
  /** Fresh-wallet bait guard: skip the target's first trade if it's a buy below newWalletMinUsd. */
  newWallet?: boolean;
  /** USD floor for the new-wallet first trade (default 150 when newWallet set). */
  newWalletMinUsd?: number;
  /** Protective take-profit: after each copied buy fills, rest a GTC SELL of it at this price (0,1). */
  safeSell?: number;
  copyTradeLogPath: string;
};

export type CopyTradeConfig = CopyTradeShared & {
  copyRatio: number;
  maxPriceDifference: number;
  maxUnderbidDifference?: number;
  maxUnderbidFrac?: number;
  buyPriceMin?: number;
  buyPriceMax?: number;
  minPositionUsdc: number;
  maxPositionUsdc: number;
  /** Per-target dry-run flag (merged from TargetCopyParams). */
  dryRun: boolean;
  /** Per-target hedge price (merged from TargetCopyParams). Omit = no hedging. */
  hedgePrice?: number;
  /** Per-target hedge size as a fraction of the filled main position (default 1). */
  hedgeTokenPercent?: number;
  /** Per-target per-side max USDC cap. Omit = no cap. */
  maxMarketUsdc?: number;
  /** Per-target below-min accumulator toggle. */
  accumulateBelowMin?: boolean;
  /** Per-target drift re-watch window in seconds (default 120, 0 = disabled). */
  driftRewatchSeconds?: number;
  /** Per-target max drift at skip time still eligible for re-watch (default 0.2). */
  driftRewatchMax?: number;
  /** Per-target auto-stop: max realized USD loss today (UTC) before halting new copies. */
  maxDrawdownPerDay?: number;
  /** Per-target auto-stop: max realized USD loss all-time before halting new copies. */
  maxDrawdownTotal?: number;
  /** Per-target taker bump (price added above the ask so buys fill). */
  takerBump?: number;
  /** Per-target cap on the taker bump as a fraction of the ask. */
  maxTakerBumpFrac?: number;
  /** Per-target sell bump (price subtracted below the bid so sells fill). */
  sellBump?: number;
  /** Per-target cap on the sell bump as a fraction of the bid. */
  maxSellBumpFrac?: number;
  /** Per-target reprice-until-filled: max reprice cycles for an unfilled sell (0 = disabled). */
  sellRepriceAttempts?: number;
  /** Per-target reprice deadline in ms since the first sell post (default 2500). */
  sellRepriceDeadlineMs?: number;
  /** Per-target reprice slippage floor: never sell below implied × (1 − this). */
  sellMaxSlippageFrac?: number;
  /** Per-target crypto asset filter (normalized keys, e.g. ["btc"]). Empty/undefined = copy all markets. */
  marketFilter?: string[];
  /** Per-target fresh-wallet bait guard: skip the first trade if it's a buy below newWalletMinUsd. */
  newWallet?: boolean;
  /** Per-target USD floor for the new-wallet first trade (default 150). */
  newWalletMinUsd?: number;
  /** Per-target protective take-profit price (0,1): rest a GTC sell of each copied buy here. */
  safeSell?: number;
  /**
   * Target wallet address (checksum). Needed so per-target trackers (max_market_usdc, etc.)
   * can attribute spend to the right target across the shared copy wallet.
   */
  targetAddress: string;
  /** Optional Polymarket username (from toml) — shown next to the address in copy log lines. */
  username?: string;
  /**
   * When set, copy-trade lines go here; otherwise {@link appendCopyTradeSuccessLine} uses env / default file.
   */
  copyTradeLogPath?: string;
};

/**
 * Where target trades are detected from:
 *  - `polynode`: PolyNode pending-settlement mempool feed only (~3–5s pre-confirmation). DEFAULT.
 *  - `onchain`:  legacy OrderFilled log subscription + receipt (post-mining).
 *  - `both`:     PolyNode primary + on-chain fallback, deduped by (tx, target).
 *
 * Default is `polynode` — PolyNode is the sole detector. Do NOT rely on `both`/`onchain`: their
 * on-chain path opens a Chainstack `eth_subscribe` (OrderFilled) that Chainstack bills per pushed
 * message (~6M requests/day across the fleet — it exhausted a 20M/mo plan in days) and is redundant
 * with PolyNode (which is also faster). Only set `both`/`onchain` deliberately for a specific reason.
 */
export type DetectionSource = "polynode" | "onchain" | "both";

export type AppConfig = {
  /** WebSocket RPC URL — Polygon node used for the on-chain OrderFilled subscription. */
  polygonWssUrl: string;
  /** HTTP RPC URL used for receipt fetching (typically a cheaper provider like Chainstack). */
  polygonMempoolHttpUrl: string;
  /** Detection strategy (default `both`). */
  detectionSource: DetectionSource;
  /** PolyNode API key (`pn_live_...`); required when detectionSource includes PolyNode. */
  polynodeApiKey?: string;
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
    maxUnderbidFrac: p.maxUnderbidFrac,
    buyPriceMin: p.buyPriceMin,
    buyPriceMax: p.buyPriceMax,
    minPositionUsdc: p.minPositionUsdc,
    maxPositionUsdc: p.maxPositionUsdc,
    dryRun: p.dryRun,
    hedgePrice: p.hedgePrice,
    hedgeTokenPercent: p.hedgeTokenPercent,
    maxMarketUsdc: p.maxMarketUsdc,
    accumulateBelowMin: p.accumulateBelowMin,
    driftRewatchSeconds: p.driftRewatchSeconds,
    driftRewatchMax: p.driftRewatchMax,
    maxDrawdownPerDay: p.maxDrawdownPerDay,
    maxDrawdownTotal: p.maxDrawdownTotal,
    takerBump: p.takerBump,
    maxTakerBumpFrac: p.maxTakerBumpFrac,
    sellBump: p.sellBump,
    maxSellBumpFrac: p.maxSellBumpFrac,
    sellRepriceAttempts: p.sellRepriceAttempts,
    sellRepriceDeadlineMs: p.sellRepriceDeadlineMs,
    sellMaxSlippageFrac: p.sellMaxSlippageFrac,
    marketFilter: p.marketFilter,
    newWallet: p.newWallet,
    newWalletMinUsd: p.newWalletMinUsd,
    safeSell: p.safeSell,
    targetAddress: p.address,
    username: p.username,
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

function parseDetectionSource(): DetectionSource {
  const raw = process.env["DETECTION_SOURCE"]?.trim().toLowerCase();
  if (raw === "polynode" || raw === "onchain" || raw === "both") {
    return raw;
  }
  if (raw) {
    throw new Error(`DETECTION_SOURCE must be one of polynode|onchain|both (got "${raw}")`);
  }
  return "polynode"; // default: PolyNode is the sole detector — never silently start the Chainstack eth_subscribe watcher
}

function loadRpcOnly(): Pick<
  AppConfig,
  | "polygonWssUrl"
  | "polygonMempoolHttpUrl"
  | "detectionSource"
  | "polynodeApiKey"
  | "exchangeAddresses"
  | "maxConcurrentTxLookups"
  | "withdrawalPollMinutes"
  | "withdrawalAlertUsd"
> {
  const detectionSource = parseDetectionSource();
  const polynodeApiKey = process.env["POLYNODE_API_KEY"]?.trim() || undefined;
  if ((detectionSource === "polynode" || detectionSource === "both") && !polynodeApiKey) {
    throw new Error(
      `DETECTION_SOURCE=${detectionSource} requires POLYNODE_API_KEY (pn_live_...) in the environment`
    );
  }
  // On-chain-only deployments don't need a Polygon WSS at all; require it otherwise.
  const polygonWssUrl =
    detectionSource === "polynode" ? (process.env["POLYGON_WSS_URL"]?.trim() ?? "") : requireEnv("POLYGON_WSS_URL");
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
    detectionSource,
    polynodeApiKey,
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
        const maxUnderbidFracRaw = row.max_underbid_frac ?? defaults.max_underbid_frac;
        let maxUnderbidFrac: number | undefined;
        if (maxUnderbidFracRaw !== undefined) {
          // A fraction of the entry price: 0.5 = "price may not fall more than 50% below entry".
          // 1 or more would floor at/below zero and reject every buy, so it's rejected as a typo.
          if (!Number.isFinite(maxUnderbidFracRaw) || maxUnderbidFracRaw <= 0 || maxUnderbidFracRaw >= 1) {
            throw new Error(
              `targets ${row.address}: max_underbid_frac must be a fraction between 0 and 1 (e.g. 0.5)`
            );
          }
          maxUnderbidFrac = maxUnderbidFracRaw;
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

        const hedgeTokenPercentRaw = row.hedge_token_percent ?? defaults.hedge_token_percent;
        let hedgeTokenPercent: number | undefined;
        if (hedgeTokenPercentRaw !== undefined) {
          if (!Number.isFinite(hedgeTokenPercentRaw) || hedgeTokenPercentRaw <= 0 || hedgeTokenPercentRaw > 1) {
            throw new Error(`targets ${row.address}: hedge_token_percent must be a fraction in (0, 1] (e.g. 0.5)`);
          }
          hedgeTokenPercent = hedgeTokenPercentRaw;
        }

        const maxMarketUsdcRaw = row.max_market_usdc ?? defaults.max_market_usdc;
        let maxMarketUsdc: number | undefined;
        if (maxMarketUsdcRaw !== undefined) {
          if (!Number.isFinite(maxMarketUsdcRaw) || maxMarketUsdcRaw <= 0) {
            throw new Error(`targets ${row.address}: max_market_usdc must be a positive number`);
          }
          maxMarketUsdc = maxMarketUsdcRaw;
        }

        const accumulateBelowMin = row.accumulate_below_min ?? defaults.accumulate_below_min ?? false;

        const driftRewatchSeconds = row.drift_rewatch_seconds ?? defaults.drift_rewatch_seconds ?? 120;
        if (!Number.isFinite(driftRewatchSeconds) || driftRewatchSeconds < 0) {
          throw new Error(`targets ${row.address}: drift_rewatch_seconds must be a non-negative number`);
        }

        const driftRewatchMax = row.drift_rewatch_max ?? defaults.drift_rewatch_max ?? 0.2;
        if (!Number.isFinite(driftRewatchMax) || driftRewatchMax < 0 || driftRewatchMax > 1) {
          throw new Error(`targets ${row.address}: drift_rewatch_max must be a number in [0, 1]`);
        }
        if (driftRewatchSeconds > 0 && driftRewatchMax <= maxPriceDifference) {
          console.warn(
            `[config] targets ${row.address}: drift_rewatch_max (${driftRewatchMax}) <= max_price_difference ` +
              `(${maxPriceDifference}) — no drift skip can qualify, so re-watch is effectively off`
          );
        }

        const maxDrawdownPerDay = row.max_drawdown_per_day ?? defaults.max_drawdown_per_day;
        const maxDrawdownTotal = row.max_drawdown_total ?? defaults.max_drawdown_total;
        for (const [k, v] of [
          ["max_drawdown_per_day", maxDrawdownPerDay],
          ["max_drawdown_total", maxDrawdownTotal],
        ] as const) {
          if (v !== undefined && (!Number.isFinite(v) || v <= 0)) {
            throw new Error(`targets ${row.address}: ${k} must be a positive number (USD loss limit)`);
          }
        }

        const takerBump = row.taker_bump ?? defaults.taker_bump;
        if (takerBump !== undefined && (!Number.isFinite(takerBump) || takerBump < 0 || takerBump >= 1)) {
          throw new Error(`targets ${row.address}: taker_bump must be a price amount in [0, 1) (e.g. 0.02)`);
        }
        const maxTakerBumpFrac = row.max_taker_bump_frac ?? defaults.max_taker_bump_frac;
        if (maxTakerBumpFrac !== undefined && (!Number.isFinite(maxTakerBumpFrac) || maxTakerBumpFrac <= 0 || maxTakerBumpFrac > 1)) {
          throw new Error(`targets ${row.address}: max_taker_bump_frac must be a fraction in (0, 1] (e.g. 0.10)`);
        }

        const sellBump = row.sell_bump ?? defaults.sell_bump;
        if (sellBump !== undefined && (!Number.isFinite(sellBump) || sellBump < 0 || sellBump >= 1)) {
          throw new Error(`targets ${row.address}: sell_bump must be a price amount in [0, 1) (e.g. 0.02)`);
        }
        const maxSellBumpFrac = row.max_sell_bump_frac ?? defaults.max_sell_bump_frac;
        if (maxSellBumpFrac !== undefined && (!Number.isFinite(maxSellBumpFrac) || maxSellBumpFrac <= 0 || maxSellBumpFrac > 1)) {
          throw new Error(`targets ${row.address}: max_sell_bump_frac must be a fraction in (0, 1] (e.g. 0.10)`);
        }
        const sellRepriceAttempts = row.sell_reprice_attempts ?? defaults.sell_reprice_attempts;
        if (sellRepriceAttempts !== undefined && (!Number.isInteger(sellRepriceAttempts) || sellRepriceAttempts < 0)) {
          throw new Error(`targets ${row.address}: sell_reprice_attempts must be a non-negative integer`);
        }
        const sellRepriceDeadlineMs = row.sell_reprice_deadline_ms ?? defaults.sell_reprice_deadline_ms;
        if (sellRepriceDeadlineMs !== undefined && (!Number.isFinite(sellRepriceDeadlineMs) || sellRepriceDeadlineMs <= 0)) {
          throw new Error(`targets ${row.address}: sell_reprice_deadline_ms must be a positive number (ms)`);
        }
        const sellMaxSlippageFrac = row.sell_max_slippage_frac ?? defaults.sell_max_slippage_frac;
        if (sellMaxSlippageFrac !== undefined && (!Number.isFinite(sellMaxSlippageFrac) || sellMaxSlippageFrac <= 0 || sellMaxSlippageFrac >= 1)) {
          throw new Error(`targets ${row.address}: sell_max_slippage_frac must be a fraction in (0, 1) (e.g. 0.10)`);
        }

        const marketRaw = row.market ?? defaults.market;
        let marketFilter: string[] | undefined;
        if (marketRaw !== undefined) {
          const list = (Array.isArray(marketRaw) ? marketRaw : [marketRaw])
            .map((s) => (typeof s === "string" ? normalizeAssetKey(s) : ""))
            .filter((s) => s.length > 0);
          if (list.length === 0) {
            throw new Error(`targets ${row.address}: market must be a non-empty asset string or array (e.g. "btc" or ["btc","eth"])`);
          }
          marketFilter = [...new Set(list)];
        }

        const newWallet = row.new_wallet ?? defaults.new_wallet;
        const newWalletMinUsd = row.new_wallet_min_usd ?? defaults.new_wallet_min_usd;
        if (newWalletMinUsd !== undefined && (!Number.isFinite(newWalletMinUsd) || newWalletMinUsd <= 0)) {
          throw new Error(`targets ${row.address}: new_wallet_min_usd must be a positive USD amount (e.g. 150)`);
        }

        const safeSell = row.safe_sell ?? defaults.safe_sell;
        if (safeSell !== undefined && (!Number.isFinite(safeSell) || safeSell <= 0 || safeSell >= 1)) {
          throw new Error(`targets ${row.address}: safe_sell must be a price in (0, 1) (e.g. 0.99)`);
        }
        if (safeSell !== undefined && hedgePrice !== undefined) {
          throw new Error(`targets ${row.address}: safe_sell and hedge_price can't be combined on one target (both manage the position's protective order)`);
        }

        targetCopyProfiles.set(row.address, {
          address: row.address,
          username: row.username,
          copyRatio,
          maxPriceDifference,
          maxUnderbidDifference,
          maxUnderbidFrac,
          buyPriceMin,
          buyPriceMax,
          minPositionUsdc,
          maxPositionUsdc,
          dryRun,
          hedgePrice,
          hedgeTokenPercent,
          maxMarketUsdc,
          accumulateBelowMin,
          driftRewatchSeconds,
          driftRewatchMax,
          maxDrawdownPerDay,
          maxDrawdownTotal,
          takerBump,
          maxTakerBumpFrac,
          sellBump,
          maxSellBumpFrac,
          sellRepriceAttempts,
          sellRepriceDeadlineMs,
          sellMaxSlippageFrac,
          marketFilter,
          newWallet,
          newWalletMinUsd,
          safeSell,
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
        driftRewatchSeconds: 120,
        driftRewatchMax: 0.2,
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
