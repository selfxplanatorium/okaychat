import { CALL_INPUT_RATE } from "@shared/voice";
import { loadCallWorklets } from "./worklets";

// Microphone capture and gapless playback. Both use AudioWorklets; the sample-rate conversion here keeps the
// server at 16 kHz even when the browser ignores the AudioContext rate (Safari), and keeps Piper audio at the
// right pitch when a context cannot open at the WAV's rate.

export class CallMediaError extends Error {
  constructor(readonly code: "mic" | "insecure" | "media", message: string) {
    super(message);
  }
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

export class Microphone {
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
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      await this.stop();
      const name = (error as Error).name;
      throw new CallMediaError("mic", name === "NotAllowedError" ? "Microphone access was denied." : "No microphone is available.");
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
    await context.resume().catch(() => {});
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

export class Player {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private rate = 0;
  private opening: Promise<void> | null = null;
  private disposed = false;
  /** Fires when the worklet ran dry; the controller uses it to return to listening. */
  onEmpty: (() => void) | null = null;

  get sampleRate() {
    return this.context?.sampleRate ?? this.rate;
  }

  async ensure(rate: number): Promise<void> {
    if (this.disposed) return;
    if (this.rate === rate && this.context) return;
    if (this.opening) return this.opening;
    this.rate = rate;
    this.opening = (async () => {
      await this.disposeContext();
      const context = audioContext({ sampleRate: rate });
      await loadCallWorklets(context);
      if (this.disposed) {
        await context.close().catch(() => {});
        return;
      }
      const node = new AudioWorkletNode(context, "call-playback", { numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (event: MessageEvent<{ type?: string }>) => {
        if (event.data?.type === "empty" && !this.disposed) this.onEmpty?.();
      };
      node.connect(context.destination);
      this.context = context;
      this.node = node;
      await context.resume().catch(() => {});
    })().finally(() => {
      this.opening = null;
    });
    return this.opening;
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
