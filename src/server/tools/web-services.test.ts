import assert from "node:assert/strict";
import { test } from "node:test";

process.env.OKAYCHAT_SEARXNG_URL = "http://search-sidecar.test";
const { webSearch } = await import("./web.js");
const { reportServiceFailure, resetServicesForTests } = await import("../services.js");

test("a known SearXNG outage skips its request and keeps public search working", async (t) => {
  resetServicesForTests();
  reportServiceFailure("searxng");
  const requested: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return new Response('<div data-type="web"><a href="https://example.com"><span class="title">A result</span></a><p class="snippet-description">A snippet</p></div>');
  });
  try {
    const result = await webSearch("hello");
    assert.equal(result.engine, "brave");
    assert.equal(result.results.length, 1);
    assert.equal(requested.length, 1);
    assert.ok(requested[0]!.startsWith("https://search.brave.com/"));
  } finally {
    resetServicesForTests();
  }
});
