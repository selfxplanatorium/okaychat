/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { branchTail } from "./threadCache.js";

const row = (id: string, parent_id: string | null) => ({ id, parent_id });

test("branchTail keeps the newest message's branch and drops siblings", () => {
  // b2 is an edited sibling of b; the newest row d sits on the b2 branch.
  const rows = [row("a", null), row("b", "a"), row("c", "b"), row("b2", "a"), row("d", "b2")];
  assert.deepEqual(branchTail(rows).map((r) => r.id), ["a", "b2", "d"]);
});

test("branchTail cuts long chats to the newest 20 and makes the first kept row a root", () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(`m${i}`, i ? `m${i - 1}` : null));
  const tail = branchTail(rows);
  assert.equal(tail.length, 20);
  assert.equal(tail[0]?.id, "m10");
  assert.equal(tail[0]?.parent_id, null);
  assert.equal(tail[1]?.parent_id, "m10");
  assert.equal(rows[10]?.parent_id, "m9", "the server rows are not mutated");
});
