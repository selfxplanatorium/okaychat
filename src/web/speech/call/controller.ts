import { useAui } from "@assistant-ui/react";
import { CALL_INPUT_RATE, type CallEngine, type CallErrorCode, type ServerMessage } from "@shared/voice";
import { useData } from "@/state/data";
import { VoiceConnection } from "./connection";
import { SentenceChunker } from "./chunker";
import { JitterBuffer } from "./jitter";
import { CallMediaError, Microphone, Player } from "./media";
import { createRealtimeAdapter } from "./realtime";
import { isBusy, type CallState } from "./state";
import { useCall } from "./store";
import { VoiceActivity } from "./vad";

type Aui = ReturnType<typeof useAui>;

/** The call socket's SDP exchange for the Realtime adapter, switched on only while a Realtime call is active. */
interface RealtimeBridge {
  exchangeSdp: (sdp: string, signal: AbortSignal) => Promise<string>;
  onFailure: (reason: string) => void;
}
let bridge: RealtimeBridge | null = null;

/** The adapter registered with `useChatRuntime`; it only connects while a Realtime call set the bridge. */
export const realtimeVoiceAdapter = createRealtimeAdapter({
  exchangeSdp: (sdp, signal) => {
    if (!bridge) throw new Error("No Realtime call is active.");
    return bridge.exchangeSdp(sdp, signal);
  },
  onFailure: (reason) => bridge?.onFailure(reason),
});

const textOf = (message: { content: readonly { type: string; text?: string }[] }): string =>
  message.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("");

const toPcm = (frame: Float32Array): Int16Array => {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    const value = Math.max(-1, Math.min(1, frame[i]!));
    out[i] = value < 0 ? value * 32768 : value * 32767;
  }
  return out;
};

const callFailure = (state: CallState): string => state.failure?.detail ?? "";

/**
 * Drives one live call for the chat that started it. The local engine streams microphone PCM to the server,
 * appends only final transcripts as normal user messages (so the normal chat turn runs with RAG, tools, memory,
 * approvals, compaction, cancellation and usage), speaks the reply sentence by sentence, and cancels both on
 * barge-in. The Realtime engine connects assistant-ui's voice adapter; transcripts land in the same chat.
 */
export class CallController {
  private connection: VoiceConnection | null = null;
  private microphone: Microphone | null = null;
  private player: Player | null = null;
  private vad: VoiceActivity | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeVolume: (() => void) | null = null;
  private utterance = 0;
  private sending: number | null = null;
  /** Utterances whose audio was sent but whose final transcript has not arrived yet. */
  private readonly awaitingFinal = new Set<number>();
  /** Speech that arrived while a final transcript was still on its way; kept so no words are lost. */
  private deferredFrames: Int16Array[] = [];
  private sayId = 0;
  private cancelledThrough = -1;
  private pendingAnswers = new Set<number>();
  private readonly chunker = new SentenceChunker();
  private readonly jitter = new JitterBuffer();
  private playerRate = 0;
  private maxUtteranceSeconds = 60;
  private playerReady: Promise<void> | null = null;
  private readonly waitingAudio: Array<{ id: number; pcm: Uint8Array }> = [];
  private reply = { active: false, messageId: null as string | null, seen: 0, complete: false, after: 0 };
  private drained = true;
  private realtimeConnected = false;
  private realtimeSeen = false;
  private fallingBack = false;
  private endRequested = false;
  private started = false;
  private opening = false;
  private boundThreadKey: string | null = null;
  private offerWaiter: { resolve: (sdp: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly aui: Aui) {}

  get call() {
    return useCall.getState().call;
  }

  /** Opens the socket and asks the server for the chosen engine. */
  async start(engine: CallEngine): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    if (this.started) this.cleanup();
    this.endRequested = false;
    this.fallingBack = false;
    this.realtimeConnected = false;
    this.realtimeSeen = false;
    this.boundThreadKey = this.aui.threadListItem.getState().id;
    this.started = true;
    useCall.getState().dispatch({ type: "open", engine });
    useCall.getState().prefer(engine);
    this.subscribe();
    try {
      const remoteId = this.aui.threadListItem.getState().remoteId ?? (await this.aui.threadListItem.initialize()).remoteId;
      if (!this.started || this.endRequested) return;
      const connection = new VoiceConnection(remoteId, engine, {
        onMessage: (message) => this.onServerMessage(message),
        onAudio: (id, pcm) => this.onAudio(id, pcm),
        onDropped: () => this.fail("network", "The voice connection dropped."),
      });
      this.connection = connection;
      await connection.open();
      if (!this.started) connection.abort();
    } catch (error) {
      if (!this.started) return;
      this.fail("network", error instanceof Error ? error.message : "The voice call could not connect.");
    } finally {
      this.opening = false;
    }
  }

