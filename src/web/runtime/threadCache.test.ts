/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { branchTail, clearThreadCache, readThread, sameRows, ServerRows, writeThread } from "./threadCache.js";

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

const msg = (id: string, parent_id: string | null, text = id) => ({ id, parent_id, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text }] } });

test("acknowledged writes extend the last loaded rows once none is in flight", () => {
  const server = new ServerRows();
  const token = server.beginLoad("t");
  assert.deepEqual(server.loaded("t", token, [msg("a", null), msg("b", "a")])?.map((r) => r.id), ["a", "b"]);
  server.beginWrite("t");
  server.beginWrite("t");
  assert.equal(server.acknowledged("t", msg("c", "b")), undefined, "a write is still in flight");
  const rows = server.acknowledged("t", msg("d", "c"));
  assert.deepEqual(rows?.map((r) => r.id), ["a", "b", "c", "d"]);
  assert.deepEqual(branchTail(rows!).map((r) => r.id), ["a", "b", "c", "d"]);
});

test("an upsert keeps the row's place, and an edit becomes the newest branch", () => {
  const server = new ServerRows();
  server.loaded("t", server.beginLoad("t"), [msg("a", null), msg("b", "a"), msg("c", "b")]);
  server.beginWrite("t");
  let rows = server.acknowledged("t", msg("b", "a", "tool result landed"))!;
  assert.deepEqual(rows.map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual((rows[1]!.content as { parts: Array<{ text: string }> }).parts[0]!.text, "tool result landed");
  // Editing b writes a sibling under a; the cache then shows the edited branch.
  server.beginWrite("t");
  rows = server.acknowledged("t", msg("b2", "a"))!;
  assert.deepEqual(branchTail(rows).map((r) => r.id), ["a", "b2"]);
});

test("a failed write drops the entry until the next load", () => {
  const server = new ServerRows();
  server.loaded("t", server.beginLoad("t"), [msg("a", null)]);
  server.beginWrite("t");
  assert.equal(server.failed("t"), null);
  server.beginWrite("t");
  assert.equal(server.acknowledged("t", msg("b", "a")), null, "rows are unknown after a failure");
  const rows = server.loaded("t", server.beginLoad("t"), [msg("a", null), msg("b", "a")]);
  assert.deepEqual(rows?.map((r) => r.id), ["a", "b"]);
});

test("a load that a write may have overtaken is not stored", () => {
  const server = new ServerRows();
  server.loaded("t", server.beginLoad("t"), [msg("a", null)]);
  // Started before a write: the server may have read before the write landed.
  const before = server.beginLoad("t");
  server.beginWrite("t");
  // Started while the write was in flight.
  const during = server.beginLoad("t");
  assert.deepEqual(server.acknowledged("t", msg("b", "a"))?.map((r) => r.id), ["a", "b"]);
  assert.equal(server.loaded("t", before, [msg("a", null)]), undefined);
  assert.equal(server.loaded("t", during, [msg("a", null)]), undefined);
  // The acknowledged state survives the outdated answers.
  server.beginWrite("t");
  assert.deepEqual(server.acknowledged("t", msg("c", "b"))?.map((r) => r.id), ["a", "b", "c"]);
});

test("chats are never cached from writes before their rows are known", () => {
  const server = new ServerRows();
  server.beginWrite("unknown");
  assert.equal(server.acknowledged("unknown", msg("a", null)), null);
  server.created("new");
  server.beginWrite("new");
  assert.deepEqual(server.acknowledged("new", msg("a", null))?.map((r) => r.id), ["a"]);
});

test("the cache stays bounded to the newest 20 rows of the branch after many writes", () => {
  const server = new ServerRows();
  server.created("t");
  let rows: ReturnType<ServerRows["acknowledged"]>;
  for (let i = 0; i < 50; i++) {
    server.beginWrite("t");
    rows = server.acknowledged("t", msg(`m${i}`, i ? `m${i - 1}` : null));
  }
  const tail = branchTail(rows!);
  assert.equal(tail.length, 20);
  assert.equal(tail[0]?.id, "m30");
});

test("sameRows compares content, not only ids", () => {
  const rows = [msg("a", null), msg("b", "a")];
  assert.equal(sameRows(rows, structuredClone(rows)), true);
  assert.equal(sameRows(rows, [msg("a", null), msg("b", "a", "changed")]), false);
  assert.equal(sameRows(rows.slice(1), rows), false);
});

// Last: sign-out closes the cache for the rest of the page.
test("after sign-out, a late write cannot recreate the cache", async () => {
  const opened: string[] = [];
  const request = () => {
    const req: Record<string, unknown> = {};
    queueMicrotask(() => (req.onsuccess as (() => void) | undefined)?.());
    return req;
  };
  Object.defineProperty(globalThis, "indexedDB", { value: { open: (name: string) => (opened.push(name), request()), deleteDatabase: () => request() }, configurable: true });
  await clearThreadCache();
  await writeThread("t", [msg("a", null)], Date.now());
  assert.equal(await readThread("t"), undefined);
  assert.deepEqual(opened, []);
});
