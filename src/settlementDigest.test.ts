import assert from "node:assert/strict";
import test from "node:test";
import { buildDigestsFromSettlement, matchedMakerTargets, type SettlementData, type SettlementTrade } from "./settlementDigest.js";

const TARGET = "0xAaAa000000000000000000000000000000000001";
const OTHER = "0xbBbB000000000000000000000000000000000002";
const TOKEN_A = "11111111111111111111111111111111111111111111111111111111111111111111111111";
const TOKEN_B = "22222222222222222222222222222222222222222222222222222222222222222222222222";

function trade(p: Partial<SettlementTrade>): SettlementTrade {
  return {
    maker: TARGET,
    taker: OTHER,
    token_id: TOKEN_A,
    side: "BUY",
    price: 0.53,
    size: 100,
    ...p,
  };
}

function settlement(trades: SettlementTrade[]): SettlementData {
  return { tx_hash: "0xabc", status: "pending", trades };
}

test("taker/maker-agnostic: target as maker BUY → one buy digest", () => {
  const d = buildDigestsFromSettlement(settlement([trade({ side: "BUY", size: 100, price: 0.53 })]), TARGET);
  assert.deepEqual(d, [{ side: "buy", tokenId: TOKEN_A, outcomeRaw: 100_000000n, pusdRaw: 53_000000n }]);
});

test("target as maker SELL → one sell digest", () => {
  const d = buildDigestsFromSettlement(settlement([trade({ side: "SELL", size: 50, price: 0.6 })]), TARGET);
  assert.deepEqual(d, [{ side: "sell", tokenId: TOKEN_A, outcomeRaw: 50_000000n, pusdRaw: 30_000000n }]);
});

test("multi-maker fills, same token+side → aggregated shares and pUSD", () => {
  const d = buildDigestsFromSettlement(
    settlement([
      trade({ side: "BUY", size: 60, price: 0.5 }),
      trade({ side: "BUY", size: 40, price: 0.55 }),
    ]),
    TARGET
  );
  // shares 100, pUSD 30 + 22 = 52 → implied 0.52
  assert.deepEqual(d, [{ side: "buy", tokenId: TOKEN_A, outcomeRaw: 100_000000n, pusdRaw: 52_000000n }]);
});

test("only counts fills where maker === target (never taker)", () => {
  // Target appears ONLY as taker here → no genuine maker fill → no copy.
  const d = buildDigestsFromSettlement(
    settlement([trade({ maker: OTHER, taker: TARGET, side: "BUY", size: 100, price: 0.53 })]),
    TARGET
  );
  assert.deepEqual(d, []);
});

test("ignores other wallets' maker fills in the same tx", () => {
  const d = buildDigestsFromSettlement(
    settlement([
      trade({ maker: OTHER, token_id: TOKEN_B, side: "SELL", size: 999, price: 0.9 }),
      trade({ maker: TARGET, token_id: TOKEN_A, side: "BUY", size: 25, price: 0.4 }),
    ]),
    TARGET
  );
  assert.deepEqual(d, [{ side: "buy", tokenId: TOKEN_A, outcomeRaw: 25_000000n, pusdRaw: 10_000000n }]);
});

test("multiple distinct tokens for target → skip (ambiguous)", () => {
  const d = buildDigestsFromSettlement(
    settlement([
      trade({ token_id: TOKEN_A, side: "BUY", size: 10, price: 0.5 }),
      trade({ token_id: TOKEN_B, side: "BUY", size: 10, price: 0.5 }),
    ]),
    TARGET
  );
  assert.deepEqual(d, []);
});

test("mixed buy+sell of same token → skip (ambiguous)", () => {
  const d = buildDigestsFromSettlement(
    settlement([
      trade({ token_id: TOKEN_A, side: "BUY", size: 10, price: 0.5 }),
      trade({ token_id: TOKEN_A, side: "SELL", size: 10, price: 0.5 }),
    ]),
    TARGET
  );
  assert.deepEqual(d, []);
});

test("fractional size/price convert to correct raw 6-decimal amounts", () => {
  const d = buildDigestsFromSettlement(settlement([trade({ side: "BUY", size: 12.1647, price: 0.85 })]), TARGET);
  // pUSD = 12.1647 * 0.85 = 10.339995
  assert.equal(d.length, 1);
  assert.equal(d[0]!.outcomeRaw, 12_164700n);
  assert.equal(d[0]!.pusdRaw, 10_339995n);
});

test("zero/invalid size or price → skip", () => {
  assert.deepEqual(buildDigestsFromSettlement(settlement([trade({ size: 0 })]), TARGET), []);
  assert.deepEqual(buildDigestsFromSettlement(settlement([trade({ price: 0 })]), TARGET), []);
  assert.deepEqual(buildDigestsFromSettlement(settlement([]), TARGET), []);
});

test("case-insensitive maker matching", () => {
  const d = buildDigestsFromSettlement(
    settlement([trade({ maker: TARGET.toLowerCase(), side: "BUY", size: 100, price: 0.53 })]),
    TARGET.toUpperCase()
  );
  assert.equal(d.length, 1);
});

test("matchedMakerTargets returns configured targets present as makers (lowercased)", () => {
  const set = new Set([TARGET.toLowerCase(), OTHER.toLowerCase()]);
  const data = settlement([
    trade({ maker: TARGET, side: "BUY" }),
    trade({ maker: "0xffff000000000000000000000000000000000009", taker: TARGET, side: "SELL" }),
  ]);
  assert.deepEqual(matchedMakerTargets(data, set), [TARGET.toLowerCase()]);
});
