import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTargetStop } from "./drawdownGuard.js";

test("no limits set → never stops", () => {
  assert.equal(evaluateTargetStop(-1000, -1000, undefined, undefined), null);
});

test("total limit: stops when all-time loss reaches the cap", () => {
  assert.equal(evaluateTargetStop(-49, 0, 50, undefined), null); // within
  assert.notEqual(evaluateTargetStop(-50, 0, 50, undefined), null); // at cap → stop
  assert.notEqual(evaluateTargetStop(-51, 0, 50, undefined), null); // beyond → stop
});

test("daily limit: stops when today's loss reaches the cap", () => {
  assert.equal(evaluateTargetStop(0, -19.99, undefined, 20), null);
  assert.notEqual(evaluateTargetStop(0, -20, undefined, 20), null);
});

test("total limit takes precedence and is reported", () => {
  const r = evaluateTargetStop(-100, -100, 50, 20);
  assert.match(r ?? "", /all-time/);
});

test("profit or small loss within both limits → no stop", () => {
  assert.equal(evaluateTargetStop(120, 30, 50, 20), null);
  assert.equal(evaluateTargetStop(-10, -5, 50, 20), null);
});

test("only daily breached (total fine) → daily stop", () => {
  const r = evaluateTargetStop(-10, -25, 50, 20);
  assert.match(r ?? "", /UTC day/);
});
