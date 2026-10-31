/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAYBACK_WORKLET } from "./worklets";

// The worklet is a string for `audioWorklet.addModule`; executing it here under a fake processor tests the
// actual code the browser runs, including the offset bookkeeping the old version reset on every chunk.

interface FakePort {
  messages: unknown[];
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

class FakeProcessor {
  port: FakePort;
  constructor() {
    const messages: unknown[] = [];
    this.port = {
      messages,
      onmessage: null,
      postMessage(message) {
        messages.push(message);
      },
    };
  }
}

type Processor = {
  port: FakePort;
  process(inputs: unknown[], outputs: Float32Array[][]): boolean;
};

function loadPlayback(sampleRate = 1000, maxQueueMs = 30_000): Processor {
  const register = (_name: string, ctor: new (options: unknown) => Processor) => ctor;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function("AudioWorkletProcessor", "sampleRate", "registerProcessor", `\n${PLAYBACK_WORKLET}\nreturn CallPlaybackProcessor;\n`) as (
    base: typeof FakeProcessor,
    rate: number,
    registerProcessor: typeof register,
  ) => new (options: unknown) => Processor;
  const Ctor = factory(FakeProcessor, sampleRate, register);
  return new Ctor({ processorOptions: { maxQueueMs } });
}

function chunk(processor: Processor, samples: number[]) {
  processor.port.onmessage?.({ data: { type: "chunk", samples: Float32Array.from(samples) } });
}

function render(processor: Processor, length: number): number[] {
  const output = new Float32Array(length);
  processor.process([], [[output]]);
  return [...output];
}

test("an arriving chunk never rewinds the one being played", () => {
  const processor = loadPlayback(1000);
  chunk(processor, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(render(processor, 4), [1, 2, 3, 4]);
  // Enqueued mid-chunk: the remaining samples of the first chunk come first, then the new one.
  chunk(processor, [7, 8]);
  assert.deepEqual(render(processor, 8), [5, 6, 7, 8, 0, 0, 0, 0]);
  // Gapless: no silence between sentences and no repeated sample.
  chunk(processor, [9]);
  assert.deepEqual(render(processor, 2), [9, 0]);
});

test("cancel clears the current chunk and the queue", () => {
  const processor = loadPlayback(1000);
  chunk(processor, [1, 2, 3, 4]);
  chunk(processor, [5, 6]);
  assert.deepEqual(render(processor, 2), [1, 2]);
  processor.port.onmessage?.({ data: { type: "cancel" } });
  assert.deepEqual(render(processor, 4), [0, 0, 0, 0]);
  chunk(processor, [7, 8]);
  assert.deepEqual(render(processor, 4), [7, 8, 0, 0]);
});

test("the FIFO is bounded by duration and reports overflow instead of growing", () => {
  const processor = loadPlayback(1000, 10);
  chunk(processor, [1, 2, 3, 4, 5, 6]);
  chunk(processor, [7, 8, 9, 10, 11, 12]);
  assert.deepEqual(processor.port.messages, [{ type: "overflow", dropped: 6, queued: 6 }]);
  // The dropped chunk never entered the queue: only the first six samples play.
  assert.deepEqual(render(processor, 8), [1, 2, 3, 4, 5, 6, 0, 0]);
  // Drained, so a full cap is accepted again.
  chunk(processor, [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  assert.deepEqual(render(processor, 10), [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
});

test("empty chunks are ignored", () => {
  const processor = loadPlayback(1000, 2);
  chunk(processor, []);
  chunk(processor, [1, 2]);
  assert.deepEqual(processor.port.messages, []);
  assert.deepEqual(render(processor, 2), [1, 2]);
});
