/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ChannelActivityController, type ChannelActivityApi, type ChannelActivityView } from "./channel-activity";

/** Fake scheduler: timers run only when the test advances its clock, never in real time. */
function harness(api?: Partial<ChannelActivityApi>) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const calls: Array<{ kind: "activity" | "typing"; input: Record<string, unknown> }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let view: ChannelActivityView = {
    available: false,
    synchronized: false,
    channelId: null,
    rootId: null,
    presence: {},
    typing: {},
  };
  let reconnects = 0;
  let revision = 0;

  const defaultApi: ChannelActivityApi = {
    activity: async (input) => {
      calls.push({ kind: "activity", input: input as unknown as Record<string, unknown> });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await Promise.resolve();
        revision++;
        return { acceptedSeq: input.seq, watchRevision: revision };
      } finally {
        inFlight--;
      }
    },
    typing: async (input) => {
      calls.push({ kind: "typing", input: input as unknown as Record<string, unknown> });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await Promise.resolve();
        return { acceptedSeq: input.seq };
      } finally {
        inFlight--;
      }
    },
  };

  const controller = new ChannelActivityController({
    api: { ...defaultApi, ...api },
    now: () => now,
    schedule: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (handle) => {
      timers.delete(handle as unknown as number);
    },
    random: () => 0.5,
    onView: (next) => {
      view = next;
    },
    onReconnect: () => {
      reconnects++;
    },
  });

  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await settle();
    }
    now = target;
    await settle();
  };
  const settle = async () => {
    for (let index = 0; index < 20; index++) await Promise.resolve();
  };

  controller.setAvailable({
    connectionId: "c".repeat(43),
    activityLeaseMs: 75_000,
    typingLeaseMs: 6_000,
  });
  controller.setWatch("chan_1", null);

  return {
    controller,
    calls,
    advance,
    settle,
    get now() {
      return now;
    },
    get view() {
      return view;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    get reconnects() {
      return reconnects;
    },
    get watchRevision() {
      return revision;
    },
  };
}

const scope = { channelId: "chan_1", rootId: null as string | null };

function snapshot(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    v: 1,
    kind: "snapshot",
    watchRevision: 1,
    channelId: "chan_1",
    presence: [{ userId: "bob", state: "online" }],
    typing: [],
    ...overrides,
  };
}

test("ready sends one active state and the current watch, without waiting for input", async () => {
  const h = harness();
  await h.settle();
  const activities = h.calls.filter((call) => call.kind === "activity");
  assert.equal(activities.length, 2, "one for the initial state, one for the watch");
  assert.deepEqual(activities.at(-1)!.input.watch, { channelId: "chan_1", rootId: null });
  assert.equal(activities.at(-1)!.input.state, "active");
});

test("untrusted and synthetic signals never become activity", async () => {
  const h = harness();
  await h.settle();
  const before = h.calls.length;
  h.controller.signal(false);
  await h.settle();
  assert.equal(h.calls.length, before);
});

test("visible inactivity sends idle once at sixty seconds and does not loop", async () => {
  const h = harness();
  await h.settle();
  h.calls.length = 0;
  h.controller.signal(true);
  await h.advance(1_000);
  h.calls.length = 0;
  await h.advance(60_000);
  const activities = h.calls.filter((call) => call.kind === "activity");
  assert.ok(activities.length >= 1);
  assert.equal(activities.at(-1)!.input.state, "idle");
  const afterIdle = h.calls.length;
  await h.advance(120_000);
  assert.equal(h.calls.length, afterIdle, "an idle tab never starts a refresh loop");
});

test("typing refreshes no faster than three seconds, only after further input, and stops after four", async () => {
  const h = harness();
  await h.settle();
  h.calls.length = 0;
  h.controller.typingInput(scope, "hello");
  await h.settle();
  assert.deepEqual(h.calls.filter((call) => call.kind === "typing").map((call) => call.input.typing), [true]);

  await h.advance(1_000);
  h.controller.typingInput(scope, "hello!");
  await h.settle();
  assert.equal(h.calls.filter((call) => call.kind === "typing").length, 1, "a refresh inside three seconds is coalesced");

  await h.advance(2_500);
  h.controller.typingInput(scope, "hello!!");
  await h.settle();
  assert.equal(h.calls.filter((call) => call.kind === "typing").length, 2);

  await h.advance(4_000);
  const typing = h.calls.filter((call) => call.kind === "typing");
  assert.equal(typing.at(-1)!.input.typing, false, "silence stops the lease locally");
});

test("no typing starts from focus, an empty draft, or a different scope", async () => {
  const h = harness();
  await h.settle();
  h.calls.length = 0;
  h.controller.typingInput({ channelId: "chan_1", rootId: "root_9" }, "hello");
  h.controller.typingInput(scope, "");
  await h.settle();
  assert.equal(h.calls.filter((call) => call.kind === "typing").length, 0);
});

