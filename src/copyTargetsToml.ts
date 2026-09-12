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
   * price, sized to the filled main position in that condition. Acts as a passive pre-hedge.
   * Subsequent target opposite-side BUYs are suppressed (we're already hedged).
   */
  hedge_price?: number;
  /** Hedge size as a fraction of the filled main position (0 < x ≤ 1). Default 1 = fully balance. */
  hedge_token_percent?: number;
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
   * Sell fill improvement (mirror of taker_bump for exits). Post sells BELOW the best bid so they
   * cross and fill instead of resting on top of a bid that may vanish in fast markets:
   *  - sell_bump:          price amount (0–1 units, e.g. 0.02 = 2¢) subtracted below the bid.
   *  - max_sell_bump_frac: caps the bump to this fraction of the bid (default 0.10). Tick-aware.
   * Omit sell_bump (or 0) for maker-style sells at the top bid.
   */
  sell_bump?: number;
  max_sell_bump_frac?: number;
  /**
   * Reprice-until-filled for sells. If a copied sell rests unfilled (bid moved/vanished), cancel the
   * resting remainder and re-post at a fresh aggressive price, chasing the market down:
   *  - sell_reprice_attempts:    max reprice cycles (0/omit = disabled; the sell posts once).
   *  - sell_reprice_deadline_ms: stop repricing after this many ms since the first post (default 2500).
   *  - sell_max_slippage_frac:   never reprice below implied × (1 − this); the remainder is abandoned
   *                              instead of dumped at any price. Omit = no floor (chase to the book).
   */
  sell_reprice_attempts?: number;
  sell_reprice_deadline_ms?: number;
  sell_max_slippage_frac?: number;
  /**
   * Restrict copying to specific crypto 5-minute "Up or Down" markets by asset. A single asset
   * (market = "btc") or a list (market = ["btc", "eth"]). Values match the market slug prefix; long
   * names are aliased (bitcoin→btc, ethereum→eth, …). When set, trades on any other asset — and any
   * non-crypto market — are skipped. Omit to copy every market the target trades.
   */
  market?: string | string[];
  /**
   * Fresh-wallet bait guard. When true, this target's FIRST observed trade is skipped if it's a buy
   * below `new_wallet_min_usd` (default 150) — the classic "open a tiny test position to lure copiers,
   * then withdraw" tactic. Only the first trade is gated; every later trade copies normally. Omit/false
   * to disable.
   */
  new_wallet?: boolean;
  /** USD floor for the new-wallet first trade (default 150 when new_wallet is set). */
  new_wallet_min_usd?: number;
  /**
   * Protective take-profit. When set to a price in (0,1) — typically 0.99 — after each copied BUY fills
   * we post a resting GTC SELL of that position at this price. A maker order (no fee) that locks the
   * value if the price spikes there, dodging the 99c->1c flip at resolution. If the target sells first,
   * the resting order is cancelled and his sell is copied. Omit to disable.
   */
  safe_sell?: number;
  /**
   * Copy only the target's MAIN side. Some traders buy BOTH outcomes of a market (a self-hedge);
   * copying both guarantees a losing leg. When true, we copy the FIRST outcome the target buys in each
   * market and SKIP any buy on the opposite outcome (his hedge/second leg) — a clean directional copy.
   * Pair with hedge_price to add our own protective hedge instead. Omit/false to copy both sides.
   */
  main_side_only?: boolean;
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
  hedge_token_percent?: number;
  max_market_usdc?: number;
  watch_withdrawals?: boolean;
  accumulate_below_min?: boolean;
  drift_rewatch_seconds?: number;
  drift_rewatch_max?: number;
  max_drawdown_per_day?: number;
  max_drawdown_total?: number;
  taker_bump?: number;
  max_taker_bump_frac?: number;
  sell_bump?: number;
  max_sell_bump_frac?: number;
  sell_reprice_attempts?: number;
  sell_reprice_deadline_ms?: number;
  sell_max_slippage_frac?: number;
  market?: string | string[];
  new_wallet?: boolean;
  new_wallet_min_usd?: number;
  safe_sell?: number;
  main_side_only?: boolean;
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

/** Reads a value that may be a single string or an array of strings (e.g. market = "btc" or ["btc","eth"]). */
function strOrStrArrayOrUndef(k: string, o: Record<string, unknown>): string[] | undefined {
  if (!(k in o)) {
    return undefined;
  }
  const v = o[k];
  if (typeof v === "string") {
    return [v];
  }
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return v as string[];
  }
  return undefined;
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
      hedge_token_percent: numOrUndef("hedge_token_percent", src),
      max_market_usdc: numOrUndef("max_market_usdc", src),
      watch_withdrawals: boolOrUndef("watch_withdrawals", src),
      accumulate_below_min: boolOrUndef("accumulate_below_min", src),
      drift_rewatch_seconds: numOrUndef("drift_rewatch_seconds", src),
      drift_rewatch_max: numOrUndef("drift_rewatch_max", src),
      max_drawdown_per_day: numOrUndef("max_drawdown_per_day", src),
      max_drawdown_total: numOrUndef("max_drawdown_total", src),
      taker_bump: numOrUndef("taker_bump", src),
      max_taker_bump_frac: numOrUndef("max_taker_bump_frac", src),
      sell_bump: numOrUndef("sell_bump", src),
      max_sell_bump_frac: numOrUndef("max_sell_bump_frac", src),
      sell_reprice_attempts: numOrUndef("sell_reprice_attempts", src),
      sell_reprice_deadline_ms: numOrUndef("sell_reprice_deadline_ms", src),
      sell_max_slippage_frac: numOrUndef("sell_max_slippage_frac", src),
      market: strOrStrArrayOrUndef("market", src),
      new_wallet: boolOrUndef("new_wallet", src),
      new_wallet_min_usd: numOrUndef("new_wallet_min_usd", src),
      safe_sell: numOrUndef("safe_sell", src),
      main_side_only: boolOrUndef("main_side_only", src),
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
      hedge_token_percent: numOrUndef("hedge_token_percent", row),
      max_market_usdc: numOrUndef("max_market_usdc", row),
      watch_withdrawals: boolOrUndef("watch_withdrawals", row),
      accumulate_below_min: boolOrUndef("accumulate_below_min", row),
      drift_rewatch_seconds: numOrUndef("drift_rewatch_seconds", row),
      drift_rewatch_max: numOrUndef("drift_rewatch_max", row),
      max_drawdown_per_day: numOrUndef("max_drawdown_per_day", row),
      max_drawdown_total: numOrUndef("max_drawdown_total", row),
      taker_bump: numOrUndef("taker_bump", row),
      max_taker_bump_frac: numOrUndef("max_taker_bump_frac", row),
      sell_bump: numOrUndef("sell_bump", row),
      max_sell_bump_frac: numOrUndef("max_sell_bump_frac", row),
      sell_reprice_attempts: numOrUndef("sell_reprice_attempts", row),
      sell_reprice_deadline_ms: numOrUndef("sell_reprice_deadline_ms", row),
      sell_max_slippage_frac: numOrUndef("sell_max_slippage_frac", row),
      market: strOrStrArrayOrUndef("market", row),
      new_wallet: boolOrUndef("new_wallet", row),
      new_wallet_min_usd: numOrUndef("new_wallet_min_usd", row),
      safe_sell: numOrUndef("safe_sell", row),
      main_side_only: boolOrUndef("main_side_only", row),
      enabled: boolOrUndef("enabled", row),
    });
  }

  if (targets.length === 0) {
    throw new Error(`copy targets TOML: need at least one [[targets]] (${abs})`);
  }

  return { defaults, targets };
}
