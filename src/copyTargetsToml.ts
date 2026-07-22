import { readFile } from "fs/promises";
import { resolve } from "path";
import { parse } from "@iarna/toml";
import { getAddress, isAddress } from "ethers";

export type TomlDefaultsSection = {
  /** Defaults applied to each [[targets]] row when a field is omitted */
  copy_ratio?: number;
  max_price_difference?: number;
  /** Buy only: skip when (implied - effectivePrice) > this. Omit for no underbid skip. */
  max_underbid_difference?: number;
  /**
   * Buy only: skip when the price has fallen more than this FRACTION of the target's entry, i.e.
   * effectivePrice < implied × (1 - this). Scales with entry price, so it separates "target bought
   * cheap" (copy) from "price collapsed since the target bought" (skip). Omit to disable.
   */
  max_underbid_frac?: number;
  /** Buy only: outcome price in [0,1]; omit for no floor */
  buy_price_min?: number;
  /** Buy only: outcome price in [0,1]; omit for no ceiling */
  buy_price_max?: number;
  min_position_usdc?: number;
  max_position_usdc?: number;
  /** When true, copy decisions are computed and logged but no order is posted to CLOB. */
  dry_run?: boolean;
  /**
   * If set (0,1), after each copy BUY we place a GTC limit BUY for the OPPOSITE outcome at this
   * price, sized to our total holdings of the primary side in that condition. Acts as a passive
   * pre-hedge. Subsequent target opposite-side BUYs are suppressed (we're already hedged).
   */
  hedge_price?: number;
  /**
   * Per-side max USDC cap: the most USDC we'll commit to copies of THIS target on a single
   * outcome token. Applies independently per outcome (Up and Down each get their own bucket),
   * so total committed in a binary market can reach up to 2× this value.
   * Buys are clipped to fit; full sells reset the side's bucket. Omit = no cap.
   */
  max_market_usdc?: number;
  /** Whether the withdrawal watcher polls this wallet for fund outflows. Default false (opt-in). */
  watch_withdrawals?: boolean;
  /**
   * If true, buys that would be skipped by the CLOB's per-market `min_order_size` are accumulated
   * per (target, tokenId). The bot posts ONE combined order as soon as a later buy on the same side
   * pushes the combined share count above `min_order_size`. Default false.
   * Does NOT buffer `min_position_usdc` skips — set min_position_usdc = 0 to rely on min_order_size.
   */
  accumulate_below_min?: boolean;
  /**
   * When a BUY is skipped for `price drift buy` (CLOB moved above the target's implied by more than
   * max_price_difference), keep watching the market for this many seconds and repost the order if the
   * price returns to within max_price_difference. Default 120. Set 0 to disable re-watching.
   */
  drift_rewatch_seconds?: number;
  /**
   * Upper bound on the drift (effective − implied) at skip time for a `price drift buy` to still be
   * re-watched. Skips with a larger drift are dropped permanently (the market moved too far; a later
   * return is a new regime, not the original signal). Must sit above max_price_difference to have any
   * effect. Default 0.2.
   */
  drift_rewatch_max?: number;
  /**
   * Auto-stop copying this target when its realized P&L falls too far. Positive USD loss limits:
   *  - max_drawdown_per_day: stop new copies once today's (UTC) realized P&L ≤ −this; resumes next day.
   *  - max_drawdown_total:   stop new copies once all-time realized P&L ≤ −this (until config/limit change).
   * Omit either to disable that limit. Realized P&L comes from resolved markets in the P&L ledger.
   */
  max_drawdown_per_day?: number;
  max_drawdown_total?: number;
  /**
   * Taker fill improvement. Post buys ABOVE the best ask so they cross and fill instead of resting:
   *  - taker_bump:          price amount (0–1 units, e.g. 0.02 = 2¢) added above the ask.
   *  - max_taker_bump_frac: caps the bump to this fraction of the ask (e.g. 0.10 = at most 10% of price),
   *                         so low prices aren't over-paid. Tick-aware: if one tick would exceed the cap,
   *                         it posts at the ask (no bump). Default 0.10 when taker_bump is set.
   * Omit taker_bump (or 0) to keep maker-style posting. Applied after the drift check; buy_price_max caps it.
   */
  taker_bump?: number;
  max_taker_bump_frac?: number;
  /**
   * Master enable/disable for this target. When false, the bot does NOTHING for the address —
   * not copy trading, not withdrawal watching, not mempool event matching. Default true.
   */
  enabled?: boolean;
};

export type TomlTargetRow = {
  address: string;
  username?: string;
  copy_ratio?: number;
  max_price_difference?: number;
  max_underbid_difference?: number;
  max_underbid_frac?: number;
  buy_price_min?: number;
  buy_price_max?: number;
  min_position_usdc?: number;
  max_position_usdc?: number;
  dry_run?: boolean;
  hedge_price?: number;
  max_market_usdc?: number;
  watch_withdrawals?: boolean;
  accumulate_below_min?: boolean;
  drift_rewatch_seconds?: number;
  drift_rewatch_max?: number;
  max_drawdown_per_day?: number;
  max_drawdown_total?: number;
  taker_bump?: number;
  max_taker_bump_frac?: number;
  enabled?: boolean;
};

