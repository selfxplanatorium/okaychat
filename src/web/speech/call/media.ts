import { CALL_INPUT_RATE } from "@shared/voice";
import { loadCallWorklets } from "./worklets";

// Microphone capture and gapless playback. Both use AudioWorklets; the sample-rate conversion here keeps the
// server at 16 kHz even when the browser ignores the AudioContext rate (Safari), and keeps Piper audio at the
// right pitch when a context cannot open at the WAV's rate.

/** A microphone permission prompt that never answers must not leave the call screen on "Listening". */
export const MIC_SETUP_TIMEOUT_MS = 20_000;
/** How much synthesized audio the playback worklet may hold; longer replies are dropped with a notice. */
export const PLAYER_QUEUE_MS = 30_000;

export class CallMediaError extends Error {
  constructor(readonly code: "mic" | "insecure" | "media", message: string) {
    super(message);
  }
}

/** The playback half the controller drives; `Player` is the real one, tests use a fake. */
export interface CallPlayer {
  onEmpty: (() => void) | null;
  onOverflow: (() => void) | null;
  ensure(rate: number): Promise<void>;
  push(pcm: Uint8Array): void;
  cancel(): void;
  dispose(): Promise<void>;
}

/** The microphone half the controller drives; `Microphone` is the real one, tests use a fake. */
export interface CallMicrophone {
  start(onFrame: (pcm: Int16Array) => void): Promise<void>;
  mute(muted: boolean): void;
  stop(): Promise<void>;
}

/** Linear resampling of Int16 PCM. Returns the input unchanged when the rates match. */
export function resampleInt16(input: Int16Array, from: number, to: number): Int16Array {
  if (from === to || input.length === 0) return input;
  const length = Math.max(1, Math.round((input.length * to) / from));
  const out = new Int16Array(length);
  const ratio = from / to;
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    out[i] = Math.round(input[left]! * (1 - fraction) + input[right]! * fraction);
  }
  return out;
}

/** A requested rate is a hint: Safari rejects unsupported rates, and the resampler covers the fallback. */
function audioContext(options: AudioContextOptions): AudioContext {
  try {
    return new AudioContext(options);
  } catch {
    return new AudioContext();
  }
}

async function running(context: AudioContext, what: string): Promise<void> {
  try {
    await context.resume();
  } catch {
    throw new CallMediaError("media", `${what} could not start.`);
  }
  // A context that stays suspended after the call's own click would play nothing at all; failing loudly beats
  // a call that looks connected and stays silent.
  if (context.state !== "running") throw new CallMediaError("media", `${what} is suspended.`);
}

export class Microphone implements CallMicrophone {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private stopped = false;

  get sampleRate() {
    return this.context?.sampleRate ?? CALL_INPUT_RATE;
  }

  async start(onFrame: (pcm: Int16Array) => void): Promise<void> {
    if (!window.isSecureContext) throw new CallMediaError("insecure", "The microphone needs HTTPS.");
    if (!navigator.mediaDevices?.getUserMedia) throw new CallMediaError("insecure", "This browser has no microphone API.");
    this.context = audioContext({ sampleRate: CALL_INPUT_RATE, latencyHint: "interactive" });
    await loadCallWorklets(this.context);
    if (this.stopped) return this.stop();
    const pending = navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CallMediaError("mic", "The microphone did not answer in time.")), MIC_SETUP_TIMEOUT_MS);
    });
    try {
      this.stream = await Promise.race([pending, timeout]);
    } catch (error) {
      await this.stop();
      // A permission prompt that answers after the deadline must not leave a live track behind.
      pending.then((stream) => stream.getTracks().forEach((track) => track.stop())).catch(() => {});
      if (error instanceof CallMediaError) throw error;
      const name = (error as Error).name;
      throw new CallMediaError("mic", name === "NotAllowedError" ? "Microphone access was denied." : "No microphone is available.");
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (this.stopped) return this.stop();
    const context = this.context;
    const source = context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(context, "call-capture");
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(this.node);
    this.node.connect(silent);
    silent.connect(context.destination);
    this.node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (this.stopped) return;
      const frame = new Int16Array(event.data);
      onFrame(resampleInt16(frame, context.sampleRate, CALL_INPUT_RATE));
    };
    try {
      await running(context, "Microphone capture");
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  mute(muted: boolean) {
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  async stop() {
    this.stopped = true;
    this.node?.port.close();
    this.node?.disconnect();
    this.node = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close().catch(() => {});
  }
}

export class Player implements CallPlayer {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private rate = 0;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;
  /** Fires when the worklet ran dry; the controller uses it to return to listening. */
  onEmpty: (() => void) | null = null;
  /** Fires when the worklet's bounded FIFO had to drop audio. */
  onOverflow: (() => void) | null = null;

  get sampleRate() {
    return this.context?.sampleRate ?? this.rate;
  }

  ensure(rate: number): Promise<void> {
    if (this.disposed) return Promise.resolve();
    // Serialize rate changes: two callers must not build two contexts, and the later rate wins.
    const task = this.chain.then(() => this.openContext(rate));
    this.chain = task.catch(() => {});
    return task;
  }

  private async openContext(rate: number): Promise<void> {
    if (this.disposed) return;
    if (this.context && this.rate === rate) return;
    this.rate = rate;
    await this.disposeContext();
    const context = audioContext({ sampleRate: rate });
    let node: AudioWorkletNode | null = null;
    try {
      await loadCallWorklets(context);
      if (this.disposed) {
        await context.close().catch(() => {});
        return;
      }
      node = new AudioWorkletNode(context, "call-playback", {
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { maxQueueMs: PLAYER_QUEUE_MS },
      });
      node.port.onmessage = (event: MessageEvent<{ type?: string }>) => {
        if (this.disposed) return;
        if (event.data?.type === "empty") this.onEmpty?.();
        else if (event.data?.type === "overflow") this.onOverflow?.();
      };
      node.connect(context.destination);
      this.context = context;
      this.node = node;
      await running(context, "Audio playback");
    } catch (error) {
      // No worklet or a suspended context: release the context here, not on the next call.
      node?.port.close();
      node?.disconnect();
      if (this.context === context) {
        this.context = null;
        this.node = null;
      }
      await context.close().catch(() => {});
      throw error;
    }
  }

  push(pcm: Uint8Array): void {
    const context = this.context;
    const node = this.node;
    if (!context || !node) return;
    const src = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
    const samples = resampleInt16(src, this.rate, context.sampleRate);
    const floats = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) floats[i] = samples[i]! / 32768;
    node.port.postMessage({ type: "chunk", samples: floats }, [floats.buffer]);
  }

  cancel(): void {
    this.node?.port.postMessage({ type: "cancel" });
  }

  private async disposeContext() {
    this.node?.port.close();
    this.node?.disconnect();
    this.node = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close().catch(() => {});
  }

  async dispose() {
    this.disposed = true;
    await this.disposeContext();
  }
}
