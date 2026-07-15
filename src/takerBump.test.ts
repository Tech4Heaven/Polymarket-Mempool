import assert from "node:assert/strict";
import test from "node:test";
import { applyTakerBump, DEFAULT_MAX_TAKER_BUMP_FRAC } from "./copyTrade.js";
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
