import type { CallErrorCode } from "@shared/voice";
import type { PlainMessageKey } from "@/i18n";
import type { CallFailure } from "./state";

// Every way a call can fail has a translated reason, a translated fix, and Retry. No dead screens.
export type CallFailureCode = CallFailure["code"];

export const FAILURE_TEXT: Record<CallFailureCode, { title: PlainMessageKey; fix: PlainMessageKey }> = {
  mic: { title: "voice.callErrMic", fix: "voice.callFixMic" },
  origin: { title: "voice.callErrOrigin", fix: "voice.callFixOrigin" },
  insecure: { title: "voice.callErrInsecure", fix: "voice.callFixInsecure" },
  unavailable: { title: "voice.callErrUnavailable", fix: "voice.callFixUnavailable" },
  worker: { title: "voice.callErrWorker", fix: "voice.callFixWorker" },
  model: { title: "voice.callErrModel", fix: "voice.callFixModel" },
  voice: { title: "voice.callErrVoice", fix: "voice.callFixVoice" },
  network: { title: "voice.callErrNetwork", fix: "voice.callFixNetwork" },
  busy: { title: "voice.callErrBusy", fix: "voice.callFixBusy" },
  rate: { title: "voice.callErrRate", fix: "voice.callFixRate" },
  thread: { title: "voice.callErrThread", fix: "voice.callFixThread" },
  limit: { title: "voice.callErrLimit", fix: "voice.callFixLimit" },
  idle: { title: "voice.callErrIdle", fix: "voice.callFixIdle" },
  duration: { title: "voice.callErrDuration", fix: "voice.callFixDuration" },
  realtime: { title: "voice.callErrRealtime", fix: "voice.callFixRealtime" },
  replaced: { title: "voice.callErrReplaced", fix: "voice.callFixReplaced" },
  protocol: { title: "voice.callErrProtocol", fix: "voice.callFixProtocol" },
  unauthorized: { title: "voice.callErrUnauthorized", fix: "voice.callFixUnauthorized" },
  failed: { title: "voice.callErrFailed", fix: "voice.callFixFailed" },
  chatBusy: { title: "voice.callErrChatBusy", fix: "voice.callFixChatBusy" },
  chatLoading: { title: "voice.callErrChatLoading", fix: "voice.callFixChatLoading" },
};

/** A non-fatal server notice; these never stop the call. */
export function noticeText(code: CallErrorCode): PlainMessageKey {
  switch (code) {
    case "voice":
      return "voice.callNoticeVoice";
    case "idle":
      return "voice.callNoticeIdle";
    case "worker":
      return "voice.callErrWorker";
    case "model":
      return "voice.callErrModel";
    case "protocol":
      return "voice.callErrProtocol";
    default:
      return "voice.callNoticeLimit";
  }
}
