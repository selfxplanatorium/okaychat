import { z } from "zod";
import { CALL_AUDIO_HEADER, CALL_INPUT_RATE, type CallEngine, type CallErrorCode, type ClientMessage, type ServerMessage } from "../../shared/voice.js";
import { CallFailure, selectEngine, type CallBackends, type LocalSpeech, type RealtimeSignal } from "./backend.js";
import type { CallLimits, StartLimiter } from "./limits.js";

// One voice call on one WebSocket. The browser runs voice activity detection and the chat turn; this side turns
// utterances into text and sentences into audio (local engine), or relays the Realtime SDP exchange. Nothing here
// stores audio or text: buffers live for one utterance or one sentence. See docs/implementation/voice-calls.md.

export interface CallSocket {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
  /** Bytes not yet written to the network. */
  readonly bufferedAmount: number;
}

/** One call per account on this server. A takeover ends the older call. */
export class CallRegistry {
  private readonly calls = new Map<string, CallSession>();
  get(userId: string) {
    return this.calls.get(userId);
  }
  set(userId: string, session: CallSession) {
    this.calls.set(userId, session);
  }
  /** Removes the session if it is the registered one; true when no call is left on the server. */
  delete(userId: string, session: CallSession): boolean {
    if (this.calls.get(userId) === session) this.calls.delete(userId);
    return this.calls.size === 0;
  }
  get size() {
    return this.calls.size;
  }
}

export interface CallDeps {
  backends: CallBackends;
  limits: CallLimits;
  registry: CallRegistry;
  starts: StartLimiter;
  /** The thread exists and belongs to the user (temporary `tmp_` chats are never stored and always pass). */
  threadOwned: (userId: string, threadId: string) => boolean;
  /** The session cookie that opened the socket is still valid; checked on every ping. */
  stillSignedIn: () => boolean;
  /** The admin's longest recording, in seconds. */
  maxRecordingSeconds: () => number;
  /**
   * Called once when a call ends, with counters only (no audio, no text). The chat model's own usage is recorded
   * by the normal chat path; this is the speech half, like the counters the speech routes keep.
   */
  onUsage?: (usage: { engine: CallEngine; sttSeconds: number; ttsChars: number }) => void;
  now?: () => number;
}

const id = z.number().int().min(0).max(2 ** 31);
const clientMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("start"), threadId: z.string().regex(/^[\w-]{1,100}$/), engine: z.enum(["local", "realtime"]), takeover: z.boolean().optional() }),
  z.object({ t: z.literal("utt.start"), id }),
  z.object({ t: z.literal("utt.end"), id }),
  z.object({ t: z.literal("utt.cancel"), id }),
  z.object({ t: z.literal("say"), id, text: z.string() }),
  z.object({ t: z.literal("say.cancel") }),
  z.object({ t: z.literal("rt.offer"), sdp: z.string().max(20_000) }),
  z.object({ t: z.literal("rt.failed"), reason: z.string().max(300) }),
  z.object({ t: z.literal("ping") }),
  z.object({ t: z.literal("end") }),
]);

/** Bytes per second of the microphone stream (PCM16 mono). */
const INPUT_BYTES_PER_SECOND = CALL_INPUT_RATE * 2;
/** A partial transcript after each second of new speech, for the first 20 seconds of an utterance. */
const PARTIAL_STEP = INPUT_BYTES_PER_SECOND;
const PARTIAL_UNTIL = 20 * INPUT_BYTES_PER_SECOND;
/** Shorter than this is a cough or a click, not speech. */
const MIN_UTTERANCE = 0.25 * INPUT_BYTES_PER_SECOND;
/** Audio frames to the browser: about 0.2 s each at 22 kHz. */
const AUDIO_CHUNK = 8192;
/** Over this much unsent data the client is too slow; audio is dropped rather than buffered without bound. */
const MAX_BUFFERED = 4 * 1024 * 1024;

interface Utterance {
  id: number;
  chunks: Buffer[];
  bytes: number;
  partialAt: number;
  partialRunning: boolean;
}

type Phase = "waiting" | "preparing" | "active" | "ended";

export class CallSession {
  private phase: Phase = "waiting";
  private engine: CallEngine = "local";
  private threadId = "";
  private local: LocalSpeech | null = null;
  private realtime: RealtimeSignal | null = null;
  private realtimeOffered = false;
  private utterance: Utterance | null = null;
  private readonly queue: Array<{ id: number; text: string }> = [];
  private speaking: AbortController | null = null;
  /** Cancels every request this call has in flight when it ends. */
  private readonly lifetime = new AbortController();
  private readonly timers: NodeJS.Timeout[] = [];
  private startedAt = 0;
  private lastActivity = 0;
  private lastMessage = 0;
  private inputBytes = 0;
  private ttsChars = 0;
  private sttSeconds = 0;
  private registered = false;
  private readonly now: () => number;

