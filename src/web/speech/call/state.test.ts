/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { callReducer, initialCallState, isBusy } from "./state";

const run = (events: Parameters<typeof callReducer>[1][]) => events.reduce(callReducer, initialCallState("local"));

test("a call goes listening → thinking → speaking and ends", () => {
  let state = run([{ type: "open", engine: "local" }]);
  assert.equal(state.phase, "starting");
  state = callReducer(state, { type: "preparing" });
  assert.equal(state.phase, "preparing");
  state = callReducer(state, { type: "ready", engine: "local", voice: "en_US-lessac-medium" });
  assert.equal(state.phase, "listening");
  assert.equal(state.voice, "en_US-lessac-medium");
  state = callReducer(state, { type: "turn" });
  assert.equal(state.phase, "thinking");
  assert.equal(isBusy(state.phase), true);
  state = callReducer(state, { type: "speaking" });
  assert.equal(state.phase, "speaking");
  state = callReducer(state, { type: "listening" });
  assert.equal(state.phase, "listening");
  state = callReducer(state, { type: "end" });
  assert.equal(state.phase, "ended");
  assert.equal(state.muted, false);
  assert.equal(state.partial, "");
});

test("speaking is interrupted by the user and recovers on the next turn", () => {
  let state = run([
    { type: "open", engine: "local" },
    { type: "ready", engine: "local", voice: "v" },
    { type: "turn" },
    { type: "speaking" },
  ]);
  state = callReducer(state, { type: "interrupted" });
  assert.equal(state.phase, "interrupted");
  assert.equal(state.interrupted, true);
  // A late sentence from the cancelled reply cannot restart playback.
  assert.equal(callReducer(state, { type: "speaking" }).phase, "interrupted");
  state = callReducer(state, { type: "turn" });
  assert.equal(state.interrupted, false);
});

test("interruption is ignored when nothing is happening", () => {
  const state = callReducer(run([{ type: "open", engine: "local" }, { type: "ready", engine: "local", voice: "v" }]), { type: "interrupted" });
  assert.equal(state.phase, "listening");
  assert.equal(state.interrupted, false);
});

test("errors are terminal until a retry opens a fresh call", () => {
  let state = run([{ type: "open", engine: "realtime" }, { type: "fail", failure: { code: "realtime", detail: "no" } }]);
  assert.equal(state.phase, "error");
  assert.equal(state.failure?.code, "realtime");
  state = callReducer(state, { type: "open", engine: "local" });
  assert.equal(state.phase, "starting");
  assert.equal(state.failure, undefined);
  assert.equal(state.engine, "local");
});

test("a fallback can report Preparing again while the local models warm", () => {
  let state = run([
    { type: "open", engine: "realtime" },
    { type: "ready", engine: "realtime", voice: "marin" },
    { type: "speaking" },
  ]);
  state = callReducer(state, { type: "preparing" });
  assert.equal(state.phase, "preparing");
  state = callReducer(state, { type: "ready", engine: "local", voice: "v", fallback: { code: "realtime", detail: "lost" } });
  assert.equal(state.phase, "listening");
  assert.equal(state.fallback?.code, "realtime");
});

test("a fallback records why another engine is in use", () => {
  const state = run([
    { type: "open", engine: "realtime" },
    { type: "ready", engine: "local", voice: "v", fallback: { code: "realtime", detail: "no key" } },
  ]);
  assert.equal(state.engine, "local");
  assert.equal(state.fallback?.code, "realtime");
});

test("partials only exist while a call is active", () => {
  let state = run([{ type: "open", engine: "local" }, { type: "partial", text: "early" }]);
  assert.equal(state.partial, "");
  state = callReducer(state, { type: "ready", engine: "local", voice: "v" });
  state = callReducer(state, { type: "partial", text: "hello" });
  assert.equal(state.partial, "hello");
  state = callReducer(state, { type: "turn" });
  assert.equal(state.partial, "");
  assert.equal(state.phase, "thinking");
});
