import type { CallEngine, CallErrorCode } from "@shared/voice";

// The call view's state machine, kept pure so every transition is testable without a microphone or a socket.
// A call is idle → starting → preparing? → listening ⇄ thinking → speaking → interrupted → … → ended/error.

export type CallPhase = "idle" | "starting" | "preparing" | "listening" | "thinking" | "speaking" | "interrupted" | "ended" | "error";

export interface CallFailure {
  /** `chatBusy` and `chatLoading` are web-only: the chat cannot take a spoken turn right now. */
  code: CallErrorCode | "mic" | "insecure" | "network" | "chatBusy" | "chatLoading";
  /** English diagnostic from the server or the browser; the UI never shows it raw. */
  detail: string;
  fix?: string;
}

export interface CallState {
  phase: CallPhase;
  engine: CallEngine;
  voice: string;
  model?: string;
  muted: boolean;
  /** The user spoke over the assistant: shown until the next turn lands. */
  interrupted: boolean;
  failure?: CallFailure;
  /** `Date.now()` when the call became active. */
  startedAt?: number;
  /** Another engine was requested; the UI says why it is not in use. */
  fallback?: { code: CallErrorCode; detail: string };
  /** The live, not-yet-final transcript from the server. */
  partial: string;
}

export type CallEvent =
  | { type: "open"; engine: CallEngine }
  | { type: "preparing" }
  | { type: "ready"; engine: CallEngine; voice: string; model?: string; fallback?: { code: CallErrorCode; detail: string } }
  | { type: "partial"; text: string }
  | { type: "turn" }
  | { type: "speaking" }
  | { type: "listening" }
  | { type: "interrupted" }
  | { type: "mute"; muted: boolean }
  | { type: "end" }
  | { type: "fail"; failure: CallFailure }
  | { type: "reset" };

export const initialCallState = (engine: CallEngine = "local"): CallState => ({
  phase: "idle",
  engine,
  voice: "",
  muted: false,
  interrupted: false,
  partial: "",
});

const ACTIVE: readonly CallPhase[] = ["preparing", "listening", "thinking", "speaking", "interrupted"];

export function callReducer(state: CallState, event: CallEvent): CallState {
  switch (event.type) {
    case "open":
      return { ...initialCallState(event.engine), phase: "starting" };
    case "preparing":
      // Realtime falls back to the same socket and reports Preparing again while local models warm.
      return state.phase === "ended" || state.phase === "error" ? state : { ...state, phase: "preparing" };
    case "ready":
      return {
        ...state,
        phase: "listening",
        engine: event.engine,
        voice: event.voice,
        model: event.model,
        fallback: event.fallback,
        startedAt: state.startedAt ?? Date.now(),
        partial: "",
        interrupted: false,
      };
    case "partial":
      return ACTIVE.includes(state.phase) ? { ...state, partial: event.text } : state;
    case "turn":
      return ACTIVE.includes(state.phase) ? { ...state, phase: "thinking", partial: "", interrupted: false } : state;
    case "speaking":
      // A cancelled reply may still deliver a sentence; it must not pull the call out of "interrupted".
      if (state.phase === "interrupted") return state;
      return ACTIVE.includes(state.phase) ? { ...state, phase: "speaking", interrupted: false } : state;
    case "listening":
      return ACTIVE.includes(state.phase) ? { ...state, phase: "listening" } : state;
    case "interrupted":
      return state.phase === "speaking" || state.phase === "thinking"
        ? { ...state, phase: "interrupted", interrupted: true, partial: "" }
        : state;
    case "mute":
      return { ...state, muted: event.muted };
    case "end":
      return { ...state, phase: "ended", partial: "", muted: false, interrupted: false };
    case "fail":
      return { ...state, phase: "error", failure: event.failure, partial: "" };
    case "reset":
      return initialCallState(state.engine);
  }
}

/** Listening after an interruption is still listening; the notice clears on the next turn. */
export const isActive = (phase: CallPhase) => ACTIVE.includes(phase);
export const isBusy = (phase: CallPhase) => phase === "thinking" || phase === "speaking" || phase === "interrupted";
