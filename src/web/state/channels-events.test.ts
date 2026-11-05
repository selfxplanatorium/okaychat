import assert from "node:assert/strict";
import { test } from "node:test";
import { SseParser, parseFrame } from "./channels-events";

test("SSE parsing survives fragmented UTF-8, CRLF, comments, and multiline data", () => {
  const parser = new SseParser();
  const first = parser.push('retry: 3000\r\n\r\nevent: ready\r\ndata: {"v":1}\r\n\r\n: hear');
  assert.deepEqual(first.map((frame) => frame.event), ["ready"]);
  const second = parser.push('tbeat\n\nid: abc\nevent: message.changed\ndata: {"channelId":"c",\ndata: "entityId":"m"}\n\n');
  assert.equal(second.length, 1);
  assert.equal(second[0]!.id, "abc");
  assert.equal(second[0]!.event, "message.changed");
  assert.equal(second[0]!.data, '{"channelId":"c",\n"entityId":"m"}');
  assert.deepEqual(parser.flush(), []);
});

test("a frame without an event but with data is kept, and comments alone are ignored", () => {
  assert.deepEqual(parseFrame("data: hello\n"), { data: "hello" });
  assert.equal(parseFrame(": comment only\n"), null);
});

test("an oversized unterminated frame is rejected instead of buffered forever", () => {
  const parser = new SseParser();
  assert.throws(() => parser.push("data: " + "x".repeat(300_000)), /frame too large/);
});

// --- Ephemeral frames and the visible polling fallback -------------------------------------------

function withDom(run: () => Promise<void>): Promise<void> {
  const listeners = new Map<string, Set<() => void>>();
  const doc = {
    visibilityState: "visible" as "visible" | "hidden",
    addEventListener: (type: string, fn: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    },
  };
  const win = { addEventListener: doc.addEventListener, removeEventListener: doc.removeEventListener };
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  return run().finally(() => {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
  });
}

const encoder = new TextEncoder();
function eventStream(chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const CAPABILITY = { v: 1, ephemeral: { v: 1, connectionId: "c".repeat(43), activityLeaseMs: 75_000, typingLeaseMs: 6_000 } };

test("idless ephemeral frames never reach the durable handler, cursor, or old clients", async () => {
  await withDom(async () => {
    const ready: unknown[] = [];
    const ephemeral: unknown[] = [];
    const invalid: string[] = [];
    const durable: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      eventStream([
        `retry: 3000\n\nevent: ready\ndata: ${JSON.stringify(CAPABILITY)}\n\n`,
        'event: ephemeral\ndata: {"v":1,"kind":"snapshot","watchRevision":3,"channelId":"c1","presence":[],"typing":[]}\n\n',
        'event: ephemeral\nid: abc\ndata: {"v":1,"kind":"clear","watchRevision":3}\n\n',
        `event: ephemeral\ndata: {"v":2,"kind":"snapshot"}\n\n`,
        'id: cursor-1\nevent: message.changed\ndata: {"type":"message.changed","channelId":"c1","entityId":"m1"}\n\n',
      ])) as typeof fetch;
    const { startChannelTransport } = await import("./channels-events.js");
    const handle = startChannelTransport({
      getCursor: () => undefined,
      onFrames: (frames) => durable.push(...frames.map((frame) => frame.event.type)),
      onReset: () => {},
      onRevoked: () => {},
      onState: () => {},
      onSyncRequested: () => {},
      onReady: (capability) => ready.push(capability),
      onEphemeral: (payload) => ephemeral.push(payload),
      onEphemeralInvalid: () => invalid.push("invalid"),
    });
    try {
      const deadline = Date.now() + 3_000;
      while (!durable.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(ready, [{ connectionId: CAPABILITY.ephemeral.connectionId, activityLeaseMs: 75_000, typingLeaseMs: 6_000 }]);
      assert.equal(ephemeral.length, 2);
      assert.equal((ephemeral[0] as { kind: string }).kind, "snapshot");
      assert.equal(invalid.length, 1, "an id-bearing frame is dropped without touching indicators twice");
      assert.deepEqual(durable, ["message.changed"]);
    } finally {
      handle.stop();
      globalThis.fetch = originalFetch;
    }
  });
});

test("an old server's ready payload leaves indicators disabled without an error", async () => {
  await withDom(async () => {
    const ready: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => eventStream(['event: ready\ndata: {"v":1}\n\n'])) as typeof fetch;
    const { startChannelTransport } = await import("./channels-events.js");
    const handle = startChannelTransport({
      getCursor: () => undefined,
      onFrames: () => {},
      onReset: () => {},
      onRevoked: () => {},
      onState: () => {},
      onSyncRequested: () => {},
      onReady: (capability) => ready.push(capability),
    });
    try {
      const deadline = Date.now() + 2_000;
      while (!ready.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(ready, [null]);
    } finally {
      handle.stop();
      globalThis.fetch = originalFetch;
    }
  });
});

test("an oversized ephemeral frame is rejected whole", async () => {
  await withDom(async () => {
    const invalid: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      eventStream([
        `event: ready\ndata: ${JSON.stringify(CAPABILITY)}\n\n`,
        `event: ephemeral\ndata: {"v":1,"kind":"snapshot","watchRevision":1,"channelId":"c1","presence":[],"typing":[],"pad":"${"x".repeat(70_000)}"}\n\n`,
      ])) as typeof fetch;
    const { startChannelTransport } = await import("./channels-events.js");
    const handle = startChannelTransport({
      getCursor: () => undefined,
      onFrames: () => {},
      onReset: () => {},
      onRevoked: () => {},
      onState: () => {},
      onSyncRequested: () => {},
      onEphemeralInvalid: () => invalid.push("invalid"),
    });
    try {
      const deadline = Date.now() + 2_000;
      while (!invalid.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(invalid.length, 1);
    } finally {
      handle.stop();
      globalThis.fetch = originalFetch;
    }
  });
});

test("a 429 cooldown polls on an interval instead of a request loop, then retries SSE", async (t) => {
  await withDom(async () => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("busy", { status: 429, headers: { "retry-after": "60" } });
    }) as typeof fetch;
    const { startChannelTransport } = await import("./channels-events.js");
    const handle = startChannelTransport({
      getCursor: () => "cursor",
      onFrames: () => {},
      onReset: () => {},
      onRevoked: () => {},
      onState: () => {},
      onSyncRequested: () => {},
    });
    const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
    try {
      await settle();
      assert.equal(calls, 1, "the first stream attempt is refused");
      // Inside the outage the cooldown polls at most once per five seconds, never in a loop.
      for (let second = 1; second <= 20; second++) {
        t.mock.timers.tick(1_000);
        await settle();
        assert.ok(calls <= 1 + Math.ceil(second / 5), `calls=${calls} after ${second}s`);
      }
      const beforeCooldownEnd = calls;
      t.mock.timers.tick(60_000);
      await settle();
      assert.ok(calls > beforeCooldownEnd, "the cooldown ends in another SSE attempt");
    } finally {
      handle.stop();
      globalThis.fetch = originalFetch;
      t.mock.timers.reset();
    }
  });
});
