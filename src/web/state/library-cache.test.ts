/// <reference types="node" />
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { LibraryPage } from "../../shared/types.js";
import { cachedLibraryPage, fetchLibraryFirstPage, forgetLibraryPages, setLibraryAccount } from "./library-cache.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  forgetLibraryPages();
});

test("an account switch discards cached pages and requests from the previous account", async () => {
  const pending: Array<(response: Response) => void> = [];
  globalThis.fetch = () => new Promise<Response>((resolve) => pending.push(resolve));
  const alice = { items: [{ id: "private-alice-file" }], nextCursor: null } as LibraryPage;
  const bob: LibraryPage = { items: [], nextCursor: null };
  setLibraryAccount("alice");
  const oldRequest = fetchLibraryFirstPage("sort=newest");
  setLibraryAccount("bob");
  const currentRequest = fetchLibraryFirstPage("sort=newest");
  assert.equal(pending.length, 2, "accounts must not share an in-flight request");
  pending[0]!(Response.json(alice));
  await oldRequest;
  assert.equal(cachedLibraryPage("sort=newest"), undefined);
  assert.equal(fetchLibraryFirstPage("sort=newest"), currentRequest, "the old request cannot clear the current one");
  pending[1]!(Response.json(bob));
  await currentRequest;
  assert.deepEqual(cachedLibraryPage("sort=newest"), bob);
  setLibraryAccount("alice");
  assert.equal(cachedLibraryPage("sort=newest"), undefined);
});

test("deletion invalidation prevents an older fetch from restoring removed files", async () => {
  let finish!: (response: Response) => void;
  globalThis.fetch = () => new Promise<Response>((resolve) => { finish = resolve; });
  const request = fetchLibraryFirstPage("sort=newest");
  forgetLibraryPages();
  finish(Response.json({ items: [{ id: "deleted" }], nextCursor: null }));
  await request;
  assert.equal(cachedLibraryPage("sort=newest"), undefined);
});
