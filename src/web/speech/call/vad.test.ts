/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { VoiceActivity } from "./vad";

const SAMPLES = 640; // 40 ms at 16 kHz
const silence = () => new Float32Array(SAMPLES);
const speech = (amplitude = 0.2) => {
  const frame = new Float32Array(SAMPLES);
  for (let i = 0; i < SAMPLES; i++) frame[i] = Math.sin((i / SAMPLES) * Math.PI * 8) * amplitude;
  return frame;
};

test("silence produces no events and the level stays at the floor", () => {
  const vad = new VoiceActivity(SAMPLES);
  for (let i = 0; i < 30; i++) assert.equal(vad.push(silence()), null);
  assert.equal(vad.isSpeaking, false);
  assert.equal(vad.displayLevel, 0);
});

test("a few speech frames start an utterance and carry the pre-roll", () => {
  const vad = new VoiceActivity(SAMPLES, { startFrames: 3, preRollMs: 120 });
  vad.push(silence());
  vad.push(silence());
  assert.equal(vad.push(speech()), null);
  assert.equal(vad.push(speech()), null);
  const start = vad.push(speech());
  assert.equal(start?.type, "start");
  if (start?.type !== "start") return;
  // Two quiet frames plus the three attack frames fit the 120 ms pre-roll (three frames).
  assert.equal(start.preRoll.length, 3);
  assert.equal(vad.isSpeaking, true);
});

test("silence ends an accepted utterance after the hangover", () => {
  const vad = new VoiceActivity(SAMPLES, { startFrames: 2, endSilenceMs: 400, minSpeechMs: 160 });
  vad.push(speech());
  assert.equal(vad.push(speech())?.type, "start");
  let end: ReturnType<VoiceActivity["push"]> = null;
  for (let i = 0; i < 10 && !end; i++) end = vad.push(silence());
  assert.equal(end?.type, "end");
  if (end?.type !== "end") return;
  assert.equal(end.accepted, true);
  assert.equal(vad.isSpeaking, false);
  assert.ok(end.speechMs >= 160);
});

test("a cough shorter than the start count never starts, and a tiny utterance is rejected", () => {
  const vad = new VoiceActivity(SAMPLES, { startFrames: 3, minSpeechMs: 250 });
  assert.equal(vad.push(speech()), null);
  assert.equal(vad.push(silence()), null);
  assert.equal(vad.isSpeaking, false);

  const short = new VoiceActivity(SAMPLES, { startFrames: 1, endSilenceMs: 80, minSpeechMs: 250 });
  short.push(speech());
  let end: ReturnType<VoiceActivity["push"]> = null;
  for (let i = 0; i < 5 && !end; i++) end = short.push(silence());
  assert.equal(end?.type, "end");
  if (end?.type === "end") assert.equal(end.accepted, false);
});

test("an utterance longer than the cap ends even while the user keeps talking", () => {
  const vad = new VoiceActivity(SAMPLES, { startFrames: 2, maxUtteranceMs: 200, minSpeechMs: 100 });
  vad.push(speech());
  vad.push(speech());
  let end: ReturnType<VoiceActivity["push"]> = null;
  for (let i = 0; i < 10 && !end; i++) end = vad.push(speech());
  assert.equal(end?.type, "end");
  if (end?.type === "end") {
    assert.equal(end.accepted, true);
    assert.ok(end.speechMs >= 200);
  }
});
