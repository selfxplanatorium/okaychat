import { finiteCredits } from "../credits/admission.js";
import type { UIMessage } from "ai";
import { HTTPException } from "hono/http-exception";
import { ttsEngineDef } from "../../shared/speech.js";
import type { CallAvailability, CallEngine, CallErrorCode } from "../../shared/voice.js";
import { modelAccessMessage, sharedModelAccess } from "../entitlements.js";
import { AppError } from "../errors.js";
import { promptText } from "../prompts.js";
import { wrapUntrusted } from "../prompt-injection.js";
import { getSettings } from "../settings.js";
import { reportServiceSuccess } from "../services.js";
import { adminSpeech } from "../speech/config.js";
import { credentialFor, upstream, type ResolvedCredential } from "../speech/engines.js";
import { speechWorkerConfigured, fetchWorkerHealth, workerRelease, workerSpeak, workerTranscribePcm, workerWarm } from "../speech/worker.js";
import { currentBranch, getThread } from "../threads.js";
import { callLimits } from "./limits.js";
import { featureAllowed, modelAllowed } from "../permissions/guard.js";

// What a call needs from the outside world, behind small interfaces so the session can be tested with fakes:
// the local pipeline (speech worker Whisper + Piper) and the OpenAI Realtime signalling exchange.

export class CallFailure extends Error {
  constructor(readonly code: CallErrorCode, detail: string) {
    super(detail);
  }
}

/** Speech for the local engine. Audio and text pass through memory only. */
export interface LocalSpeech {
  /** Display name of the Piper voice. */
  voice: string;
  /** Loads Whisper and the voice, downloading them on a first call. Throws `CallFailure`. */
  warm(signal: AbortSignal): Promise<void>;
  /** PCM16 16 kHz mono. A partial returns null when the engine is busy. */
  transcribe(pcm: Uint8Array, partial: boolean, signal: AbortSignal): Promise<string | null>;
  /** One sentence as PCM16 mono at `rate`. */
  speak(text: string, signal: AbortSignal): Promise<{ pcm: Uint8Array; rate: number }>;
}

/** Signalling for an OpenAI Realtime WebRTC session; the key never leaves the server. */
export interface RealtimeSignal {
  model: string;
  voice: string;
  /** Posts the browser's SDP offer and returns OpenAI's SDP answer. */
  answer(sdp: string, signal: AbortSignal): Promise<string>;
}

export type Availability<T> = { ok: true; value: T } | { ok: false; code: CallErrorCode; detail: string };

export interface CallBackends {
  local(userId: string): Availability<LocalSpeech>;
  realtime(userId: string, threadId: string): Availability<RealtimeSignal>;
  /** The last active call on this server ended: engines may return their memory. */
  released(): void;
}

export type Selection = { engine: CallEngine; fallback?: { code: CallErrorCode; detail: string } } | { error: { code: CallErrorCode; detail: string } };

/**
 * Engine for a new call. Realtime falls back to the local pipeline with its reason. The local pipeline never
 * falls back to the cloud: a user who chose local audio must not find it sent to OpenAI.
 */
export function selectEngine(requested: CallEngine, local: Availability<unknown>, realtime: () => Availability<unknown>): Selection {
  if (requested === "realtime") {
    const rt = realtime();
    if (rt.ok) return { engine: "realtime" };
    if (local.ok) return { engine: "local", fallback: { code: rt.code, detail: rt.detail } };
    return { error: { code: rt.code, detail: rt.detail } };
  }
  if (local.ok) return { engine: "local" };
  return { error: { code: local.code, detail: local.detail } };
}

const PIPER_VOICE = /^[a-z]{2,3}_[A-Z]{2}-[A-Za-z0-9_]+-(x_low|low|medium|high)$/;

/** Reads the PCM16 samples and sample rate out of the WAV Piper returns. */
export function wavPcm(wav: Uint8Array): { pcm: Uint8Array; rate: number } {
  const buf = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let rate = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("latin1", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      if (buf.readUInt16LE(body) !== 1 || buf.readUInt16LE(body + 2) !== 1 || buf.readUInt16LE(body + 14) !== 16) throw new Error("WAV is not PCM16 mono");
      rate = buf.readUInt32LE(body + 4);
    } else if (id === "data") {
      if (!rate) throw new Error("WAV data before format");
      const end = Math.min(buf.length, body + size);
      return { pcm: new Uint8Array(buf.buffer, buf.byteOffset + body, (end - body) & ~1), rate };
    }
    offset = body + size + (size & 1);
  }
  throw new Error("WAV has no data");
}

/** The Piper voice a call speaks with: the account's read-aloud voice, else the admin's default. */
export function callVoice(userId: string): string {
  const chosen = getSettings(userId).speech?.tts?.voices?.local;
  return chosen && PIPER_VOICE.test(chosen) ? chosen : adminSpeech().local.defaultVoice;
}

