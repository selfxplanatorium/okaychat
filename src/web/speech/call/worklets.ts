// AudioWorklet sources travel as strings: `addModule` needs a URL, and a Blob URL keeps the worklet out of the
// bundler's graph (it has its own global scope with no imports). The pure jitter policy lives in jitter.ts.

/** Turns microphone Float32 samples into 40 ms Int16 little-endian frames at the context rate. */
export const CAPTURE_WORKLET = `
class CallCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // The render quantum's input arrays may be reused by the browser, so samples are copied as they arrive.
    this.target = Math.round(sampleRate * 0.04);
    this.buffer = new Float32Array(this.target);
    this.count = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.buffer[this.count++] = input[i];
      if (this.count === this.target) {
        const out = new Int16Array(this.target);
        for (let j = 0; j < this.target; j++) {
          const value = Math.max(-1, Math.min(1, this.buffer[j]));
          out[j] = value < 0 ? value * 32768 : value * 32767;
        }
        this.port.postMessage(out.buffer, [out.buffer]);
        this.count = 0;
      }
    }
    return true;
  }
}
registerProcessor("call-capture", CallCaptureProcessor);
`;

/**
 * Gapless playback: a FIFO of sentence chunks in arrival order. A sentence is pushed as Float32; chunks play
 * back to back with no overlap because only one queue is consumed. "cancel" clears it immediately for barge-in.
 *
 * The FIFO is bounded by duration, not just by count: the server can synthesize a whole reply faster than it
 * can be spoken, so without a cap the queue would grow without limit. A chunk that would exceed the cap is
 * dropped and reported ("overflow"), so the caller can tell the user audio was lost instead of truncating
 * silently. `offset` belongs to the chunk being played and is only reset when advancing or cancelling; an
 * arriving chunk must never rewind it, or the current samples would play twice.
 */
export const PLAYBACK_WORKLET = `
class CallPlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = (options && options.processorOptions) || {};
    const maxMs = typeof settings.maxQueueMs === "number" && settings.maxQueueMs > 0 ? settings.maxQueueMs : 30000;
    this.maxQueued = Math.max(1, Math.round(sampleRate * maxMs / 1000));
    this.queue = [];
    // Includes the unplayed tail of this.current.
    this.queued = 0;
    this.current = null;
    this.offset = 0;
    this.empty = true;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "chunk") {
        const samples = data.samples;
        // An empty chunk has nothing to play and must not accumulate in the queue.
        if (!samples || !samples.length) return;
        if (this.queued + samples.length > this.maxQueued) {
          this.port.postMessage({ type: "overflow", dropped: samples.length, queued: this.queued });
          return;
        }
        this.queue.push(samples);
        this.queued += samples.length;
      } else if (data.type === "cancel") {
        this.queue.length = 0;
        this.current = null;
        this.offset = 0;
        this.queued = 0;
        this.empty = true;
      }
    };
  }
  process(_inputs, outputs) {
    const channels = outputs[0];
    const output = channels && channels[0];
    if (!output) return true;
    let written = 0;
    while (written < output.length) {
      if (!this.current) {
        this.current = this.queue.shift() || null;
        this.offset = 0;
        if (!this.current) break;
      }
      const take = Math.min(this.current.length - this.offset, output.length - written);
      for (let i = 0; i < take; i++) output[written + i] = this.current[this.offset + i];
      written += take;
      this.offset += take;
      this.queued -= take;
      if (this.offset >= this.current.length) this.current = null;
    }
    if (written === 0 && !this.empty) {
      this.empty = true;
      this.port.postMessage({ type: "empty" });
    } else if (written > 0) {
      this.empty = false;
      // Mono source: copy to every channel so a stereo device does not play it on one side only.
      for (let channel = 1; channel < (channels?.length ?? 1); channel++) channels[channel].set(output);
    }
    return true;
  }
}
registerProcessor("call-playback", CallPlaybackProcessor);
`;

const url = (code: string) => URL.createObjectURL(new Blob([code], { type: "text/javascript" }));

/** Loads both worklets once per AudioContext. */
export async function loadCallWorklets(context: AudioContext): Promise<void> {
  const urls = [url(CAPTURE_WORKLET), url(PLAYBACK_WORKLET)];
  try {
    await Promise.all(urls.map((href) => context.audioWorklet.addModule(href)));
  } finally {
    for (const href of urls) URL.revokeObjectURL(href);
  }
}