  /** Ends the call, releases every device and network resource, and keeps the summary on screen. */
  end(): void {
    if (this.endRequested || !this.started) {
      useCall.getState().dispatch({ type: "end" });
      return;
    }
    this.endRequested = true;
    this.connection?.close();
    this.release();
    useCall.getState().dispatch({ type: "end" });
  }

  /** Component unmount or tab close: no UI update, no orphaned tracks, socket, WebRTC, or turn. */
  dispose(): void {
    if (this.started) {
      this.endRequested = true;
      this.connection?.close();
    }
    this.cleanup();
    this.started = false;
    // The view is going away (route change, unmount, bfcache): it must not reopen later as a dead call.
    useCall.getState().closeCall();
  }

  /** Mutes the microphone (or the Realtime session's input track) without ending the call. */
  setMuted(muted: boolean): void {
    useCall.getState().dispatch({ type: "mute", muted });
    if (this.call.engine === "realtime" && this.realtimeConnected) {
      try {
        if (muted) this.aui.thread.muteVoice();
        else this.aui.thread.unmuteVoice();
      } catch {}
      return;
    }
    this.microphone?.mute(muted);
  }

  private subscribe() {
    this.unsubscribe?.();
    this.unsubscribe = this.aui.subscribe(() => this.tick());
    this.unsubscribeVolume?.();
    this.unsubscribeVolume = this.aui.thread.subscribeVoiceVolume(() => {
      useCall.getState().setLevel(this.aui.thread.getVoiceVolume());
    });
  }

  private tick() {
    if (!this.started || this.endRequested) return;
    // A call belongs to the chat that started it. Switching chats ends it instead of routing audio elsewhere.
    if (this.boundThreadKey && this.aui.threadListItem.getState().id !== this.boundThreadKey) {
      this.fail("thread", "This call belongs to another chat and was ended.");
      return;
    }
    const state = this.call;
    if (state.engine === "realtime" || this.realtimeConnected) {
      const voice = this.aui.thread.getState().voice;
      if (voice) {
        this.realtimeConnected = true;
        this.realtimeSeen = true;
        if (voice.isMuted !== state.muted) useCall.getState().dispatch({ type: "mute", muted: voice.isMuted });
        if (voice.status.type === "ended") {
          if (voice.status.reason === "error") this.realtimeFailed(callFailure(state) || "The Realtime session ended unexpectedly.");
        } else if (voice.mode === "speaking" && state.phase !== "speaking") {
          useCall.getState().dispatch({ type: "speaking" });
        } else if (voice.mode === "listening" && state.phase === "speaking") {
          useCall.getState().dispatch({ type: "listening" });
        }
      } else if (this.realtimeSeen && this.realtimeConnected) {
        this.realtimeFailed("The Realtime session ended.");
      }
      return;
    }
    this.readReply();
  }

  private onServerMessage(message: ServerMessage) {
    if (!this.started || this.endRequested) return;
    const store = useCall.getState();
    switch (message.t) {
      case "preparing":
        store.dispatch({ type: "preparing" });
        return;
      case "ready":
        this.maxUtteranceSeconds = Math.max(5, Math.min(60, message.maxUtteranceSeconds));
        // Switching engines on the same socket (Realtime → local) must abandon any SDP waiter and the
        // assistant-ui voice session before the microphone starts, or a late Realtime failure would tear
        // down the working local call.
        if (message.engine === "local" && (this.call.engine === "realtime" || this.realtimeConnected)) this.leaveRealtime();
        store.dispatch({
          type: "ready",
          engine: message.engine,
          voice: message.voice,
          ...(message.model ? { model: message.model } : {}),
          ...(message.fallback ? { fallback: message.fallback } : {}),
        });
        if (message.engine === "local") void this.startLocal();
        else this.connectRealtime();
        return;
      case "partial":
        if (message.id === this.utterance) store.dispatch({ type: "partial", text: message.text });
        return;
      case "final":
        this.onFinal(message.id, message.text);
        return;
      case "audio":
        this.playerRate = message.rate;
        this.preparePlayer(message.rate);
        return;
      case "said":
        this.onSaid(message.id, message.ok);
        return;
      case "rt.answer":
        this.answerOffer(message.sdp);
        return;
      case "error":
        if (message.fatal) this.fail(message.code, message.detail);
        else store.setNotice(message.code);
        return;
      case "ended":
        this.onEnded(message.reason);
        return;
      case "pong":
        return;
    }
  }