  constructor(private readonly userId: string, private readonly socket: CallSocket, private readonly deps: CallDeps) {
    this.now = deps.now ?? Date.now;
    this.lastMessage = this.now();
    this.timers.push(setTimeout(() => this.phase === "waiting" && this.fail("protocol", "No start message.", true), deps.limits.startSeconds * 1000));
  }

  get ended() {
    return this.phase === "ended";
  }

  /** The chat this call is bound to; empty until `start`. */
  get boundThread() {
    return this.threadId;
  }

  /** Text or binary WebSocket message. */
  onMessage(data: string | ArrayBuffer | Uint8Array) {
    if (this.phase === "ended") return;
    this.lastMessage = this.now();
    if (typeof data !== "string") return this.audio(data instanceof Uint8Array ? data : new Uint8Array(data));
    let parsed: ClientMessage;
    try {
      const result = clientMessage.safeParse(JSON.parse(data));
      if (!result.success) return this.fail("protocol", "Unknown message.", false);
      parsed = result.data;
    } catch {
      return this.fail("protocol", "Messages must be JSON.", false);
    }
    if (this.phase === "waiting" && parsed.t !== "start") return this.fail("protocol", "Start the call first.", true);
    switch (parsed.t) {
      case "start":
        return void this.start(parsed.threadId, parsed.engine, parsed.takeover === true);
      case "utt.start":
        return this.openUtterance(parsed.id);
      case "utt.end":
        return void this.finishUtterance(parsed.id);
      case "utt.cancel":
        if (this.utterance?.id === parsed.id) this.utterance = null;
        return;
      case "say":
        return this.say(parsed.id, parsed.text);
      case "say.cancel":
        return this.cancelSpeech();
      case "rt.offer":
        return void this.offer(parsed.sdp);
      case "rt.failed":
        return void this.fallBackToLocal("realtime", parsed.reason || "The Realtime connection failed in the browser.");
      case "ping":
        if (!this.deps.stillSignedIn()) return this.end("unauthorized");
        return this.send({ t: "pong" });
      case "end":
        return this.end("user");
    }
  }

  /** The socket closed: free everything this call holds. */
  onClose() {
    this.cleanup();
  }

  /** Ends the call with a reason the client can show, then closes the socket. */
  end(reason: CallErrorCode | "user") {
    if (this.phase === "ended") return;
    this.send({ t: "ended", reason, seconds: this.startedAt ? Math.round((this.now() - this.startedAt) / 1000) : 0 });
    this.cleanup();
    this.socket.close(1000, reason);
  }

  private cleanup() {
    if (this.phase === "ended") return;
    this.phase = "ended";
    this.lifetime.abort();
    this.speaking?.abort();
    this.speaking = null;
    this.queue.length = 0;
    this.utterance = null;
    for (const timer of this.timers) clearTimeout(timer);
    if (this.registered && this.deps.registry.delete(this.userId, this)) this.deps.backends.released();
    this.registered = false;
    try {
      this.deps.onUsage?.({ engine: this.engine, sttSeconds: Math.round(this.sttSeconds * 10) / 10, ttsChars: this.ttsChars });
    } catch {
      // Usage accounting must never keep a socket alive.
    }
  }

  private send(message: ServerMessage) {
    if (this.phase === "ended" && message.t !== "ended") return;
    this.socket.send(JSON.stringify(message));
  }

  private fail(code: CallErrorCode, detail: string, fatal: boolean) {
    if (this.phase === "ended") return;
    this.send({ t: "error", code, detail: detail.slice(0, 300), fatal });
    if (fatal) this.end(code);
  }

  private async start(threadId: string, requested: CallEngine, takeover: boolean) {
    if (this.phase !== "waiting") return this.fail("protocol", "The call has already started.", false);
    this.phase = "preparing";
    if (!this.deps.threadOwned(this.userId, threadId)) return this.fail("thread", "That chat does not exist.", true);
    const existing = this.deps.registry.get(this.userId);
    if (existing && !existing.ended && !takeover) return this.fail("busy", "This account already has a call in another tab or device.", true);
    if (!this.deps.starts.take(this.userId, this.now())) return this.fail("rate", "Too many calls were started. Wait a few minutes.", true);
    // Registered before anything awaits, so two sockets of one account cannot both pass the check above.
    existing?.end("replaced");
    this.deps.registry.set(this.userId, this);
    this.registered = true;
    this.threadId = threadId;

    const local = this.deps.backends.local(this.userId);
    const choice = selectEngine(requested, local, () => this.deps.backends.realtime(this.userId, this.threadId));
    if ("error" in choice) return this.fail(choice.error.code, choice.error.detail, true);
    if (choice.engine === "realtime") {
      const rt = this.deps.backends.realtime(this.userId, this.threadId);
      if (!rt.ok) return this.fail(rt.code, rt.detail, true);
      this.realtime = rt.value;
      return this.ready("realtime");
    }
    if (!local.ok) return this.fail(local.code, local.detail, true);
    await this.prepareLocal(local.value, choice.fallback);
  }