function workerLocal(userId: string): Availability<LocalSpeech> {
  const admin = adminSpeech();
  if (!speechWorkerConfigured()) return { ok: false, code: "unavailable", detail: "This server has no speech worker." };
  if (!admin.local.stt || !admin.local.tts) return { ok: false, code: "unavailable", detail: "Whisper or Piper on this server is turned off by the admin." };
  const prefs = getSettings(userId).speech;
  const voice = callVoice(userId);
  const speed = Math.min(2, Math.max(0.5, prefs?.tts?.speed ?? 1));
  const language = prefs?.stt?.language || undefined;
  return {
    ok: true,
    value: {
      voice,
      async warm(signal) {
        const failure = await workerCallFailure();
        if (failure) throw new CallFailure(failure.code, failure.detail);
        const fail = (code: CallErrorCode) => (error: unknown) => {
          if (signal.aborted) throw error;
          // A worker that went away between /health and /warm is not a missing model.
          const workerDown = (error instanceof AppError && error.code === "service_unavailable") || (error instanceof HTTPException && error.status === 502);
          throw new CallFailure(workerDown ? "worker" : code, error instanceof Error ? error.message : String(error));
        };
        await Promise.all([
          workerWarm("stt", admin.local.whisperModel, signal).catch(fail("model")),
          workerWarm("tts", voice, signal).catch(fail("voice")),
        ]);
      },
      async transcribe(pcm, partial, signal) {
        const result = await workerTranscribePcm(pcm, { model: admin.local.whisperModel, language, vad: partial ? false : admin.local.vad, partial }, signal);
        return result ? result.text.trim() : null;
      },
      async speak(text, signal) {
        try {
          return wavPcm(await workerSpeak(text, { voice, speed }, signal));
        } catch (error) {
          if (signal.aborted) throw error;
          const workerDown = (error instanceof AppError && error.code === "service_unavailable") || (error instanceof HTTPException && error.status === 502);
          throw new CallFailure(workerDown ? "worker" : "voice", error instanceof Error ? error.message : "The voice failed.");
        }
      },
    },
  };
}

/** The chat's recent text turns, so a Realtime call continues the conversation rather than starting over. */
export function realtimeContext(messages: UIMessage[], maxChars = 6000): string {
  const lines: string[] = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = message.parts
      .flatMap((part) => (part.type === "text" && !part.text.startsWith("<attachment") ? [part.text] : []))
      .join("\n")
      .trim();
    if (!text) continue;
    const line = `${message.role === "user" ? "User" : "Assistant"}: ${text.slice(0, 1500)}`;
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines.join("\n\n");
}

const REALTIME_TIMEOUT_MS = 20_000;

interface RealtimeTarget {
  cred: ResolvedCredential;
  model: string;
  voice: string;
  language?: string;
}

/** The OpenAI key, model, voice and language a Realtime session would use. Never includes the key in a return value. */
export function realtimeTarget(userId: string): Availability<RealtimeTarget> {
  const def = ttsEngineDef("openai-realtime")!;
  const cred: ResolvedCredential | undefined = credentialFor(userId, def.credential);
  if (!cred?.apiKey || !cred.baseURL) return { ok: false, code: "unavailable", detail: "No OpenAI connection with a key." };
  const prefs = getSettings(userId).speech;
  const chosenModel = prefs?.tts?.models?.["openai-realtime"];
  const model = chosenModel && /^[\w.-]{1,80}$/.test(chosenModel) ? chosenModel : def.models[0]!;
  // A server-wide key follows the admin's model policy, like every chat model.
  if (cred.conn?.shared) {
    const access = sharedModelAccess(userId, "openai");
    if (!access.visible || (!access.all && !access.ids.has(model))) return { ok: false, code: "unavailable", detail: modelAccessMessage(`openai/${model}`) };
  }
  // The Realtime model is not in the text catalog, but an exact-model policy row still governs it.
  const ref = `${cred.conn?.providerId ?? "openai"}/${model}`;
  if (!modelAllowed(userId, ref)) return { ok: false, code: "unavailable", detail: modelAccessMessage(ref) };
  // Realtime audio has no token price; a finite allowance falls back to the local pipeline.
  if (finiteCredits(userId)) return { ok: false, code: "unavailable", detail: "This service cannot be used with a token allowance. Contact your administrator." };
  const wanted = prefs?.call?.realtimeVoice ?? prefs?.tts?.voices?.["openai-realtime"];
  const voice = wanted && def.voices.includes(wanted) ? wanted : (def.voices.includes("marin") ? "marin" : def.voices[0]!);
  return { ok: true, value: { cred, model, voice, ...(prefs?.stt?.language ? { language: prefs.stt.language } : {}) } };
}