  private onEnded(reason: CallErrorCode | "user") {
    // The server sends fatal reasons (duration, idle, replaced) as `ended` without a separate error.
    if (reason === "user") {
      this.release();
      useCall.getState().dispatch({ type: "end" });
      return;
    }
    this.fail(reason, reason === "replaced" ? "This call was taken over by another tab or device." : "The call ended.");
  }

  // ---- local media ----

  private async startLocal() {
    if (!this.started || this.endRequested) return;
    this.microphone = new Microphone();
    this.vad = new VoiceActivity(Math.round(CALL_INPUT_RATE * 0.04), {
      sampleRate: CALL_INPUT_RATE,
      maxUtteranceMs: this.maxUtteranceSeconds * 1000,
    });
    try {
      await this.microphone.start((pcm) => this.onFrame(pcm));
    } catch (error) {
      const media = error instanceof CallMediaError ? error : new CallMediaError("media", "The microphone could not start.");
      this.fail(media.code === "media" ? "mic" : media.code, media.message);
      return;
    }
    if (!this.started || this.endRequested) {
      void this.microphone.stop();
      this.microphone = null;
      return;
    }
    useCall.getState().dispatch({ type: "listening" });
  }

  private onFrame(pcm: Int16Array) {
    if (!this.vad || !this.started || this.endRequested || this.connection?.isOpen === false) return;
    // One turn at a time: audio that arrives while a final transcript is in flight is held briefly, then
    // replayed through the detector. This keeps a fast follow-up question from starting a second chat turn
    // on top of the first.
    if (this.awaitingFinal.size > 0 && this.sending === null) {
      this.deferredFrames.push(pcm);
      if (this.deferredFrames.length > 125) this.deferredFrames.shift();
      return;
    }
    this.processFrame(pcm);
  }

