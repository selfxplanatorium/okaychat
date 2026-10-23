/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { pruneSelection, runBatch, toggleSelection } from "./selection.js";

const order = ["a", "b", "c", "d", "e"];

test("toggleSelection toggles one id without a range", () => {
  assert.deepEqual([...toggleSelection(new Set(), order, "c", "a", false)], ["c"]);
  assert.deepEqual([...toggleSelection(new Set(["c"]), order, "c", null, false)], []);
});

test("toggleSelection applies the clicked row's new state across the range", () => {
  assert.deepEqual([...toggleSelection(new Set(["a"]), order, "d", "a", true)].sort(), ["a", "b", "c", "d"]);
  // Upwards from the anchor too, and a range can clear rows.
  assert.deepEqual([...toggleSelection(new Set(["b", "c", "d", "e"]), order, "b", "d", true)], ["e"]);
});

test("toggleSelection falls back to one id when the anchor is gone", () => {
  assert.deepEqual([...toggleSelection(new Set(), order, "b", "zz", true)], ["b"]);
});

test("pruneSelection keeps the same set when nothing left", () => {
  const selected = new Set(["a", "c"]);
  assert.equal(pruneSelection(selected, order), selected);
  assert.deepEqual([...pruneSelection(selected, ["a"])], ["a"]);
});

test("runBatch reports failures and the first error", async () => {
  const seen: number[] = [];
  const { failed, error } = await runBatch([1, 2, 3, 4, 5, 6], async (n) => {
    seen.push(n);
    if (n % 2 === 0) throw new Error(`bad ${n}`);
  }, 2);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(failed.sort(), [2, 4, 6]);
  assert.match((error as Error).message, /^bad /);
});
