import assert from "node:assert/strict";
import test from "node:test";
import { applyTakerBump, DEFAULT_MAX_TAKER_BUMP_FRAC, proportionalSellShares, idealHedgeSize } from "./copyTrade.js";

test("hedge size: percent 1.0 fully balances (100 main, 0 held → 100)", () => {
  assert.equal(idealHedgeSize(100, 0, 1), 100);
});
test("hedge size: percent 0.5 targets half the main (100 main → 50)", () => {
  assert.equal(idealHedgeSize(100, 0, 0.5), 50);
});
test("hedge size: subtracts already-held hedge shares (target 50, held 20 → 30 more)", () => {
  assert.equal(idealHedgeSize(100, 20, 0.5), 30);
});
test("hedge size: already at/over target → 0 (never adds; stops over-hedge)", () => {
  assert.equal(idealHedgeSize(52, 800, 0.5), 52 * 0.5 - 800); // negative → caller treats <=0 as none
  assert.ok(idealHedgeSize(52, 800, 0.5) <= 0);
});
test("hedge size: no main position → 0", () => {
  assert.equal(idealHedgeSize(0, 0, 0.5), 0);
});

test("proportional sell: target sold 10 of 100 (10%), we hold 90 → sell 9", () => {
  assert.equal(proportionalSellShares(10, 100, 90), 9);
});
test("proportional sell: target full exit (100 of 100) → we sell all 90", () => {
  assert.equal(proportionalSellShares(100, 100, 90), 90);
});
test("proportional sell: target sold half → we sell half", () => {
  assert.equal(proportionalSellShares(50, 100, 90), 45);
});
test("proportional sell: unknown target holding (null) → full exit (safe default)", () => {
  assert.equal(proportionalSellShares(10, null, 90), 90);
});
test("proportional sell: fraction clamped to 1 if target sold ≥ held", () => {
  assert.equal(proportionalSellShares(120, 100, 90), 90);
});
test("proportional sell: zero/negative target holding → full exit", () => {
  assert.equal(proportionalSellShares(10, 0, 90), 90);
});
import type { TickSize } from "@polymarket/clob-client-v2";

const T01 = "0.01" as TickSize; // 1¢ tick
const T001 = "0.001" as TickSize; // 0.1¢ tick

// helper: base limit is roundUp(ask) at the tick (what the code passes in)
const base = (ask: number, tick: TickSize) => applyTakerBump(ask, ask, tick, undefined, undefined);

test("disabled (no takerBump) → base limit unchanged", () => {
  assert.equal(applyTakerBump(0.58, 0.58, T01, undefined, 0.1), 0.58);
  assert.equal(applyTakerBump(0.58, 0.58, T01, 0, 0.1), 0.58);
});

test("high price: full bump applies (fine-tick)", () => {
  // ask 0.58, bump 0.02, cap 0.058 → effBump 0.02 → 0.60
  const p = applyTakerBump(0.58, 0.58, T001, 0.02, 0.1);
  assert.ok(Math.abs(p - 0.6) < 1e-9, `got ${p}`);
});

test("high price with 1¢ tick: bump rounds to a tick and stays within cap", () => {
  // ask 0.58 + 0.02 = 0.60, tick 0.01 → 0.60; cap allows up to 0.638 → ok
  assert.ok(Math.abs(applyTakerBump(0.58, 0.58, T01, 0.02, 0.1) - 0.6) < 1e-9);
});

test("low price fine-tick: cap shrinks the bump", () => {
  // ask 0.10, cap 0.10*0.1=0.01 → effBump min(0.02,0.01)=0.01 → 0.11
  const p = applyTakerBump(0.1, 0.1, T001, 0.02, 0.1);
  assert.ok(Math.abs(p - 0.11) < 1e-9, `got ${p}`);
});

test("very low price with COARSE 1¢ tick: one tick exceeds cap → fall back to ask (no overpay)", () => {
  // ask 0.01, cap 0.001 → bump target 0.011, roundUp@0.01 = 0.02 = 100% overpay > cap 0.011 → base
  assert.equal(applyTakerBump(0.01, 0.01, T01, 0.02, 0.1), 0.01);
});

test("very low price with FINE tick: 1.1¢ is valid and within cap → crosses", () => {
  // ask 0.01, tick 0.001 → 0.011 within cap (0.011) → posts 0.011
  const p = applyTakerBump(0.01, 0.01, T001, 0.02, 0.1);
  assert.ok(Math.abs(p - 0.011) < 1e-9, `got ${p}`);
});

test("default frac used when max_taker_bump_frac omitted", () => {
  assert.equal(DEFAULT_MAX_TAKER_BUMP_FRAC, 0.1);
  // ask 0.10, default cap 0.01 → 0.11
  const p = applyTakerBump(0.1, 0.1, T001, 0.02, undefined);
  assert.ok(Math.abs(p - 0.11) < 1e-9, `got ${p}`);
});

test("never returns below base limit", () => {
  // if base limit already above ask+bump (shouldn't happen, but guard), keep base
  assert.equal(applyTakerBump(0.58, 0.99, T01, 0.02, 0.1), 0.99);
});

test("base helper sanity (no-op)", () => {
  assert.equal(base(0.42, T01), 0.42);
});
