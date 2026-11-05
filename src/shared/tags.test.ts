import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_TAG_LENGTH,
  MAX_TAGS_IN_FILTER,
  MAX_TAGS_PER_THREAD,
  matchesTagFilter,
  normalizeTag,
  normalizeTags,
  parseTagFilter,
} from "./tags.js";

test("a tag is trimmed, collapsed, lowercased, and validated", () => {
  assert.equal(normalizeTag("  Release   Notes "), "release notes");
  assert.equal(normalizeTag("v2.1_final-draft"), "v2.1_final-draft");
  assert.equal(normalizeTag("Über"), "über");
  assert.equal(normalizeTag(""), null);
  assert.equal(normalizeTag("   "), null);
  assert.equal(normalizeTag("-leading"), null);
  assert.equal(normalizeTag("with/slash"), null);
  assert.equal(normalizeTag("with#hash"), null);
  assert.equal(normalizeTag("a".repeat(MAX_TAG_LENGTH)), "a".repeat(MAX_TAG_LENGTH));
  assert.equal(normalizeTag("a".repeat(MAX_TAG_LENGTH + 1)), null);
});

test("a tag list keeps valid unique tags in order and caps at ten", () => {
  assert.deepEqual(normalizeTags(["A", "b", "a", " bad/slash ", "C"]), ["a", "b", "c"]);
  assert.equal(normalizeTags(Array.from({ length: 30 }, (_, index) => `tag ${index}`)).length, MAX_TAGS_PER_THREAD);
  assert.deepEqual(normalizeTags("not-a-list"), []);
  assert.deepEqual(normalizeTags([1, null, "ok"]), ["ok"]);
});

test("a stored filter is normalized and bounded; anything unusable is rejected", () => {
  assert.deepEqual(parseTagFilter({ tags: ["A", "a", "b", "x/y"], match: "all" }), { tags: ["a", "b"], match: "all" });
  assert.deepEqual(parseTagFilter({ tags: [] }), { tags: [], match: "any" });
  assert.deepEqual(parseTagFilter({ tags: [], match: "any" }), { tags: [], match: "any" });
  assert.equal(parseTagFilter({ tags: [], match: "some" }), null);
  assert.equal(parseTagFilter("nope"), null);
  assert.equal(parseTagFilter(null), null);
  const many = parseTagFilter({ tags: Array.from({ length: 50 }, (_, index) => `t${index}`), match: "any" });
  assert.equal(many?.tags.length, MAX_TAGS_IN_FILTER);
});

test("any/all filtering is an AND with the chat's own tags", () => {
  assert.equal(matchesTagFilter(["a", "b"], { tags: [], match: "any" }), true);
  assert.equal(matchesTagFilter(["a", "b"], { tags: ["b"], match: "any" }), true);
  assert.equal(matchesTagFilter(["a"], { tags: ["a", "b"], match: "any" }), true);
  assert.equal(matchesTagFilter(["a"], { tags: ["a", "b"], match: "all" }), false);
  assert.equal(matchesTagFilter(["a", "b"], { tags: ["a", "b"], match: "all" }), true);
});
