import type { CopyDigest } from "./copyTrade.js";

/**
 * PolyNode settlement feed types (subset we consume).
 * Full schema: https://docs.polynode.dev/websocket/events/settlement.md
 *
 * A settlement records a Polymarket trade. Each entry in `trades[]` is one OrderFilled log,
 * and — critically — every field on it is recorded from the MAKER's perspective. So a given
 * wallet's genuine trade is the fill where `maker === wallet`; matching by `taker` yields the
 * counterparty view (opposite token + complement price). See buildDigestsFromSettlement.
 */
export type SettlementTrade = {
  maker: string;
  taker: string;
  token_id: string;
  /** Maker's side in this fill. */
  side: "BUY" | "SELL";
  /** Maker's fill price, 0–1. */
  price: number;
  /** Maker's fill size in shares. */
  size: number;
  maker_amount?: string;
  taker_amount?: string;
  outcome?: string;
  order_hash?: string;
};

export type SettlementData = {
  tx_hash: string;
  status: "pending" | "confirmed";
  /** Unix ms when PolyNode detected the pending tx in the mempool. */
  detected_at?: number;
  block_number?: number | null;
  taker_wallet?: string;
  condition_id?: string;
  neg_risk?: boolean;
  market_title?: string;
  outcome?: string;
  trades?: SettlementTrade[];
};

export type SettlementMessage = {
  type: string;
  timestamp?: number;
  data?: SettlementData;
};

/** Convert a decimal amount to a raw 6-decimal bigint, matching `formatUnits(x, 6)` semantics. */
function toRaw6(n: number): bigint {
  if (!Number.isFinite(n) || n <= 0) {
    return 0n;
  }
  return BigInt(Math.round(n * 1e6));
}

/**
 * Reconstruct a target wallet's own position change from a PolyNode settlement, as a `CopyDigest`
 * identical in shape to the on-chain (receipt-derived) path — so everything downstream in
 * `executeCopyTrade` is unchanged.
 *
 * Rule (per PolyNode docs): a wallet's genuine trade is the set of fills in `trades[]` where
 * `fill.maker === target`. We read `side`/`token_id`/`price`/`size` straight off those fills.
 * We NEVER match by `taker` (that's the counterparty — inverted token and complement price).
 *
 * Mirrors `buildCopyDigests`: emits at most one digest, and only when the target's fills reference
 * exactly ONE outcome token with a single consistent side. Anything ambiguous (multiple tokens, or
 * both buy and sell of the same token in one tx) returns `[]` — no copy.
 */
export function buildDigestsFromSettlement(data: SettlementData, targetAddress: string): CopyDigest[] {
  const target = targetAddress.toLowerCase();
  const trades = data.trades ?? [];

  // token_id -> aggregated { side, shares, pusd, mixed }
  type Agg = { side: "buy" | "sell"; shares: number; pusd: number; mixed: boolean };
  const byToken = new Map<string, Agg>();

  for (const t of trades) {
    if (!t || typeof t.maker !== "string" || t.maker.toLowerCase() !== target) {
      continue;
    }
    const side: "buy" | "sell" | null = t.side === "SELL" ? "sell" : t.side === "BUY" ? "buy" : null;
    const size = Number(t.size);
    const price = Number(t.price);
    if (!side || !t.token_id || !Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0) {
      continue;
    }
    const pusd = size * price;
    const cur = byToken.get(t.token_id);
    if (!cur) {
      byToken.set(t.token_id, { side, shares: size, pusd, mixed: false });
    } else if (cur.side !== side) {
      cur.mixed = true; // both buy and sell of the same token in one tx — ambiguous
    } else {
      cur.shares += size;
      cur.pusd += pusd;
    }
  }

  // Only copy when the target touched exactly one outcome token, cleanly (single side).
  if (byToken.size !== 1) {
    return [];
  }
  const [tokenId, agg] = [...byToken.entries()][0]!;
  if (agg.mixed) {
    return [];
  }
  const outcomeRaw = toRaw6(agg.shares);
  const pusdRaw = toRaw6(agg.pusd);
  if (outcomeRaw === 0n || pusdRaw === 0n) {
    return [];
  }
  return [{ side: agg.side, tokenId, outcomeRaw, pusdRaw }];
}

/** Configured targets (checksum) that appear as a maker in this settlement's fills. */
export function matchedMakerTargets(data: SettlementData, targetsLower: Set<string>): string[] {
  const seen = new Set<string>();
  for (const t of data.trades ?? []) {
    if (typeof t?.maker === "string") {
      const lc = t.maker.toLowerCase();
      if (targetsLower.has(lc)) {
        seen.add(lc);
      }
    }
  }
  return [...seen];
}
