/// <reference types="node" />
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import type { MessageFeedback, ThreadAnnotations } from "../../shared/message-annotations.js";

const realFetch = globalThis.fetch;
type Pending = { path: string; method: string; resolve: (body: unknown, status?: number) => void };
let pending: Pending[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = ((input: string, init?: RequestInit) =>
  new Promise((resolve) => {
    pending.push({ path: input, method: init?.method ?? "GET", resolve: (body, status) => resolve(json(body, status)) });
  })) as typeof fetch;

const {
  dropThreadAnnotations,
  feedbackRevision,
  loadThreadAnnotations,
  saveFeedback,
  setAnnotationsAccount,
  setBookmark,
  useAnnotations,
} = await import("./message-annotations.js");

const feedback = (messageId: string, revision = 1, rating: MessageFeedback["rating"] = "positive"): MessageFeedback => ({
  messageId,
  rating,
  comment: null,
  revision,
  messageEditedAt: null,
  createdAt: 1,
  updatedAt: 1,
});
const empty: ThreadAnnotations = { bookmarks: [], feedback: [] };
const thread = (id: string) => useAnnotations.getState().threads[id];

beforeEach(() => {
  pending = [];
  setAnnotationsAccount(null);
  setAnnotationsAccount("alice");
});
afterEach(() => setAnnotationsAccount(null));
after(() => {
  globalThis.fetch = realFetch;
});

test("one GET per chat is shared and populates bookmark and feedback maps", async () => {
  const first = loadThreadAnnotations("thr_1");
  const second = loadThreadAnnotations("thr_1");
  assert.equal(pending.length, 1);
  assert.equal(first, second);
  pending[0]!.resolve({ bookmarks: [{ messageId: "a", createdAt: 1 }], feedback: [feedback("a")] });
  await first;
  assert.equal(thread("thr_1")?.bookmarks.a?.createdAt, 1);
  assert.equal(feedbackRevision("thr_1", "a"), 1);
  assert.equal(thread("thr_1")?.loaded, true);
  await loadThreadAnnotations("thr_1");
  assert.equal(pending.length, 1, "a loaded chat is not fetched again");
});

test("a previous account's annotations never reach the store", async () => {
  const old = loadThreadAnnotations("thr_1");
  setAnnotationsAccount("bob");
  pending[0]!.resolve({ bookmarks: [{ messageId: "a", createdAt: 1 }], feedback: [] });
  await old;
  assert.equal(thread("thr_1"), undefined);
  const current = loadThreadAnnotations("thr_1");
  pending[1]!.resolve(empty);
  await current;
  assert.deepEqual(thread("thr_1")?.bookmarks, {});
});

test("an older GET cannot bring back state after an acknowledged bookmark write", async () => {
  const load = loadThreadAnnotations("thr_1");
  const write = setBookmark("thr_1", "a", true);
  assert.equal(pending.length, 2);
  const put = pending[1]!;
  assert.equal(put.method, "PUT");
  put.resolve({ messageId: "a", createdAt: 2 });
  await write;
  assert.equal(thread("thr_1")?.bookmarks.a?.createdAt, 2);
  pending[0]!.resolve(empty);
  await load;
  assert.equal(thread("thr_1")?.bookmarks.a?.createdAt, 2, "the confirmed write wins");
  // The store re-asks once after the stale answer, so a chat first opened this way still gets its data.
  await new Promise((resolve) => setTimeout(resolve));
  assert.equal(pending.length, 3);
  pending[2]!.resolve(empty);
  await new Promise((resolve) => setTimeout(resolve));
});

test("writes are desired state, never a server toggle", async () => {
  const add = setBookmark("thr_1", "a", true);
  assert.equal(pending[0]!.method, "PUT");
  pending[0]!.resolve({ messageId: "a", createdAt: 1 });
  await add;
  const remove = setBookmark("thr_1", "a", false);
  assert.equal(pending[1]!.method, "DELETE");
  assert.equal(useAnnotations.getState().pending["bookmark thr_1 a"], true);
  pending[1]!.resolve({ ok: true });
  await remove;
  assert.equal(thread("thr_1")?.bookmarks.a, undefined);
  assert.equal(useAnnotations.getState().pending["bookmark thr_1 a"], undefined);
});

test("a failed write leaves no optimistic success behind", async () => {
  const add = setBookmark("thr_1", "a", true);
  pending[0]!.resolve({ error: "no" }, 500);
  await assert.rejects(add);
  assert.equal(thread("thr_1")?.bookmarks.a, undefined);
  assert.equal(useAnnotations.getState().pending["bookmark thr_1 a"], undefined);
});

test("a write that lands after the chat was deleted never resurrects its state", async () => {
  const add = setBookmark("thr_1", "a", true);
  dropThreadAnnotations("thr_1");
  pending[0]!.resolve({ messageId: "a", createdAt: 1 });
  await add;
  assert.equal(thread("thr_1"), undefined);
});

test("feedback keeps its confirmed revision, and deleting a chat drops everything", async () => {
  const save = saveFeedback("thr_1", "a", { rating: "positive", comment: null, expectedRevision: 0 });
  pending[0]!.resolve(feedback("a", 1));
  assert.equal((await save).revision, 1);
  assert.equal(feedbackRevision("thr_1", "a"), 1);
  dropThreadAnnotations("thr_1");
  assert.equal(thread("thr_1"), undefined);
  assert.equal(feedbackRevision("thr_1", "a"), 0);
});
