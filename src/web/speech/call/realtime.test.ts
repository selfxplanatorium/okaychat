/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { readRealtimeEvent } from "./realtime";

const assistant = () => ({ text: "" });

test("user transcript deltas stay partial and the completed transcript is final", () => {
  const state = assistant();
  assert.deepEqual(readRealtimeEvent({ type: "conversation.item.input_audio_transcription.delta", delta: "hel" }, state), {
    transcript: { role: "user", text: "hel", isFinal: false },
  });
  assert.deepEqual(readRealtimeEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "hello there" }, state), {
    transcript: { role: "user", text: "hello there", isFinal: true },
  });
  assert.equal(readRealtimeEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: " " }, state), null);
});

test("assistant deltas accumulate so each emission replaces the previous text", () => {
  const state = assistant();
  assert.deepEqual(readRealtimeEvent({ type: "response.output_audio_transcript.delta", delta: "The answer" }, state), {
    transcript: { role: "assistant", text: "The answer", isFinal: false },
  });
  assert.deepEqual(readRealtimeEvent({ type: "response.audio_transcript.delta", delta: " is 42." }, state), {
    transcript: { role: "assistant", text: "The answer is 42.", isFinal: false },
  });
  assert.deepEqual(readRealtimeEvent({ type: "response.audio_transcript.done", transcript: "The answer is 42." }, state), {
    transcript: { role: "assistant", text: "The answer is 42.", isFinal: true },
  });
  assert.equal(state.text, "");
});

test("speech and response events drive listening and speaking modes", () => {
  const state = assistant();
  assert.deepEqual(readRealtimeEvent({ type: "input_audio_buffer.speech_started" }, state), { mode: "listening" });
  assert.deepEqual(readRealtimeEvent({ type: "response.created" }, state), { mode: "speaking" });
  assert.deepEqual(readRealtimeEvent({ type: "response.done" }, state), { mode: "listening" });
  assert.equal(readRealtimeEvent({ type: "session.created" }, state), null);
  assert.equal(readRealtimeEvent({}, state), null);
});

test("an empty done event does not emit a blank assistant message", () => {
  assert.equal(readRealtimeEvent({ type: "response.audio_transcript.done", transcript: "" }, assistant()), null);
});

test("a data-channel error becomes a generic failure, never the provider's raw message", () => {
  const read = readRealtimeEvent({ type: "error", error: { message: "sk-secret account detail" } }, assistant());
  assert.deepEqual(read, { failure: "The Realtime session reported an error." });
  assert.equal(JSON.stringify(read).includes("sk-secret"), false);
});