/** Exported for tests: the SDP offer (browser) → answer (OpenAI) exchange. */
export function openaiRealtime(userId: string, threadId: string): Availability<RealtimeSignal> {
  const target = realtimeTarget(userId);
  if (!target.ok) return target;
  const { model, voice, language } = target.value;
  return {
    ok: true,
    value: {
      model,
      voice,
      async answer(sdp, signal) {
        // Microphone/WebRTC setup may outlive a key removal or model revoke; check at the request boundary.
        const live = realtimeTarget(userId);
        if (!live.ok) throw new CallFailure(live.code, live.detail);
        if (live.value.model !== model) throw new CallFailure("realtime", "The Realtime model changed. Start the call again.");
        const { cred } = live.value;
        // The chat may have moved on since the socket opened; read it when the session is created.
        const thread = threadId.startsWith("tmp_") ? null : getThread(userId, threadId);
        const history = thread ? realtimeContext(currentBranch(userId, threadId)) : "";
        const context = history ? wrapUntrusted(history, { kind: "past_chat", name: "this chat so far" }).text : "";
        const session = {
          type: "realtime",
          model,
          instructions: promptText("voiceRealtime", { context }).trim(),
          audio: {
            input: {
              transcription: { model: "gpt-4o-mini-transcribe", ...(language ? { language } : {}) },
              turn_detection: { type: "semantic_vad", create_response: true, interrupt_response: true },
              noise_reduction: { type: "near_field" },
            },
            output: { voice },
          },
        };
        const form = new FormData();
        form.append("sdp", sdp);
        form.append("session", JSON.stringify(session));
        const timeout = AbortSignal.any([signal, AbortSignal.timeout(REALTIME_TIMEOUT_MS)]);
        let res: Response;
        try {
          res = await upstream(cred, `${cred.baseURL}/realtime/calls`, { method: "POST", body: form, headers: { Authorization: `Bearer ${cred.apiKey}` } }, "OpenAI Realtime", timeout);
        } catch (error) {
          if (signal.aborted) throw error;
          throw new CallFailure("realtime", error instanceof HTTPException ? error.message : "OpenAI Realtime could not be reached.");
        }
        const answer = await res.text();
        if (!answer.startsWith("v=0") || answer.length > 20_000) throw new CallFailure("realtime", "OpenAI Realtime returned no session description.");
        return answer;
      },
    },
  };
}

let releasing: Promise<unknown> | null = null;

export const workerBackends: CallBackends = {
  local: workerLocal,
  realtime: openaiRealtime,
  released() {
    if (!speechWorkerConfigured() || releasing) return;
    // Only idle engines stop; a dictation or read-aloud job running for someone else keeps its process.
    releasing = Promise.allSettled([workerRelease("stt"), workerRelease("tts")]).finally(() => (releasing = null));
  },
};

/**
 * A direct `/health` check with a short deadline. Used at call start and for availability so a stale registry
 * entry cannot block a call after the worker returns; it loads no model and starts no engine.
 */
async function workerCallFailure(): Promise<CallAvailability["localReason"]> {
  const offline = { code: "worker" as const, detail: "The speech worker is not reachable." };
  if (!speechWorkerConfigured()) return offline;
  try {
    const health = await fetchWorkerHealth(AbortSignal.timeout(2_000));
    if (!health?.ok) return offline;
    // An older worker still serves dictation/read-aloud. Do not mark the whole service down.
    reportServiceSuccess("speech");
    if (health.voiceCalls !== true) return { code: "workerVersion", detail: "Rebuild the speech worker to enable voice calls." };
    return undefined;
  } catch {
    return offline;
  }
}

export async function voiceAvailability(userId: string): Promise<CallAvailability> {
  const admin = adminSpeech();
  const limits = callLimits();
  // A denied account learns why locally; the worker is not probed for a capability it cannot use.
  if (!featureAllowed(userId, "voice")) {
    const detail = "Voice is disabled for this account.";
    return {
      local: false,
      realtime: false,
      worker: false,
      voice: callVoice(userId),
      maxSeconds: limits.maxSeconds,
      maxUtteranceSeconds: Math.max(5, Math.min(limits.maxUtteranceSeconds, admin.maxRecordingSeconds)),
      localReason: { code: "unavailable", detail },
      realtimeReason: { code: "unavailable", detail },
    };
  }
  const local = workerLocal(userId);
  const target = realtimeTarget(userId);
  // A configured worker may be down; `/health` is cheap, downloads nothing, and does not start a model. If it
  // answers, the pipeline is reported as available even while its idle children are stopped.
  const configured = speechWorkerConfigured();
  // A direct /health check: a call start must not trust a registry entry the short cooldown may have cached
  // while the worker was down. It is cheap, loads no model, and never starts an engine.
  const workerFailure = await workerCallFailure();
  const reachable = !workerFailure;
  const reason = (value: Availability<unknown>) => (value.ok ? undefined : { code: value.code, detail: value.detail });
  const localReason = local.ok ? workerFailure : reason(local);
  return {
    local: local.ok && reachable,
    realtime: target.ok,
    worker: configured && admin.local.stt && admin.local.tts && reachable,
    voice: callVoice(userId),
    ...(target.ok ? { model: target.value.model, realtimeVoice: target.value.voice } : {}),
    maxSeconds: limits.maxSeconds,
    // The admin's recording limit also caps one spoken utterance.
    maxUtteranceSeconds: Math.max(5, Math.min(limits.maxUtteranceSeconds, admin.maxRecordingSeconds)),
    ...(localReason ? { localReason } : {}),
    ...(reason(target) ? { realtimeReason: reason(target) } : {}),
  };
}