export type ParsedCopyTargetsToml = {
  defaults: TomlDefaultsSection | undefined;
  targets: TomlTargetRow[];
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function numOrUndef(k: string, o: Record<string, unknown>): number | undefined {
  if (!(k in o)) {
    return undefined;
  }
  const v = o[k];
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  return undefined;
}

function strOrUndef(k: string, o: Record<string, unknown>): string | undefined {
  if (!(k in o)) {
    return undefined;
  }
  const v = o[k];
  return typeof v === "string" ? v : undefined;
}

function boolOrUndef(k: string, o: Record<string, unknown>): boolean | undefined {
  if (!(k in o)) {
    return undefined;
  }
  const v = o[k];
  return typeof v === "boolean" ? v : undefined;
}

export async function parseCopyTargetsTomlFile(filePath: string): Promise<ParsedCopyTargetsToml> {
  const abs = resolve(filePath);
  const raw = await readFile(abs, "utf8");
  const doc = parse(raw) as unknown;
  const root = asRecord(doc);
  if (!root) {
    throw new Error(`copy targets TOML: expected table at root (${abs})`);
  }

  let defaults: TomlDefaultsSection | undefined;
  const defaultsTab = asRecord(root["defaults"]);
  const legacyClobTab = asRecord(root["clob"]);
  const src = defaultsTab ?? legacyClobTab;
  if (src) {
    defaults = {
      copy_ratio: numOrUndef("copy_ratio", src),
      max_price_difference: numOrUndef("max_price_difference", src),
      max_underbid_difference: numOrUndef("max_underbid_difference", src),
      max_underbid_frac: numOrUndef("max_underbid_frac", src),
      buy_price_min: numOrUndef("buy_price_min", src),
      buy_price_max: numOrUndef("buy_price_max", src),
      min_position_usdc: numOrUndef("min_position_usdc", src),
      max_position_usdc: numOrUndef("max_position_usdc", src),
      dry_run: boolOrUndef("dry_run", src),
      hedge_price: numOrUndef("hedge_price", src),
      max_market_usdc: numOrUndef("max_market_usdc", src),
      watch_withdrawals: boolOrUndef("watch_withdrawals", src),
      accumulate_below_min: boolOrUndef("accumulate_below_min", src),
      drift_rewatch_seconds: numOrUndef("drift_rewatch_seconds", src),
      drift_rewatch_max: numOrUndef("drift_rewatch_max", src),
      max_drawdown_per_day: numOrUndef("max_drawdown_per_day", src),
      max_drawdown_total: numOrUndef("max_drawdown_total", src),
      taker_bump: numOrUndef("taker_bump", src),
      max_taker_bump_frac: numOrUndef("max_taker_bump_frac", src),
      enabled: boolOrUndef("enabled", src),
    };
  }

  const targetsRaw = root["targets"];
  if (!Array.isArray(targetsRaw)) {
    throw new Error(`copy targets TOML: missing [[targets]] array (${abs})`);
  }

  const targets: TomlTargetRow[] = [];
  for (let i = 0; i < targetsRaw.length; i++) {
    const row = asRecord(targetsRaw[i]);
    if (!row) {
      throw new Error(`copy targets TOML: targets[${i}] must be a table (${abs})`);
    }
    const addrRaw = strOrUndef("address", row);
    if (!addrRaw || !isAddress(addrRaw)) {
      throw new Error(`copy targets TOML: targets[${i}].address invalid (${abs})`);
    }
    targets.push({
      address: getAddress(addrRaw),
      username: strOrUndef("username", row),
      copy_ratio: numOrUndef("copy_ratio", row),
      max_price_difference: numOrUndef("max_price_difference", row),
      max_underbid_difference: numOrUndef("max_underbid_difference", row),
      max_underbid_frac: numOrUndef("max_underbid_frac", row),
      buy_price_min: numOrUndef("buy_price_min", row),
      buy_price_max: numOrUndef("buy_price_max", row),
      min_position_usdc: numOrUndef("min_position_usdc", row),
      max_position_usdc: numOrUndef("max_position_usdc", row),
      dry_run: boolOrUndef("dry_run", row),
      hedge_price: numOrUndef("hedge_price", row),
      max_market_usdc: numOrUndef("max_market_usdc", row),
      watch_withdrawals: boolOrUndef("watch_withdrawals", row),
      accumulate_below_min: boolOrUndef("accumulate_below_min", row),
      drift_rewatch_seconds: numOrUndef("drift_rewatch_seconds", row),
      drift_rewatch_max: numOrUndef("drift_rewatch_max", row),
      max_drawdown_per_day: numOrUndef("max_drawdown_per_day", row),
      max_drawdown_total: numOrUndef("max_drawdown_total", row),
      taker_bump: numOrUndef("taker_bump", row),
      max_taker_bump_frac: numOrUndef("max_taker_bump_frac", row),
      enabled: boolOrUndef("enabled", row),
    });
  }

  if (targets.length === 0) {
    throw new Error(`copy targets TOML: need at least one [[targets]] (${abs})`);
  }

  return { defaults, targets };
}