  private async prepareLocal(speech: LocalSpeech, fallback?: { code: CallErrorCode; detail: string }) {
    this.local = speech;
    this.engine = "local";
    this.send({ t: "preparing" });
    try {
      await speech.warm(this.lifetime.signal);
    } catch (error) {
      if (this.lifetime.signal.aborted) return;
      const failure = error instanceof CallFailure ? error : new CallFailure("worker", "The speech worker failed.");
      return this.fail(failure.code, failure.message, true);
    }
    if (this.phase === "ended") return;
    this.ready("local", fallback);
  }

  private ready(engine: CallEngine, fallback?: { code: CallErrorCode; detail: string }) {
    const limits = this.deps.limits;
    this.engine = engine;
    const first = !this.startedAt;
    this.phase = "active";
    if (first) {
      this.startedAt = this.now();
      this.lastActivity = this.startedAt;
      this.timers.push(setTimeout(() => this.end("duration"), limits.maxSeconds * 1000));
      const watch = setInterval(() => {
        const now = this.now();
        if (now - this.lastMessage > limits.silentSocketSeconds * 1000) this.end("failed");
        // Realtime audio never passes through this server, so an idle timer here would end a working call.
        else if (this.engine === "local" && now - this.lastActivity > limits.idleSeconds * 1000) this.end("idle");
      }, 5000);
      this.timers.push(watch);
    }
    this.send({
      t: "ready",
      engine,
      voice: engine === "realtime" ? this.realtime!.voice : this.local!.voice,
      maxSeconds: Math.max(0, limits.maxSeconds - Math.round((this.now() - this.startedAt) / 1000)),
      maxUtteranceSeconds: this.maxUtteranceSeconds(),
      ...(fallback ? { fallback } : {}),
      ...(engine === "realtime" ? { model: this.realtime!.model } : {}),
    });
  }

  private maxUtteranceSeconds() {
    return Math.max(5, Math.min(this.deps.limits.maxUtteranceSeconds, this.deps.maxRecordingSeconds()));
  }

  private async fallBackToLocal(code: CallErrorCode, detail: string) {
    if (this.phase !== "active" || this.engine !== "realtime") return;
    this.realtime = null;
    const local = this.deps.backends.local(this.userId);
    if (!local.ok) return this.fail(code, detail, true);
    this.phase = "preparing";
    this.lastActivity = this.now();
    await this.prepareLocal(local.value, { code, detail });
  }

  // ---- Realtime signalling ----

  private async offer(sdp: string) {
    if (this.phase !== "active" || this.engine !== "realtime" || !this.realtime) return this.fail("protocol", "This call does not use Realtime.", false);
    if (this.realtimeOffered) return this.fail("protocol", "The Realtime session was already set up.", false);
    if (!sdp.startsWith("v=0")) return this.fail("protocol", "That is not a session description.", false);
    this.realtimeOffered = true;
    this.lastActivity = this.now();
    try {
      const answer = await this.realtime.answer(sdp, this.lifetime.signal);
      if (this.phase === "active") this.send({ t: "rt.answer", sdp: answer });
    } catch (error) {
      if (this.lifetime.signal.aborted) return;
      await this.fallBackToLocal("realtime", error instanceof Error ? error.message : "OpenAI Realtime failed.");
    }
  }

  // ---- speech to text ----

  private localActive() {
    return this.phase === "active" && this.engine === "local" && !!this.local;
  }

  private openUtterance(uttId: number) {
    if (!this.localActive()) return;
    this.utterance = { id: uttId, chunks: [], bytes: 0, partialAt: 0, partialRunning: false };
    this.lastActivity = this.now();
  }

  private audio(data: Uint8Array) {
    const utterance = this.utterance;
    if (!utterance || !this.localActive()) return;
    this.inputBytes += data.byteLength;
    if (this.inputBytes > this.deps.limits.maxInputBytes) return this.fail("limit", "This call sent more audio than one call may.", true);
    utterance.chunks.push(Buffer.from(data));
    utterance.bytes += data.byteLength;
    this.lastActivity = this.now();
    if (utterance.bytes >= this.maxUtteranceSeconds() * INPUT_BYTES_PER_SECOND) {
      // The client should have ended it already; take what was said so far.
      this.send({ t: "error", code: "limit", detail: "That was longer than one turn may be.", fatal: false });
      return void this.finishUtterance(utterance.id);
    }
    if (!utterance.partialRunning && utterance.bytes <= PARTIAL_UNTIL && utterance.bytes - utterance.partialAt >= PARTIAL_STEP) void this.partial(utterance);
  }