  private processFrame(pcm: Int16Array) {
    const vad = this.vad;
    if (!vad || !this.started || this.endRequested) return;
    useCall.getState().setLevel(vad.displayLevel);
    const float = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) float[i] = pcm[i]! / 32768;
    const event = vad.push(float);
    if (!vad.isSpeaking) useCall.getState().setLevel(vad.displayLevel);
    if (event?.type === "start") {
      if (isBusy(this.call.phase)) this.bargeIn();
      this.utterance++;
      this.sending = this.utterance;
      this.awaitingFinal.add(this.sending);
      this.connection?.send({ t: "utt.start", id: this.sending });
      for (const frame of event.preRoll) this.connection?.sendAudio(toPcm(frame));
      return;
    }
    if (event?.type === "end") {
      const id = this.sending;
      this.sending = null;
      if (id === null) return;
      if (event.accepted) {
        this.connection?.send({ t: "utt.end", id });
        useCall.getState().dispatch({ type: "turn" });
      } else {
        this.awaitingFinal.delete(id);
        this.connection?.send({ t: "utt.cancel", id });
      }
      return;
    }
    if (this.sending !== null) this.connection?.sendAudio(pcm);
  }

  private bargeIn() {
    if (!isBusy(this.call.phase)) return;
    this.cancelSpeech();
    this.connection?.send({ t: "say.cancel" });
    try {
      this.aui.thread.cancelRun();
    } catch {}
    this.reply.active = false;
    this.chunker.reset();
    useCall.getState().dispatch({ type: "interrupted" });
  }

  private onFinal(id: number, text: string) {
    // A later utterance may already be recording when an earlier final arrives; each final still becomes
    // its own message, in the order the server finished them.
    if (!this.awaitingFinal.delete(id)) return;
    const spoken = text.trim();
    if (!spoken) {
      if (id === this.utterance && this.call.phase === "thinking") useCall.getState().dispatch({ type: "listening" });
      this.flushDeferred();
      return;
    }
    useCall.getState().dispatch({ type: "turn" });
    // Only assistant messages that appear after this user message belong to this turn; the previous reply is
    // still in the list for a moment and must never be spoken again.
    this.reply = { active: true, messageId: null, seen: 0, complete: false, after: this.aui.thread.getState().messages.length };
    this.chunker.reset();
    try {
      this.aui.thread.append({
        role: "user",
        content: [{ type: "text", text: spoken }],
        metadata: { modality: "voice", custom: { voiceCall: "local" } },
      });
    } catch {
      this.fail("failed", "The transcript could not be added to this chat.");
      return;
    }
    this.flushDeferred();
  }

  /** Replays speech held while a final transcript was on its way. */
  private flushDeferred() {
    if (this.awaitingFinal.size > 0 || !this.deferredFrames.length) return;
    const frames = this.deferredFrames;
    this.deferredFrames = [];
    for (const frame of frames) this.processFrame(frame);
  }

  // ---- reply text → sentences ----

  private readReply() {
    if (!this.reply.active) return;
    const state = this.aui.thread.getState();
    const messages = state.messages;
    let assistant: (typeof messages)[number] | undefined;
    for (let i = messages.length - 1; i >= this.reply.after; i--) {
      if (messages[i]!.role === "assistant") {
        assistant = messages[i];
        break;
      }
    }
    if (!assistant) return;
    if (this.reply.messageId !== assistant.id) {
      if (this.reply.messageId) this.flushReply();
      this.reply.messageId = assistant.id;
      this.reply.seen = 0;
      this.reply.complete = false;
      this.chunker.reset();
    }
    const text = textOf(assistant as { content: readonly { type: string; text?: string }[] });
    // Text normally only grows; an edit or a reload can shrink it, so start the sentence over.
    if (text.length < this.reply.seen) {
      this.reply.seen = 0;
      this.chunker.reset();
    }
    if (text.length > this.reply.seen) {
      const delta = text.slice(this.reply.seen);
      this.reply.seen = text.length;
      for (const sentence of this.chunker.push(delta)) this.say(sentence);
    }
    const status = (assistant as { status?: { type?: string } }).status;
    if (!state.isRunning && status?.type !== "running" && status?.type !== "requires-action") {
      this.reply.complete = true;
      this.flushReply();
      this.maybeListening();
    }
  }

  private flushReply() {
    for (const sentence of this.chunker.flush()) this.say(sentence);
  }

  private say(text: string) {
    if (!text.trim() || !this.connection?.isOpen) return;
    const id = ++this.sayId;
    this.pendingAnswers.add(id);
    this.connection.send({ t: "say", id, text: text.slice(0, 1500) });
  }

  // ---- playback ----

  private preparePlayer(rate: number) {
    if (!this.player) {
      this.player = new Player();
      this.player.onEmpty = () => {
        this.drained = true;
        this.maybeListening();
      };
    }
    if (this.playerReady && this.playerRate === rate) return;
    this.playerRate = rate;
    this.playerReady = this.player
      .ensure(rate)
      .then(() => {
        if (!this.started || this.endRequested) return;
        const waiting = this.waitingAudio.splice(0);
        for (const item of waiting) this.pushAudio(item.id, item.pcm);
      })
      .catch(() => {
        // No AudioWorklet (a hardened browser): say so instead of a call that silently never speaks.
        this.fail("failed", "This browser could not start audio playback.");
      });
  }

  private onAudio(id: number, pcm: Uint8Array) {
    if (id <= this.cancelledThrough) return;
    if (!this.player) return;
    if (!this.playerReady) {
      this.waitingAudio.push({ id, pcm });
      return;
    }
    this.pushAudio(id, pcm);
  }

  private pushAudio(id: number, pcm: Uint8Array) {
    if (id <= this.cancelledThrough) return;
    this.jitter.push(id, new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1));
    this.drained = false;
    if (this.call.phase !== "interrupted") useCall.getState().dispatch({ type: "speaking" });
    this.pumpAudio();
  }

  private pumpAudio() {
    const player = this.player;
    if (!player) return;
    for (;;) {
      if (!this.jitter.ready) return;
      const chunk = this.jitter.take();
      if (!chunk) return;
      player.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
  }

  private onSaid(id: number, ok: boolean) {
    this.pendingAnswers.delete(id);
    this.jitter.complete(id);
    if (!ok) useCall.getState().setNotice("voice");
    this.pumpAudio();
    if (this.pendingAnswers.size === 0 && this.drained) this.maybeListening();
  }

  private cancelSpeech() {
    this.cancelledThrough = this.sayId;
    this.pendingAnswers.clear();
    this.waitingAudio.length = 0;
    this.jitter.cancel();
    this.player?.cancel();
    this.drained = true;
  }

  private maybeListening() {
    if (!this.started || this.endRequested) return;
    if (this.call.phase === "interrupted") return;
    if (!this.drained || this.pendingAnswers.size > 0) return;
    if (this.reply.active && !this.reply.complete) return;
    if (this.call.phase === "speaking" || this.call.phase === "thinking") {
      const spoke = this.call.phase === "speaking";
      useCall.getState().dispatch({ type: "listening" });
      if (spoke) this.ding();
    }
  }

  private ding() {
    if (!useData.getState().settings?.speech?.call?.ding) return;
    try {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.03, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.2);
      oscillator.onended = () => void context.close().catch(() => {});
    } catch {}
  }

  // ---- realtime ----

  private connectRealtime() {
    this.realtimeConnected = true;
    bridge = {
      exchangeSdp: (sdp, signal) => this.exchangeSdp(sdp, signal),
      onFailure: (reason) => this.realtimeFailed(reason),
    };
    try {
      this.aui.thread.connectVoice();
    } catch (error) {
      this.realtimeFailed(error instanceof Error ? error.message : "The Realtime session could not start.");
    }
  }

  private exchangeSdp(sdp: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.connection?.isOpen) return reject(new Error("The call socket is closed."));
      // Only one offer is in flight; a replaced one must not reject the new waiter when its timer fires.
      const previous = this.offerWaiter;
      this.offerWaiter = null;
      if (previous) {
        clearTimeout(previous.timer);
        previous.reject(new Error("A newer offer replaced this one."));
      }
      const timer = setTimeout(() => this.rejectOffer(new Error("OpenAI Realtime did not answer in time.")), 25_000);
      this.offerWaiter = { resolve, reject, timer };
      signal.addEventListener("abort", () => this.rejectOffer(new Error("The Realtime session was cancelled.")), { once: true });
      this.connection.send({ t: "rt.offer", sdp });
    });
  }

  private answerOffer(sdp: string) {
    const waiter = this.offerWaiter;
    this.offerWaiter = null;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.resolve(sdp);
  }

  private rejectOffer(error: Error) {
    const waiter = this.offerWaiter;
    this.offerWaiter = null;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  /** Drops the Realtime half without reporting a failure: the server has already moved this call to local. */
  private leaveRealtime() {
    this.realtimeConnected = false;
    this.realtimeSeen = false;
    this.fallingBack = true;
    bridge = null;
    this.rejectOffer(new Error("The call switched to the local engine."));
    try {
      this.aui.thread.disconnectVoice();
    } catch {}
  }

  private realtimeFailed(reason: string) {
    if (!this.started || this.endRequested || this.fallingBack) return;
    this.fallingBack = true;
    this.realtimeConnected = false;
    bridge = null;
    this.rejectOffer(new Error(reason));
    try {
      this.aui.thread.disconnectVoice();
    } catch {}
    if (!this.connection?.isOpen) {
      this.fail("network", "The call connection was lost before it could fall back.");
      return;
    }
    useCall.getState().dispatch({ type: "preparing" });
    // The server switches the existing call to local; its `ready` starts the microphone. If local is not
    // available the server answers with a fatal error instead of leaving a dead screen.
    this.connection.send({ t: "rt.failed", reason: reason.slice(0, 300) });
  }

  // ---- failure and cleanup ----

  private fail(code: CallErrorCode | "mic" | "insecure" | "network", detail: string) {
    if (this.endRequested && code !== "thread") return;
    this.endRequested = true;
    this.release();
    // A failed local start leaves the server's call open; close it so it does not hold the one-call slot.
    this.connection?.close();
    this.connection = null;
    useCall.getState().dispatch({ type: "fail", failure: { code, detail } });
  }

  private release() {
    this.endRequested = true;
    bridge = null;
    this.rejectOffer(new Error("The call ended."));
    void this.microphone?.stop();
    this.microphone = null;
    this.vad = null;
    this.sending = null;
    this.awaitingFinal.clear();
    this.deferredFrames = [];
    this.cancelSpeech();
    void this.player?.dispose();
    this.player = null;
    this.playerReady = null;
    if (this.realtimeConnected) {
      try {
        this.aui.thread.disconnectVoice();
      } catch {}
      this.realtimeConnected = false;
    }
    try {
      if (this.aui.thread.getState().isRunning) this.aui.thread.cancelRun();
    } catch {}
    useCall.getState().setLevel(0);
  }

  private cleanup() {
    this.release();
    this.connection?.abort();
    this.connection = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeVolume?.();
    this.unsubscribeVolume = null;
    this.reply = { active: false, messageId: null, seen: 0, complete: false, after: 0 };
    this.chunker.reset();
    this.started = false;
  }
}