test("frames from another revision or channel are discarded, and the latest buffered frame wins", async () => {
  const h = harness();
  await h.settle();
  const revision = h.watchRevision;
  h.controller.receive(snapshot({ watchRevision: revision - 1 }));
  assert.equal(h.view.presence.bob, undefined);
  h.controller.receive(snapshot({ watchRevision: revision }));
  assert.equal(h.view.synchronized, true);
  assert.equal(h.view.presence.bob, "online");

  h.controller.receive(snapshot({ watchRevision: revision, channelId: "chan_2" }));
  assert.equal(h.view.channelId, "chan_1");
  h.controller.receive(snapshot({ watchRevision: revision, presence: [{ userId: "carol", state: "away" }] }));
  assert.equal(h.view.presence.carol, "away");

  // A new watch revision buffers at most the latest frame until its response establishes it.
  h.controller.setWatch("chan_1", "root_1");
  const next = h.watchRevision + 1;
  h.controller.receive(snapshot({ watchRevision: next, typing: [{ rootId: "root_1", userId: "bob", remainingMs: 3_000 }] }));
  h.controller.receive(snapshot({ watchRevision: next, typing: [{ rootId: "root_1", userId: "carol", remainingMs: 2_000 }] }));
  await h.advance(250);
  assert.deepEqual(h.view.typing["root_1"], ["carol"]);
});

test("room and thread typing sets are independent and patches replace only their scope", async () => {
  const h = harness();
  await h.settle();
  h.controller.receive(snapshot({
    watchRevision: h.watchRevision,
    typing: [
      { rootId: null, userId: "bob", remainingMs: 5_000 },
      { rootId: null, userId: "carol", remainingMs: 4_000 },
    ],
  }));
  assert.deepEqual(h.view.typing[""], ["bob", "carol"]);
  h.controller.receive({
    v: 1,
    kind: "patch",
    watchRevision: h.watchRevision,
    channelId: "chan_1",
    presence: [],
    typingScopes: [{ rootId: null, items: [{ userId: "bob", remainingMs: 2_000 }] }],
  });
  assert.deepEqual(h.view.typing[""], ["bob"]);
});

test("an unknown ephemeral version clears indicators but keeps the stream available", async () => {
  const h = harness();
  await h.settle();
  h.controller.receive(snapshot({ watchRevision: h.watchRevision }));
  assert.equal(h.view.synchronized, true);
  h.controller.receive({ v: 2, kind: "snapshot", presence: [{ userId: "bob", state: "online" }] });
  assert.equal(h.view.synchronized, false);
  assert.deepEqual(h.view.presence, {});
  assert.equal(h.view.available, true);
});

test("a lost stream clears the view, stops publishing, and re-enables only on the next ready", async () => {
  const h = harness();
  await h.settle();
  h.controller.receive(snapshot({ watchRevision: h.watchRevision }));
  h.controller.streamLost();
  assert.deepEqual(h.view, { available: false, synchronized: false, channelId: null, rootId: null, presence: {}, typing: {} });
  h.calls.length = 0;
  h.controller.typingInput(scope, "hello");
  h.controller.signal(true);
  await h.advance(30_000);
  assert.equal(h.calls.length, 0);
});

test("forty-five seconds without a state frame clears indicators and asks for a reconnect", async () => {
  const h = harness();
  await h.settle();
  h.controller.receive(snapshot({ watchRevision: h.watchRevision }));
  assert.equal(h.view.synchronized, true);
  await h.advance(46_000);
  assert.equal(h.view.synchronized, false);
  assert.equal(h.view.presence.bob, undefined);
  assert.ok(h.reconnects >= 1);
});

test("requests are serialized and a 429 cooldown sends only the latest state once", async () => {
  const seen: Array<Record<string, unknown>> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const h = harness({
    activity: async (input) => {
      seen.push(input as unknown as Record<string, unknown>);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await Promise.resolve();
        if (seen.length === 1) throw { status: 429, retryAfterMs: 5_000 };
        return { acceptedSeq: input.seq, watchRevision: 1 };
      } finally {
        inFlight--;
      }
    },
  });
  await h.settle();
  assert.equal(seen.length, 1);
  // Nothing is retried automatically inside the cooldown.
  h.controller.signal(true);
  await h.advance(1_000);
  assert.equal(seen.length, 1);
  await h.advance(5_000);
  assert.equal(seen.length, 2, "the latest state is sent once after the cooldown");
  assert.equal(seen.at(-1)!.state, "active");
  assert.equal(maxInFlight, 1);
});

test("no presence token, watch id or typing state is written to browser storage", () => {
  const source = readFileSync(join(import.meta.dirname, "channel-activity.ts"), "utf8");
  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "BroadcastChannel"]) {
    assert.ok(!source.includes(forbidden), `channel-activity must not use ${forbidden}`);
  }
});
