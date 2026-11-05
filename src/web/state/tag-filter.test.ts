import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

// The store touches localStorage only inside its helpers; a tiny in-memory implementation keeps the
// test free of a DOM.
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});

const { matchesTagFilter, readStoredTagFilter, useTagFilter, writeStoredTagFilter } = await import("./tag-filter.js");

beforeEach(() => store.clear());

test("the filter round-trips through localStorage and malformed payloads read as empty", () => {
  writeStoredTagFilter("u1", { tags: ["release", "notes"], match: "all" });
  assert.deepEqual(readStoredTagFilter("u1"), { tags: ["release", "notes"], match: "all" });
  store.set("okaychat:tag-filter:u1", "{not json");
  assert.deepEqual(readStoredTagFilter("u1"), { tags: [], match: "any" });
  store.set("okaychat:tag-filter:u1", JSON.stringify({ tags: ["a"], match: "some" }));
  assert.deepEqual(readStoredTagFilter("u1"), { tags: [], match: "any" });
  assert.deepEqual(readStoredTagFilter("missing"), { tags: [], match: "any" });
});

test("changing accounts drops the previous account's tags and filter", async () => {
  writeStoredTagFilter("u2", { tags: ["theirs"], match: "any" });
  useTagFilter.setState({ accountId: "u1", tags: [{ tag: "mine", count: 2 }], presets: [], filter: { tags: ["mine"], match: "all" } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch;
  try {
    const pending = useTagFilter.getState().load("u2");
    // The switch is synchronous; only the server answers later.
    assert.equal(useTagFilter.getState().accountId, "u2");
    assert.deepEqual(useTagFilter.getState().tags, []);
    assert.deepEqual(useTagFilter.getState().filter, { tags: ["theirs"], match: "any" });
    await pending;
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the pure predicate is the one the sidebar uses", () => {
  assert.equal(matchesTagFilter(["a"], { tags: ["a", "b"], match: "all" }), false);
  assert.equal(matchesTagFilter(["a", "b"], { tags: ["a", "b"], match: "all" }), true);
  assert.equal(matchesTagFilter([], { tags: [], match: "any" }), true);
});
