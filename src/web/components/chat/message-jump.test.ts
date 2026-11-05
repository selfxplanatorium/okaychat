/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { isMounted, jumpIndex, widenForJump } from "./message-jump.js";

const ids = ["a", "b", "c", "d", "e"];
const bounds = { start: 3, floor: 1 };

test("a jump only resolves against the displayed branch", () => {
  assert.equal(jumpIndex(ids, "b"), 1);
  assert.equal(jumpIndex(ids, "from-the-other-branch"), -1);
});

test("widening lowers both bounds and never raises one", () => {
  assert.deepEqual(widenForJump({ start: 3, floor: 1 }, 2), { start: 2, floor: 1 });
  assert.deepEqual(widenForJump({ start: 3, floor: 1 }, 0), { start: 0, floor: 0 });
  assert.deepEqual(widenForJump({ start: 3, floor: 1 }, 4), { start: 3, floor: 1 }, "a mounted target changes nothing");
});

test("mounted means at or after the first rendered index", () => {
  assert.equal(isMounted({ start: 3, floor: 1 }, 3), true);
  assert.equal(isMounted({ start: 3, floor: 1 }, 2), false);
  assert.equal(isMounted({ start: 0, floor: 0 }, 0), true);
  assert.equal(bounds.start, 3);
});
