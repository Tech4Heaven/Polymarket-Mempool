import { readFile } from "fs/promises";
import { resolve } from "path";
import { parse } from "@iarna/toml";
import { getAddress, isAddress } from "ethers";

export type TomlDefaultsSection = {
  /** Defaults applied to each [[targets]] row when a field is omitted */
  copy_ratio?: number;
  max_price_difference?: number;
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
   * If true, buys whose post-ratio notional is below `min_position_usdc` are accumulated per market
   * side. The bot posts ONE combined order as soon as the accumulator (plus the next incoming buy)
   * crosses the threshold. Default false (original behavior — drop sub-min trades).
   */
  accumulate_below_min?: boolean;
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
  buy_price_min?: number;
  buy_price_max?: number;
  min_position_usdc?: number;
  max_position_usdc?: number;
  dry_run?: boolean;
  hedge_price?: number;
  max_market_usdc?: number;
  watch_withdrawals?: boolean;
  accumulate_below_min?: boolean;
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
      buy_price_min: numOrUndef("buy_price_min", src),
      buy_price_max: numOrUndef("buy_price_max", src),
      min_position_usdc: numOrUndef("min_position_usdc", src),
      max_position_usdc: numOrUndef("max_position_usdc", src),
      dry_run: boolOrUndef("dry_run", src),
      hedge_price: numOrUndef("hedge_price", src),
      max_market_usdc: numOrUndef("max_market_usdc", src),
      watch_withdrawals: boolOrUndef("watch_withdrawals", src),
      accumulate_below_min: boolOrUndef("accumulate_below_min", src),
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
      buy_price_min: numOrUndef("buy_price_min", row),
      buy_price_max: numOrUndef("buy_price_max", row),
      min_position_usdc: numOrUndef("min_position_usdc", row),
      max_position_usdc: numOrUndef("max_position_usdc", row),
      dry_run: boolOrUndef("dry_run", row),
      hedge_price: numOrUndef("hedge_price", row),
      max_market_usdc: numOrUndef("max_market_usdc", row),
      watch_withdrawals: boolOrUndef("watch_withdrawals", row),
      accumulate_below_min: boolOrUndef("accumulate_below_min", row),
      enabled: boolOrUndef("enabled", row),
    });
  }

  if (targets.length === 0) {
    throw new Error(`copy targets TOML: need at least one [[targets]] (${abs})`);
  }

  return { defaults, targets };
}
