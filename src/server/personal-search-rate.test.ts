import assert from "node:assert/strict";
import { test } from "node:test";
import { admitPersonalSearch, resetPersonalSearchRate } from "./personal-search-rate.js";

test("personal search admits a bounded burst per account", () => {
  resetPersonalSearchRate();
  const now = 1_000_000;
  for (let i = 0; i < 120; i++) assert.equal(admitPersonalSearch("a", now + i).ok, true);
  assert.equal(admitPersonalSearch("a", now + 120).ok, false);
  assert.equal(admitPersonalSearch("b", now + 120).ok, true, "another account keeps its own budget");
  assert.equal(admitPersonalSearch("a", now + 60_001).ok, true, "the window resets");
  resetPersonalSearchRate();
});
