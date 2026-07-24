import type { TickSize } from "@polymarket/clob-client-v2";
import type { CopyDigest } from "./copyTrade.js";

const TICK_SIZES: TickSize[] = ["0.1", "0.01", "0.001", "0.0001"];
/** Map the settlement's numeric tick_size to the CLOB's TickSize literal, or null if unrecognized. */
function toTickSize(n: number | undefined): TickSize | undefined {
  if (typeof n !== "number") {
    return undefined;
  }
  return TICK_SIZES.find((t) => Math.abs(parseFloat(t) - n) < 1e-9);
}

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
  /** The taker's order: side / token / SIGNED price / size. `taker_price` is the LIMIT, not the fill. */
  taker_side?: "BUY" | "SELL";
  taker_price?: number;
  taker_size?: number;
  taker_token?: string;
  token_ids?: string[];
  /** The market's tick size at the moment of this trade — authoritative and real-time. */
  tick_size?: number;
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
 * TWO roles, handled differently (this is what fixes the signed-price bug):
 *
 *  - Target is the TAKER (`taker_wallet === target`). PolyNode includes a SELF-ENTRY where
 *    `maker === taker === target`; its `price` is the target's SIGNED LIMIT (set high to cross fast),
 *    NOT the fill. Reading it makes `implied` bogus (e.g. 0.99 when they filled at 0.77). Instead we
 *    reconstruct the REAL fill from the COUNTERPARTY legs (`taker === target && maker !== target`):
 *    each such maker leg is a real resting order that executed. In a binary market a maker on the
 *    OPPOSITE outcome mints a complete set, so the taker's per-share cost for their token is
 *    `1 − maker_price`; a maker on the SAME token is a direct fill at `maker_price`. We size-weight
 *    across legs → the true average entry.
 *
 *  - Target is a genuine MAKER (their resting order was hit; `taker !== target`). A maker fills at
 *    their own resting price, so `maker`-leg price IS the real fill — the original logic is correct.
 *
 * Emits at most one digest, only when the target's fills reference exactly ONE outcome token with a
 * single consistent side. Anything ambiguous returns `[]` — no copy.
 */
export function buildDigestsFromSettlement(data: SettlementData, targetAddress: string): CopyDigest[] {
  const target = targetAddress.toLowerCase();
  const digests =
    data.taker_wallet?.toLowerCase() === target ? takerDigest(data, target) : makerDigest(data.trades ?? [], target);
  // Stamp the market's real-time tick from the settlement so the copy order is priced on the correct
  // tick the FIRST time — no cached-tick guess, no post-reject-and-repost round-trip.
  const tickSize = toTickSize(data.tick_size);
  if (tickSize) {
    for (const d of digests) {
      d.tickSize = tickSize;
    }
  }
  return digests;
}

/** Target is the taker: real entry from the counterparty maker legs (complement rule + weighted avg). */
function takerDigest(data: SettlementData, target: string): CopyDigest[] {
  const side: "buy" | "sell" | null =
    data.taker_side === "SELL" ? "sell" : data.taker_side === "BUY" ? "buy" : null;
  const takerToken = data.taker_token;
  if (!side || !takerToken) {
    return [];
  }
  let shares = 0;
  let pusd = 0;
  for (const t of data.trades ?? []) {
    // Counterparty legs only: the target must be the taker AND the maker must be someone else
    // (skip the self-entry, whose price is the signed limit).
    if (t?.taker?.toLowerCase() !== target || t?.maker?.toLowerCase() === target || !t.token_id) {
      continue;
    }
    const size = Number(t.size);
    const price = Number(t.price);
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0 || price >= 1) {
      continue;
    }
    // Same token as the taker → direct fill at maker price; opposite token (binary mint) → 1 − price.
    const legPrice = t.token_id === takerToken ? price : 1 - price;
    if (legPrice <= 0 || legPrice >= 1) {
      continue;
    }
    shares += size;
    pusd += size * legPrice;
  }
  const outcomeRaw = toRaw6(shares);
  const pusdRaw = toRaw6(pusd);
  if (outcomeRaw === 0n || pusdRaw === 0n) {
    return [];
  }
  return [{ side, tokenId: takerToken, outcomeRaw, pusdRaw }];
}

/** Target is a genuine maker: their resting-order fills price at `maker_price` (the real fill). */
function makerDigest(trades: SettlementTrade[], target: string): CopyDigest[] {
  type Agg = { side: "buy" | "sell"; shares: number; pusd: number; mixed: boolean };
  const byToken = new Map<string, Agg>();

  for (const t of trades) {
    // Genuine maker fills only: maker === target but the taker is someone else (exclude self-entry).
    if (!t || typeof t.maker !== "string" || t.maker.toLowerCase() !== target || t.taker?.toLowerCase() === target) {
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
