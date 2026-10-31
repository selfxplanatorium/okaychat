/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { resampleInt16 } from "./media";

test("identical rates return the same samples", () => {
  const input = Int16Array.from([1, -2, 3]);
  assert.deepEqual([...resampleInt16(input, 16_000, 16_000)], [1, -2, 3]);
});

test("downsampling keeps the length right and does not invent silence", () => {
  const input = new Int16Array(480).fill(1000);
  const out = resampleInt16(input, 48_000, 16_000);
  assert.equal(out.length, 160);
  assert.ok(out.every((value) => value === 1000));
});

test("upsampling interpolates between samples", () => {
  const out = resampleInt16(Int16Array.from([0, 1000]), 16_000, 32_000);
  assert.equal(out.length, 4);
  assert.equal(out[0], 0);
  assert.equal(out[3], 1000);
  assert.equal(out[1]! > 0 && out[1]! < 1000, true);
});
