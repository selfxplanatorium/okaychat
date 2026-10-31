/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { JitterBuffer } from "./jitter";

const chunk = (ms: number, rate = 1000) => new Int16Array(Math.round((ms / 1000) * rate));

test("a sentence waits for its cushion unless it is already complete", () => {
  const buffer = new JitterBuffer({ minBufferMs: 200, sampleRate: 1000 });
  buffer.push(1, chunk(100));
  assert.equal(buffer.ready, false);
  assert.equal(buffer.take(), null);
  buffer.push(1, chunk(100));
  assert.equal(buffer.ready, true);
  assert.equal(buffer.take()?.length, 100);

  const short = new JitterBuffer({ minBufferMs: 500, sampleRate: 1000 });
  short.push(1, chunk(50));
  assert.equal(short.ready, false);
  short.complete(1);
  assert.equal(short.ready, true);
  assert.equal(short.take()?.length, 50);
});

test("sentences play strictly in order and never overlap", () => {
  const buffer = new JitterBuffer({ minBufferMs: 100, sampleRate: 1000 });
  buffer.push(2, chunk(60));
  buffer.complete(2);
  buffer.push(1, chunk(60));
  buffer.complete(1);
  assert.equal(buffer.take()?.length, 60);
  assert.equal(buffer.take()?.length, 60);
  assert.equal(buffer.take(), null);
});

test("cancel drops queued and in-flight audio", () => {
  const buffer = new JitterBuffer({ minBufferMs: 100, sampleRate: 1000 });
  buffer.push(1, chunk(200));
  buffer.complete(1);
  buffer.take();
  buffer.push(2, chunk(200));
  const dropped = buffer.cancel();
  assert.equal(dropped.droppedSentences, 1);
  assert.equal(buffer.bufferedSamples, 0);
  assert.equal(buffer.take(), null);
});

test("a started sentence that runs dry reports an underrun", () => {
  const buffer = new JitterBuffer({ minBufferMs: 100, sampleRate: 1000 });
  buffer.push(1, chunk(100));
  buffer.complete(1);
  assert.equal(buffer.ready, true);
  buffer.take();
  assert.equal(buffer.underrunCount, 0);

  const live = new JitterBuffer({ minBufferMs: 100, sampleRate: 1000 });
  live.push(1, chunk(100));
  live.take();
  assert.equal(live.take(), null);
  assert.equal(live.underrunCount, 1);
});

test("overflow drops the newest audio instead of buffering without bound", () => {
  const buffer = new JitterBuffer({ minBufferMs: 100, maxBufferMs: 300, sampleRate: 1000 });
  buffer.push(1, chunk(200));
  buffer.push(1, chunk(200));
  assert.equal(buffer.bufferedSamples, 200);
  assert.equal(buffer.overflowCount, 1);
});
