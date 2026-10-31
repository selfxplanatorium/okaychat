// Frame-based voice activity detection for the microphone stream. Pure: the caller feeds Float32 frames at
// `sampleRate` and receives start/end events. Energy in dB, with an attack count, a hangover, a minimum
// accepted utterance, a maximum length, and a pre-roll the caller can send with the first real frame.
// Echo cancellation keeps the assistant's own voice out; the threshold is deliberately conservative.

export interface VadOptions {
  /** Above this RMS level (dBFS) a frame is speech. */
  thresholdDb?: number;
  /** Consecutive speech frames before an utterance starts. */
  startFrames?: number;
  /** Silence that ends an utterance. */
  endSilenceMs?: number;
  /** Utterances shorter than this are a cough or a click. */
  minSpeechMs?: number;
  /** Hard stop for one utterance (the server has its own cap). */
  maxUtteranceMs?: number;
  /** Audio kept before the detected start and sent with the utterance. */
  preRollMs?: number;
  sampleRate?: number;
}

export type VadEvent =
  | { type: "start"; preRoll: Float32Array[] }
  | { type: "end"; speechMs: number; accepted: boolean };

const levelDb = (frame: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  return 20 * Math.log10(Math.sqrt(sum / Math.max(1, frame.length)) || 1e-8);
};

export class VoiceActivity {
  readonly thresholdDb: number;
  readonly startFrames: number;
  readonly endSilenceMs: number;
  readonly minSpeechMs: number;
  readonly maxUtteranceMs: number;
  readonly frameMs: number;
  private readonly maxPreRoll: number;
  private readonly silenceFrames: number;
  private readonly maxFrames: number;
  private speaking = false;
  private attack = 0;
  private quiet = 0;
  private speechFrames = 0;
  /** Frames above the threshold; trailing silence must not count toward the minimum. */
  private voicedFrames = 0;
  private received = 0;
  private preRoll: Float32Array[] = [];
  private lastLevel = -160;

  constructor(frameSamples: number, options: VadOptions = {}) {
    this.thresholdDb = options.thresholdDb ?? -45;
    this.startFrames = options.startFrames ?? 3;
    this.endSilenceMs = options.endSilenceMs ?? 700;
    this.minSpeechMs = options.minSpeechMs ?? 250;
    this.maxUtteranceMs = options.maxUtteranceMs ?? 60_000;
    this.frameMs = (frameSamples / (options.sampleRate ?? 16_000)) * 1000;
    this.maxPreRoll = Math.max(1, Math.round((options.preRollMs ?? 200) / this.frameMs));
    this.silenceFrames = Math.max(1, Math.round(this.endSilenceMs / this.frameMs));
    this.maxFrames = Math.max(1, Math.round(this.maxUtteranceMs / this.frameMs));
  }

  get isSpeaking() {
    return this.speaking;
  }

  /** The last frame's level in dBFS, for a meter. */
  get level() {
    return this.lastLevel;
  }

  /** 0–1 for the waveform, using the same −60 … −15 dB range as dictation. */
  get displayLevel() {
    return Math.min(1, Math.max(0, (this.lastLevel + 60) / 45));
  }

  push(frame: Float32Array): VadEvent | null {
    this.lastLevel = levelDb(frame);
    this.received++;
    const speech = this.lastLevel > this.thresholdDb;

    if (!this.speaking) {
      this.preRoll.push(frame);
      if (this.preRoll.length > this.maxPreRoll) this.preRoll.shift();
      if (!speech) {
        this.attack = 0;
        return null;
      }
      this.attack++;
      if (this.attack < this.startFrames) return null;
      this.speaking = true;
      this.quiet = 0;
      this.speechFrames = this.attack;
      this.voicedFrames = this.attack;
      this.attack = 0;
      const preRoll = this.preRoll;
      this.preRoll = [];
      return { type: "start", preRoll };
    }

    this.quiet = speech ? 0 : this.quiet + 1;
    this.speechFrames++;
    if (speech) this.voicedFrames++;
    const tooLong = this.speechFrames >= this.maxFrames;
    if (this.quiet >= this.silenceFrames || tooLong) {
      const speechMs = Math.round(this.speechFrames * this.frameMs);
      // A forced stop still transcribes what was said; the caller also tells the server to end the utterance.
      const accepted = this.voicedFrames * this.frameMs >= this.minSpeechMs;
      this.reset();
      return { type: "end", speechMs, accepted };
    }
    return null;
  }

  reset() {
    this.speaking = false;
    this.attack = 0;
    this.quiet = 0;
    this.speechFrames = 0;
    this.voicedFrames = 0;
    this.preRoll = [];
  }

  /** Frames consumed since the last reset; the controller uses it to decide when to send audio. */
  get framesReceived() {
    return this.received;
  }
}
