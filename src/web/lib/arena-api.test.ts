import assert from "node:assert/strict";
import { test } from "node:test";
import { subscribeArenaEvents, readArenaMode, readPendingArenaMutation } from "./arena-api.js";
import type { BattleView } from "@shared/arena";
const base: BattleView = { visibility: "blind", id: "battle", mode: "personal", state: "running", createdAt: 1, contentExpiresAt: 10, canVote: false, panes: [{ side: "A", state: "running", text: "" }, { side: "B", state: "running", text: "" }] };

test("Arena SSE parses split UTF-8 and bounded large snapshots, keeping A/B deltas ordered", async t => {
  const snapshot = { ...base, prompt: "p".repeat(20000), panes: base.panes.map(p => ({ ...p, text: "x".repeat(32768) })) };
  const wire = new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({ battle: snapshot })}\n\nevent: text\ndata: ${JSON.stringify({ side: "A", delta: "Hello 🌍" })}\n\nevent: text\ndata: ${JSON.stringify({ side: "B", delta: "Bonjour" })}\n\nevent: battle\ndata: {"state":"ready","canVote":true}\n\n`);
  let offset = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ pull(c) { if (offset >= wire.length) return c.close(); const end = Math.min(offset + 127, wire.length); c.enqueue(wire.subarray(offset, end)); offset = end; } })));
  const events: unknown[] = [];
  await subscribeArenaEvents("battle", { onSnapshot: b => events.push(b), onText: (s, d) => events.push([s, d]), onState: s => events.push(s), onPane: () => {}, onError: () => {}, onEnd: () => events.push("end") }, new AbortController().signal);
  assert.deepEqual(events, [snapshot, ["A", "Hello 🌍"], ["B", "Bonjour"], { state: "ready", canVote: true }, "end"]);
});

test("Arena malformed/oversized frames cancel the attachment rather than leaving it reading", async t => {
  for (const data of ["{bad JSON", JSON.stringify({ side: "A", delta: "x".repeat(8193) })]) {
    let cancelled = false;
    t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`event: text\ndata: ${data}\n\n`)); }, cancel() { cancelled = true; } })));
    await assert.rejects(subscribeArenaEvents("battle", { onSnapshot: () => {}, onText: () => assert.fail("oversized delta delivered"), onState: () => {}, onPane: () => {}, onError: () => {} }, new AbortController().signal));
    assert.equal(cancelled, true);
  }
});

test("Arena device state tolerates blocked storage without retaining prompts or assignments", () => {
  assert.equal(readArenaMode("owner"), null);
  assert.equal(readPendingArenaMutation("owner"), null);
});
