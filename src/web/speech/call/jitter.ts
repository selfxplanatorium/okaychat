// Playback policy for synthesized sentences. The AudioWorklet plays gaplessly from its FIFO; this buffer decides
// what enters that FIFO: it waits for a small cushion at the start of a sentence, keeps sentence order, never
// overlaps, reports an underrun when audio ran dry mid-sentence, drops the newest audio when a whole reply is
// arriving faster than it can play, and forgets everything on barge-in. Pure, so the policy is testable.

export interface JitterOptions {
  /** Audio kept before the first sentence starts. */
  minBufferMs?: number;
  /** Above this, new audio is dropped instead of held (the worklet has plenty already). */
  maxBufferMs?: number;
  sampleRate?: number;
}

interface Sentence {
  id: number;
  chunks: Int16Array[];
  complete: boolean;
  started: boolean;
}

export class JitterBuffer {
  private readonly minSamples: number;
  private readonly maxSamples: number;
  private readonly rate: number;
  private readonly order: number[] = [];
  private readonly sentences = new Map<number, Sentence>();
  private samples = 0;
  private underruns = 0;
  private overflows = 0;

  constructor(options: JitterOptions = {}) {
    this.rate = options.sampleRate ?? 22_050;
    this.minSamples = Math.max(1, Math.round(((options.minBufferMs ?? 180) / 1000) * this.rate));
    this.maxSamples = Math.max(this.minSamples, Math.round(((options.maxBufferMs ?? 4000) / 1000) * this.rate));
  }

  /** Adds PCM for one sentence. Chunks past the overflow cap are dropped. */
  push(id: number, pcm: Int16Array): void {
    if (this.samples + pcm.length > this.maxSamples) {
      this.overflows++;
      return;
    }
    let sentence = this.sentences.get(id);
    if (!sentence) {
      sentence = { id, chunks: [], complete: false, started: false };
      this.sentences.set(id, sentence);
      this.order.push(id);
    }
    sentence.chunks.push(pcm);
    this.samples += pcm.length;
  }

  /** The server finished sentence `id`; a short one can start without the cushion. */
  complete(id: number): void {
    const sentence = this.sentences.get(id);
    if (sentence) sentence.complete = true;
  }

  /** The next chunk to hand to the worklet, or null while the cushion is filling or everything is queued. */
  take(): Int16Array | null {
    const head = this.order.length ? this.sentences.get(this.order[0]!) : undefined;
    if (!head) return null;
    if (!head.started) {
      // A complete short sentence need not wait, or it would never start.
      if (!head.complete && this.samples < this.minSamples) return null;
      head.started = true;
    }
    const chunk = head.chunks.shift();
    if (!chunk) {
      // Started but nothing left: the worklet is about to run dry before the next sentence arrives.
      if (head.complete) {
        this.sentences.delete(head.id);
        this.order.shift();
      } else this.underruns++;
      return null;
    }
    this.samples -= chunk.length;
    if (!head.chunks.length && head.complete) {
      this.sentences.delete(head.id);
      this.order.shift();
    }
    return chunk;
  }

  /** True when the worklet should start playing the queued audio. */
  get ready(): boolean {
    const head = this.order.length ? this.sentences.get(this.order[0]!) : undefined;
    return !!head && (head.complete || this.samples >= this.minSamples);
  }

  /** Barge-in: every queued and in-flight sentence is dropped, in order, for good. */
  cancel(): { droppedSamples: number; droppedSentences: number } {
    const result = { droppedSamples: this.samples, droppedSentences: this.order.length };
    this.order.length = 0;
    this.sentences.clear();
    this.samples = 0;
    return result;
  }

  get bufferedSamples() {
    return this.samples;
  }

  get bufferedSeconds() {
    return this.samples / this.rate;
  }

  get underrunCount() {
    return this.underruns;
  }

  get overflowCount() {
    return this.overflows;
  }
}
