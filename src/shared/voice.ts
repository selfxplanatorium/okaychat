/** Voice call protocol between the browser and `/api/voice/call`. See docs/implementation/voice-calls.md. Keep free of runtime imports. */

export type CallEngine = "local" | "realtime";

/** Per-account call preferences, stored in `settings.speech.call`. */
export interface CallSettings {
  /** Engine a new call starts with. Default `local`. */
  engine?: CallEngine;
  /** Realtime voice; the local engine uses the read-aloud Piper voice or the admin default. */
  realtimeVoice?: string;
  /** A soft tone when the assistant starts listening again. Off by default. */
  ding?: boolean;
}

/** Microphone audio sent to the server: PCM16 little endian, mono. */
export const CALL_INPUT_RATE = 16_000;
/** Bytes in one binary audio frame from the client: 40 ms. */
export const CALL_FRAME_BYTES = (CALL_INPUT_RATE / 25) * 2;
/** Binary frames from the server start with a little-endian u32 sentence id, then PCM16. */
export const CALL_AUDIO_HEADER = 4;

/** Stable failure codes. The client maps each to a translated message and a fix. */
export type CallErrorCode =
  | "unauthorized"
  | "origin"
  | "busy"
  | "rate"
  | "unavailable"
  | "worker"
  | "model"
  | "voice"
  | "thread"
  | "limit"
  | "idle"
  | "duration"
  | "realtime"
  | "protocol"
  | "replaced"
  | "failed";

export type ClientMessage =
  /** First message. `takeover` ends this account's call in another tab or device. */
  | { t: "start"; threadId: string; engine: CallEngine; takeover?: boolean }
  /** Binary frames after this belong to utterance `id` until `utt.end` or `utt.cancel`. */
  | { t: "utt.start"; id: number }
  | { t: "utt.end"; id: number }
  | { t: "utt.cancel"; id: number }
  /** One sentence of the reply to speak, in order. */
  | { t: "say"; id: number; text: string }
  /** Barge-in: drop every queued and running sentence. */
  | { t: "say.cancel" }
  | { t: "rt.offer"; sdp: string }
  /** The browser could not keep a Realtime connection; switch this call to the local engine. */
  | { t: "rt.failed"; reason: string }
  | { t: "ping" }
  | { t: "end" };

/** `GET /api/voice`: what this account can start without warming a model. */
export interface CallAvailability {
  /** The server's own Whisper + Piper pipeline. */
  local: boolean;
  /** An OpenAI Realtime session, using a chat or shared OpenAI key. */
  realtime: boolean;
  /** The speech worker is configured (it may still be unreachable). */
  worker: boolean;
  /** The Piper voice a local call would use. */
  voice: string;
  /** The Realtime model and voice a Realtime call would use. */
  model?: string;
  realtimeVoice?: string;
  /** Longest accepted call, in seconds. */
  maxSeconds: number;
  maxUtteranceSeconds: number;
  /** Why `local` is false; English diagnostic, the client shows its own text. */
  localReason?: { code: CallErrorCode; detail: string };
  realtimeReason?: { code: CallErrorCode; detail: string };
}

export interface CallReady {
  t: "ready";
  engine: CallEngine;
  /** Display name of the voice. */
  voice: string;
  /** Hard limit of this call in seconds, counted from the start. */
  maxSeconds: number;
  /** Longest single utterance accepted, in seconds. */
  maxUtteranceSeconds: number;
  /** Set when another engine was requested; English diagnostic, the client shows its own text. */
  fallback?: { code: CallErrorCode; detail: string };
  /** Realtime only: the model the session uses. */
  model?: string;
}

export type ServerMessage =
  /** Models are loading (or downloading on the first call). */
  | { t: "preparing" }
  | CallReady
  | { t: "partial"; id: number; text: string }
  | { t: "final"; id: number; text: string }
  /** Audio for sentence `id` follows as binary frames at `rate` Hz. */
  | { t: "audio"; id: number; rate: number }
  /** Sentence `id` is complete; `ok: false` when it could not be synthesized. */
  | { t: "said"; id: number; ok: boolean }
  | { t: "rt.answer"; sdp: string }
  | { t: "error"; code: CallErrorCode; detail: string; fatal: boolean }
  | { t: "ended"; reason: CallErrorCode | "user"; seconds: number }
  | { t: "pong" };