  private async partial(utterance: Utterance) {
    utterance.partialRunning = true;
    utterance.partialAt = utterance.bytes;
    const pcm = Buffer.concat(utterance.chunks);
    try {
      const text = await this.local!.transcribe(pcm, true, this.lifetime.signal);
      if (text && this.utterance === utterance) this.send({ t: "partial", id: utterance.id, text });
    } catch {
      // A missed partial only means the live transcript lags; the final transcript is what counts.
    } finally {
      utterance.partialRunning = false;
    }
  }

  private async finishUtterance(uttId: number) {
    const utterance = this.utterance;
    if (!utterance || utterance.id !== uttId || !this.localActive()) return;
    this.utterance = null;
    this.lastActivity = this.now();
    if (utterance.bytes < MIN_UTTERANCE) return this.send({ t: "final", id: uttId, text: "" });
    const pcm = Buffer.concat(utterance.chunks);
    utterance.chunks = [];
    this.sttSeconds += pcm.byteLength / INPUT_BYTES_PER_SECOND;
    try {
      const text = (await this.local!.transcribe(pcm, false, this.lifetime.signal)) ?? "";
      this.send({ t: "final", id: uttId, text });
    } catch (error) {
      if (this.lifetime.signal.aborted) return;
      this.send({ t: "final", id: uttId, text: "" });
      this.fail(error instanceof CallFailure ? error.code : "worker", error instanceof Error ? error.message : "Speech recognition failed.", false);
    }
  }

  // ---- text to speech ----

  private say(sayId: number, raw: string) {
    if (!this.localActive()) return;
    const text = raw.trim().slice(0, this.deps.limits.maxSayChars);
    if (!text) return this.send({ t: "said", id: sayId, ok: true });
    if (this.queue.length >= this.deps.limits.maxQueue) {
      this.fail("limit", "Too many sentences are waiting to be spoken.", false);
      // The client clears only ids the server reported; without this it waits forever for the sentence.
      return this.send({ t: "said", id: sayId, ok: false });
    }
    this.ttsChars += text.length;
    if (this.ttsChars > this.deps.limits.maxTtsChars) return this.fail("limit", "This call has spoken as much as one call may.", true);
    this.lastActivity = this.now();
    this.queue.push({ id: sayId, text });
    void this.pump();
  }

  private cancelSpeech() {
    this.queue.length = 0;
    this.speaking?.abort();
    this.speaking = null;
  }

  /** Speaks queued sentences strictly one after another, so two never overlap. */
  private async pump() {
    if (this.speaking || !this.queue.length || !this.localActive()) return;
    const next = this.queue.shift()!;
    const controller = new AbortController();
    this.speaking = controller;
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    try {
      const { pcm, rate } = await this.local!.speak(next.text, signal);
      if (signal.aborted) return;
      this.send({ t: "audio", id: next.id, rate });
      let complete = true;
      for (let offset = 0; offset < pcm.byteLength; offset += AUDIO_CHUNK) {
        if (signal.aborted || this.phase === "ended") return;
        // A client that stopped reading would otherwise make this call buffer audio without bound.
        if (this.socket.bufferedAmount > MAX_BUFFERED) {
          complete = false;
          break;
        }
        const end = Math.min(pcm.byteLength, offset + AUDIO_CHUNK);
        const frame = new Uint8Array(CALL_AUDIO_HEADER + end - offset);
        new DataView(frame.buffer).setUint32(0, next.id, true);
        frame.set(pcm.subarray(offset, end), CALL_AUDIO_HEADER);
        this.socket.send(frame);
      }
      if (!complete) this.fail("limit", "This connection is too slow to play the reply.", false);
      this.send({ t: "said", id: next.id, ok: complete });
    } catch (error) {
      if (signal.aborted) return;
      this.send({ t: "said", id: next.id, ok: false });
      this.fail(error instanceof CallFailure ? error.code : "voice", error instanceof Error ? error.message : "The voice failed.", false);
    } finally {
      if (this.speaking === controller) this.speaking = null;
      if (this.phase === "active") void this.pump();
    }
  }

  /** Counters for the server log; no content. */
  stats() {
    return { engine: this.engine, sttSeconds: Math.round(this.sttSeconds), ttsChars: this.ttsChars };
  }
}
