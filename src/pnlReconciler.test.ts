import assert from "node:assert/strict";
import test from "node:test";
import { computeTargetPnl } from "./pnlReconciler.js";
import type { LedgerRecord } from "./orderLedger.js";

function rec(p: Partial<LedgerRecord>): LedgerRecord {
  return {
    ts: 0,
    orderId: "0x",
    target: "0xT",
    conditionId: "0xC",
    tokenId: "1",
    outcome: "Up",
    side: "buy",
    isHedge: false,
    filledShares: 0,
    filledUsdc: 0,
    limitPrice: 0.5,
    event: "M",
    ...p,
  };
}

test("winning buy: payout = shares, pnl = shares - cost", () => {
  const r = computeTargetPnl([rec({ outcome: "Up", side: "buy", filledShares: 100, filledUsdc: 40 })], "Up");
  assert.equal(r.payout, 100);
  assert.equal(r.netUsdc, 40);
  assert.equal(r.pnl, 60);
});

test("losing buy: payout 0, pnl = -cost", () => {
  const r = computeTargetPnl([rec({ outcome: "Up", side: "buy", filledShares: 100, filledUsdc: 40 })], "Down");
  assert.equal(r.payout, 0);
  assert.equal(r.pnl, -40);
});

test("buy then partial sell of same outcome nets shares and cash", () => {
  const r = computeTargetPnl(
    [
      rec({ outcome: "Up", side: "buy", filledShares: 100, filledUsdc: 40 }),
      rec({ outcome: "Up", side: "sell", filledShares: 40, filledUsdc: 24 }),
    ],
    "Up"
  );
  // net 60 winning shares held, net cash out 40-24=16 → pnl 60-16=44
  assert.equal(r.payout, 60);
  assert.equal(r.netUsdc, 16);
  assert.equal(r.pnl, 44);
});

test("hedge leg on the winning side pays out (folds in as a buy)", () => {
  // copied Up (lost), hedge Down (won) — hedge shares pay $1
  const r = computeTargetPnl(
    [
      rec({ outcome: "Up", side: "buy", isHedge: false, filledShares: 100, filledUsdc: 55 }),
      rec({ outcome: "Down", side: "buy", isHedge: true, filledShares: 100, filledUsdc: 10 }),
    ],
    "Down"
  );
  // Down 100 shares win → payout 100; cost 55+10=65 → pnl 35
  assert.equal(r.payout, 100);
  assert.equal(r.netUsdc, 65);
  assert.equal(r.pnl, 35);
});

test("multi-fill same side aggregates", () => {
  const r = computeTargetPnl(
    [
      rec({ outcome: "Down", side: "buy", filledShares: 60, filledUsdc: 30 }),
      rec({ outcome: "Down", side: "buy", filledShares: 40, filledUsdc: 22 }),
    ],
    "Down"
  );
  assert.equal(r.payout, 100);
  assert.equal(r.netUsdc, 52);
  assert.equal(r.pnl, 48);
});

test("unfilled resting order (0/0) contributes nothing", () => {
  const r = computeTargetPnl(
    [
      rec({ outcome: "Up", side: "buy", filledShares: 0, filledUsdc: 0 }),
      rec({ outcome: "Up", side: "buy", filledShares: 50, filledUsdc: 20 }),
    ],
    "Up"
  );
  assert.equal(r.payout, 50);
  assert.equal(r.pnl, 30);
});

test("regression: resting order that truly filled → real win (was reported $0)", () => {
  // The bug: order logged filled=0 (resting), then filled 122.3 Up @0.30 and Up won.
  // Reconciler now feeds the TRUE fill (from getOrder) here, so it must show the ~+$85.6 win,
  // not $0. cost = 122.3*0.30 = 36.69, payout = 122.3.
  const r = computeTargetPnl([rec({ outcome: "Up", side: "buy", filledShares: 122.3, filledUsdc: 36.69 })], "Up");
  assert.ok(Math.abs(r.pnl - 85.61) < 0.02, `expected ~+85.6, got ${r.pnl}`);
});

test("oversold outcome (sold more than bought) yields NET-NEGATIVE shares — the phantom-win tell", () => {
  // Real incident: ledger had only 95 of the 652 Down buys, but the full 473 Down sell. Raw math
  // books a phantom +$385 "win" ($0 payout, negative cost). The reconciler now DETECTS this via the
  // net-negative shares and falls back to the on-chain total instead of trusting it.
  const trs = [
    rec({ outcome: "Down", side: "buy", filledShares: 95, filledUsdc: 50.35 }),
    rec({ outcome: "Down", side: "sell", filledShares: 473, filledUsdc: 435.16 }),
  ];
  const r = computeTargetPnl(trs, "Down");
  assert.ok(r.pnl > 380, `raw math fabricates the win (${r.pnl.toFixed(2)}) — hence the guard`);
  assert.ok((r.netSharesByOutcome.get("Down") ?? 0) < -1, "net Down shares must be < -1 so the guard trips");
});

test("net negative shares clamp to 0 payout", () => {
  // defensive: over-refund / accounting drift shouldn't create phantom payout
  const r = computeTargetPnl([rec({ outcome: "Up", side: "sell", filledShares: 10, filledUsdc: 5 })], "Up");
  assert.equal(r.payout, 0);
  assert.equal(r.pnl, 5); // received $5, no shares
});
