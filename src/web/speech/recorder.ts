import type { DictationAdapter } from "@assistant-ui/react";
import { t } from "@/i18n";
import { useData } from "@/state/data";
import { useServices } from "@/state/services";
import { speechFetch, useSpeech } from "./store";

type Session = DictationAdapter.Session;
type Result = DictationAdapter.Result;

// Formats MediaRecorder offers, best first. Every server engine accepts these.
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4", "audio/wav"];
/** Level above which the input counts as speech. LibreChat's default. */
const SPEECH_DB = -45;

export interface RecorderOptions {
  /** Stop after this many seconds of silence once speech was heard. 0 records until stopped. */
  silenceSeconds: number;
  maxSeconds: number;
  language?: string;
}

let liveLevel: (() => number) | null = null;
/** Input level of the recording in progress, 0–1, or null when nothing is recording. Drives the waveform. */
export const recordingLevel = () => liveLevel?.() ?? null;

/** RMS level of the analyser's current window in dB. */
export function levelDb(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const s of samples) sum += s * s;
  return 20 * Math.log10(Math.sqrt(sum / samples.length) || 1e-8);
}

/** Maps dB to 0–1 for display: −60 dB is silence, −15 dB fills the bar. */
export const displayLevel = (db: number) => Math.min(1, Math.max(0, (db + 60) / 45));

/** Microphone access needs HTTPS or localhost. Elsewhere the button picks or records an audio file instead. */
export const canRecord = () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined" && window.isSecureContext;

/** Uploads audio to /api/speech/transcribe and returns the text. */
export async function transcribeBlob(blob: Blob, filename: string, language?: string, signal?: AbortSignal): Promise<string> {
  // Only the server Whisper engine needs the speech worker; cloud engines do not.
  if ((useData.getState().settings?.speech?.stt?.engine ?? "") === "local") useServices.getState().markUsed("speech");
  const form = new FormData();
  form.append("file", blob, filename);
  if (language) form.append("language", language);
  if (useSpeech.getState().temporaryChat()) form.append("temporary", "1");
  const res = await speechFetch("/speech/transcribe", { method: "POST", body: form, signal });
  return ((await res.json()) as { text: string }).text;
}

/**
 * Dictation through a server engine (local Whisper or a cloud service): records with MediaRecorder, then
 * transcribes the whole recording when it stops. The recording lives only in this tab's memory and the request.
 */
export class RecorderDictationAdapter implements DictationAdapter {
  constructor(private readonly options: () => RecorderOptions) {}

  listen(): Session {
    const opts = this.options();
    const speechStart = new Set<() => void>();
    const speechEnd = new Set<(r: Result) => void>();
    const speech = new Set<(r: Result) => void>();
    const controller = new AbortController();
    let finished: () => void = () => {};
    const done = new Promise<void>((resolve) => (finished = resolve));
    let cleanup: () => void = () => {};
    let stopRequested = false;
    // Until the microphone is open, stopping only marks the request; the recorder stops as soon as it starts.
    let stopRecording: () => void = () => void (stopRequested = true);
    let ended = false;

    const session: Session = {
      status: { type: "starting" },
      stop: async () => {
        stopRecording();
        await done;
      },
      cancel: () => {
        controller.abort();
        end("cancelled");
      },
      onSpeechStart: (cb) => (speechStart.add(cb), () => void speechStart.delete(cb)),
      onSpeechEnd: (cb) => (speechEnd.add(cb), () => void speechEnd.delete(cb)),
      onSpeech: (cb) => (speech.add(cb), () => void speech.delete(cb)),
    };

    const end = (reason: "stopped" | "cancelled" | "error", transcript?: string) => {
      if (ended) return;
      ended = true;
      cleanup();
      useSpeech.setState({ transcribing: false });
      if (transcript) speech.forEach((cb) => cb({ transcript, isFinal: true }));
      session.status = { type: "ended", reason };
      speechEnd.forEach((cb) => cb({ transcript: transcript ?? "" }));
      finished();
    };

    const transcribe = async (blob: Blob, filename: string) => {
      if (controller.signal.aborted) return;
      if (blob.size < 1000) return end("stopped");
      useSpeech.setState({ transcribing: true, error: null });
      try {
        const text = (await transcribeBlob(blob, filename, opts.language, controller.signal)).trim();
        end("stopped", text);
      } catch (error) {
        if (controller.signal.aborted) return;
        useSpeech.getState().setError((error as Error).message);
        end("error");
      }
    };

    if (!canRecord()) {
      // Opened inside the click that started dictation, so the browser allows the picker. Phones offer their recorder.
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "audio/*";
      input.setAttribute("capture", "");
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (file) void transcribe(file, file.name);
        else end("cancelled");
      });
      input.addEventListener("cancel", () => end("cancelled"));
      stopRecording = () => end("cancelled");
      session.status = { type: "running" };
      input.click();
      return session;
    }

    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (error) {
        const name = (error as Error).name;
        useSpeech.getState().setError(name === "NotAllowedError" ? t("speech.micBlocked") : t("speech.noMic"));
        return end("error");
      }
      if (controller.signal.aborted) return stream.getTracks().forEach((t) => t.stop());
      if (stopRequested) {
        stream.getTracks().forEach((t) => t.stop());
        return end("cancelled");
      }
      const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined);
      const chunks: Blob[] = [];
      recorder.addEventListener("dataavailable", (e) => e.data.size && chunks.push(e.data));
      recorder.addEventListener("stop", () => {
        const type = recorder.mimeType || mimeType || "audio/webm";
        const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm";
        void transcribe(new Blob(chunks, { type }), `recording.${ext}`);
        chunks.length = 0;
      });

      // Silence detection and the length cap.
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const started = Date.now();
      let heard = false;
      let quietSince = Date.now();
      const tick = setInterval(() => {
        const db = levelDb(analyser, samples);
        if (db > SPEECH_DB) {
          if (!heard) speechStart.forEach((cb) => cb());
          heard = true;
          quietSince = Date.now();
        }
        const silent = opts.silenceSeconds > 0 && heard && Date.now() - quietSince > opts.silenceSeconds * 1000;
        if (silent || Date.now() - started > opts.maxSeconds * 1000) stopRecording();
      }, 100);

      const levelSamples = new Float32Array(analyser.fftSize);
      const level = () => displayLevel(levelDb(analyser, levelSamples));
      liveLevel = level;
      const dropLevel = () => void (liveLevel === level && (liveLevel = null));

      cleanup = () => {
        clearInterval(tick);
        dropLevel();
        if (recorder.state !== "inactive") recorder.stop();
        stream.getTracks().forEach((t) => t.stop());
        void context.close().catch(() => {});
      };
      stopRecording = () => {
        clearInterval(tick);
        dropLevel();
        stream.getTracks().forEach((t) => t.stop());
        if (recorder.state !== "inactive") recorder.stop();
      };
      recorder.start(250);
      session.status = { type: "running" };
    })();
    return session;
  }
}
