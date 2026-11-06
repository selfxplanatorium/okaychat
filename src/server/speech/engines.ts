import { withUnmeteredRoot } from "../credits/admission.js";
import { HTTPException } from "hono/http-exception";
import {
  speechConnectionId,
  sttEngineDef,
  ttsEngineDef,
  type SpeechCredential,
  type SttEngineId,
  type TtsEngineId,
} from "../../shared/speech.js";
import { getConnection, type Connection } from "../catalog/providers.js";
import { USER_AGENT } from "../env.js";
import { promptText } from "../prompts.js";
import { assertPublicHost, publicFetch } from "../public-fetch.js";
import { adminSpeech } from "./config.js";
import { speechWorkerConfigured, workerSpeak, workerTranscribe } from "./worker.js";
import { assertFeature } from "../permissions/guard.js";
import { reserveOperation } from "../permissions/limits.js";

// Speech to text and text to speech through every supported engine. Audio and text pass through memory only;
// nothing here writes to disk. Provider errors are reduced to a short message without the response body.
// See docs/implementation/speech.md.

const DEFAULT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
};
const UPSTREAM_TIMEOUT_MS = 120_000;
/** Longest text one synthesis request accepts. Clients split replies into pieces well below it. */
export const MAX_TTS_CHARS = 4096;
/** OpenAI's upload limit; also the cap for every other engine, so recordings stay small. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export interface ResolvedCredential {
  conn?: Connection;
  apiKey?: string;
  baseURL?: string;
}

/** The credential an engine uses for this user, or undefined when it is not connected. */
export function credentialFor(userId: string, credential: SpeechCredential): ResolvedCredential | undefined {
  if (credential.type === "browser" || credential.type === "local") return {};
  const conn = getConnection(userId, credential.type === "provider" ? credential.providerId : speechConnectionId(credential.service));
  if (!conn) return undefined;
  if (credential.type === "own" && credential.service.startsWith("compatible-")) {
    // A self-hosted server may run without a key, but it needs an address.
    return conn.baseURL ? { conn, apiKey: conn.apiKey, baseURL: conn.baseURL.replace(/\/+$/, "") } : undefined;
  }
  if (!conn.apiKey) return undefined;
  const base = credential.type === "provider" ? (conn.baseURL ?? DEFAULT_BASE[credential.providerId]) : conn.baseURL;
  return { conn, apiKey: conn.apiKey, baseURL: base?.replace(/\/+$/, "") };
}

function need(userId: string, credential: SpeechCredential, name: string): ResolvedCredential {
  const cred = credentialFor(userId, credential);
  if (!cred) throw new HTTPException(400, { message: `Connect ${name} first in Settings → Voice.` });
  return cred;
}

/** Azure keys are stored with `https://<region>.api.cognitive.microsoft.com` as their base URL. */
export const azureRegion = (cred: ResolvedCredential) => {
  const region = cred.baseURL ? new URL(cred.baseURL).hostname.split(".")[0] : undefined;
  if (!region || !/^[a-z0-9]+$/.test(region)) throw new HTTPException(400, { message: "Set the Azure region in Settings → Voice." });
  return region;
};

export async function upstream(cred: ResolvedCredential, url: string, init: RequestInit, label: string, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  let res: Response;
  try {
    res = await (cred.conn?.guarded ? publicFetch : fetch)(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT, ...(init.headers as Record<string, string>) },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new HTTPException(502, { message: `${label} could not be reached${(error as Error).name === "TimeoutError" ? " in time" : ""}.` });
  }
  if (!res.ok) {
    // The body may echo the request; only a provider's short error message is passed on.
    const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown } | null;
    const raw = typeof body?.error === "string" ? body.error : (body?.error?.message ?? body?.message ?? (typeof body?.detail === "string" ? body.detail : ""));
    const detail = typeof raw === "string" && raw ? `: ${raw.replace(/\s+/g, " ").slice(0, 200)}` : "";
    throw new HTTPException(res.status === 401 || res.status === 403 ? 400 : 502, { message: `${label} answered ${res.status}${detail}` });
  }
  return res;
}

const bearer = (cred: ResolvedCredential): Record<string, string> => (cred.apiKey ? { Authorization: `Bearer ${cred.apiKey}` } : {});

// ---- speech to text ----

export interface Recording {
  audio: Uint8Array;
  mime: string;
  filename: string;
}

export interface SttOptions {
  engine: SttEngineId;
  model?: string;
  language?: string;
}

const AZURE_LOCALES: Record<string, string> = {
  en: "en-US", de: "de-DE", fr: "fr-FR", es: "es-ES", it: "it-IT", pt: "pt-BR", nl: "nl-NL", ja: "ja-JP", zh: "zh-CN", ko: "ko-KR",
  ru: "ru-RU", pl: "pl-PL", sv: "sv-SE", da: "da-DK", nb: "nb-NO", fi: "fi-FI", tr: "tr-TR", ar: "ar-SA", hi: "hi-IN", uk: "uk-UA", cs: "cs-CZ",
};

const fileOf = (rec: Recording) => new Blob([rec.audio as Uint8Array<ArrayBuffer>], { type: rec.mime || "application/octet-stream" });

const EXTENSIONS: Record<string, string> = { "audio/wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/flac": "flac", "audio/webm": "webm", "audio/mp4": "m4a", "audio/aac": "m4a" };
/** OpenAI-style APIs pick the decoder by file extension, so the name follows the bytes, not the user's file name. */
export function uploadName(rec: Recording): string {
  const ext = EXTENSIONS[sniffAudio(rec.audio) ?? ""] ?? EXTENSIONS[rec.mime.split(";")[0]!.trim()] ?? rec.filename.split(".").pop() ?? "webm";
  return `recording.${ext}`;
}

const cloudEngine = (def: { credential: { type: string } } | undefined) => !!def && def.credential.type !== "local" && def.credential.type !== "browser";

export async function transcribe(userId: string, rec: Recording, options: SttOptions, signal?: AbortSignal): Promise<{ text: string; language?: string }> {
  // Voice covers both local and cloud paths. Nothing reaches a worker or provider when denied.
  assertFeature(userId, "voice");
  const lease = reserveOperation({ userId }, "speech.transcribe");
  try {
    // Cloud engines have no token price: refused for a finite allowance, rechecked on every call.
    return await (cloudEngine(sttEngineDef(options.engine))
      ? withUnmeteredRoot(userId, "speech", () => transcribeWork(userId, rec, options, signal))
      : transcribeWork(userId, rec, options, signal));
  } finally {
    lease.release();
  }
}

async function transcribeWork(userId: string, rec: Recording, options: SttOptions, signal?: AbortSignal): Promise<{ text: string; language?: string }> {
  const def = sttEngineDef(options.engine);
  if (!def || def.credential.type === "browser") throw new HTTPException(400, { message: "This engine runs in the browser." });
  const model = options.model || def.models[0] || "";
  const language = options.language || undefined;
  const admin = adminSpeech();

  if (def.credential.type === "local") {
    if (!speechWorkerConfigured() || !admin.local.stt) throw new HTTPException(400, { message: "Whisper on this server is not available." });
    return workerTranscribe(rec.audio, { model: admin.local.whisperModel, language, vad: admin.local.vad, maxSeconds: admin.maxRecordingSeconds }, signal);
  }

  const cred = need(userId, def.credential, def.name);
  switch (def.id) {
    case "openai":
    case "groq":
    case "mistral":
    case "openai-compatible": {
      const form = new FormData();
      form.append("file", fileOf(rec), uploadName(rec));
      form.append("model", model);
      if (language) form.append("language", language);
      if (def.id !== "mistral") form.append("response_format", "json");
      const res = await upstream(cred, `${cred.baseURL}/audio/transcriptions`, { method: "POST", body: form, headers: bearer(cred) }, def.name, signal);
      const body = (await res.json()) as { text?: unknown; language?: unknown };
      return { text: typeof body.text === "string" ? body.text.trim() : "", language: typeof body.language === "string" ? body.language : undefined };
    }
    case "deepgram": {
      const q = new URLSearchParams({ model, smart_format: "true", punctuate: "true" });
      if (language) q.set("language", language);
      else q.set("detect_language", "true");
      const res = await upstream(
        cred,
        `https://api.deepgram.com/v1/listen?${q}`,
        { method: "POST", body: rec.audio as Uint8Array<ArrayBuffer>, headers: { Authorization: `Token ${cred.apiKey}`, "Content-Type": rec.mime || "application/octet-stream" } },
        def.name,
        signal,
      );
      const body = (await res.json()) as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }>; detected_language?: string }> } };
      const channel = body.results?.channels?.[0];
      return { text: (channel?.alternatives?.[0]?.transcript ?? "").trim(), language: channel?.detected_language };
    }
    case "elevenlabs": {
      const form = new FormData();
      form.append("file", fileOf(rec), uploadName(rec));
      form.append("model_id", model);
      if (language) form.append("language_code", language);
      form.append("tag_audio_events", "false");
      const res = await upstream(cred, "https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", body: form, headers: { "xi-api-key": cred.apiKey! } }, def.name, signal);
      const body = (await res.json()) as { text?: string; language_code?: string };
      return { text: (body.text ?? "").trim(), language: body.language_code };
    }
    case "azure": {
      const region = azureRegion(cred);
      const form = new FormData();
      form.append("audio", fileOf(rec), uploadName(rec));
      // Without locales the service identifies the language itself.
      form.append("definition", JSON.stringify(language ? { locales: [AZURE_LOCALES[language] ?? `${language}-${language.toUpperCase()}`] } : {}));
      const res = await upstream(
        cred,
        `https://${region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15`,
        { method: "POST", body: form, headers: { "Ocp-Apim-Subscription-Key": cred.apiKey! } },
        def.name,
        signal,
      );
      const body = (await res.json()) as { combinedPhrases?: Array<{ text?: string }> };
      return { text: (body.combinedPhrases ?? []).map((p) => p.text ?? "").join(" ").trim() };
    }
  }
  throw new HTTPException(400, { message: "Unknown speech recognition engine." });
}

// ---- text to speech ----

export interface TtsOptions {
  engine: TtsEngineId;
  model?: string;
  voice?: string;
  instructions?: string;
}

export interface Speech {
  audio: Uint8Array;
  mime: string;
}

export async function synthesize(userId: string, text: string, options: TtsOptions, signal?: AbortSignal): Promise<Speech> {
  assertFeature(userId, "voice");
  const lease = reserveOperation({ userId }, "speech.synthesize");
  try {
    return await (cloudEngine(ttsEngineDef(options.engine))
      ? withUnmeteredRoot(userId, "speech", () => synthesizeWork(userId, text, options, signal))
      : synthesizeWork(userId, text, options, signal));
  } finally {
    lease.release();
  }
}

async function synthesizeWork(userId: string, text: string, options: TtsOptions, signal?: AbortSignal): Promise<Speech> {
  const def = ttsEngineDef(options.engine);
  if (!def || def.credential.type === "browser") throw new HTTPException(400, { message: "This engine runs in the browser." });
  const model = options.model || def.models[0] || "";
  const voice = options.voice || def.voices[0] || "";
  const instructions = options.instructions?.trim();

  if (def.credential.type === "local") {
    const admin = adminSpeech();
    if (!speechWorkerConfigured() || !admin.local.tts) throw new HTTPException(400, { message: "Piper on this server is not available." });
    return audio(await workerSpeak(text, { voice: options.voice || admin.local.defaultVoice, speed: 1 }, signal), def.name);
  }

  const cred = need(userId, def.credential, def.name);
  switch (def.id) {
    case "openai":
    case "openai-compatible": {
      // tts-1 and tts-1-hd reject instructions.
      const styled = instructions && !/^tts-1/.test(model) ? { instructions } : {};
      const res = await upstream(
        cred,
        `${cred.baseURL}/audio/speech`,
        { method: "POST", body: JSON.stringify({ model, input: text, voice, response_format: "mp3", ...styled }), headers: { ...bearer(cred), "Content-Type": "application/json" } },
        def.name,
        signal,
      );
      return audio(new Uint8Array(await res.arrayBuffer()), def.name);
    }
    case "openai-realtime":
      return audio(await realtimeSpeech(cred, text, model, voice, instructions, signal), def.name);
    case "elevenlabs": {
      const res = await upstream(
        cred,
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
        { method: "POST", body: JSON.stringify({ text, model_id: model }), headers: { "xi-api-key": cred.apiKey!, "Content-Type": "application/json" } },
        def.name,
        signal,
      );
      return audio(new Uint8Array(await res.arrayBuffer()), def.name);
    }
    case "azure": {
      const region = azureRegion(cred);
      if (!/^[a-z]{2,3}-[A-Za-z]{2,4}(-[A-Za-z]+)?-[A-Za-z0-9]+$/.test(voice)) throw new HTTPException(400, { message: "Choose an Azure voice." });
      const locale = voice.split("-").slice(0, 2).join("-");
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${voice}">${xmlEscape(text)}</voice></speak>`;
      const res = await upstream(
        cred,
        `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
        {
          method: "POST",
          body: ssml,
          headers: { "Ocp-Apim-Subscription-Key": cred.apiKey!, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3" },
        },
        def.name,
        signal,
      );
      return audio(new Uint8Array(await res.arrayBuffer()), def.name);
    }
    case "mistral": {
      const res = await upstream(
        cred,
        `${cred.baseURL}/audio/speech`,
        { method: "POST", body: JSON.stringify({ model, input: text, voice_id: voice, response_format: "mp3" }), headers: { ...bearer(cred), "Content-Type": "application/json" } },
        def.name,
        signal,
      );
      const body = (await res.json()) as { audio_data?: string };
      if (!body.audio_data) throw new HTTPException(502, { message: "Mistral returned no audio." });
      return audio(new Uint8Array(Buffer.from(body.audio_data, "base64")), def.name);
    }
  }
  throw new HTTPException(400, { message: "Unknown read-aloud engine." });
}

const xmlEscape = (text: string) => text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** The audio type comes from magic bytes, never from the provider, so the server only ever serves audio. */
export function sniffAudio(buf: Uint8Array): string | null {
  const ascii = (from: number, to: number) => Buffer.from(buf.subarray(from, to)).toString("latin1");
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (ascii(0, 3) === "ID3" || (buf[0] === 0xff && (buf[1]! & 0xe6) === 0xe2)) return "audio/mpeg";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 4) === "fLaC") return "audio/flac";
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "audio/webm";
  if (ascii(4, 8) === "ftyp") return "audio/mp4";
  if (buf[0] === 0xff && (buf[1]! & 0xf6) === 0xf0) return "audio/aac";
  return null;
}

function audio(buf: Uint8Array, label: string): Speech {
  const mime = sniffAudio(buf);
  if (!mime) throw new HTTPException(502, { message: `${label} returned something that is not audio.` });
  return { audio: buf, mime };
}

// ---- OpenAI Realtime as a read-aloud voice ----

/** Opens one Realtime session, asks for audio only, and wraps the PCM16 24 kHz output in a WAV. */
async function realtimeSpeech(cred: ResolvedCredential, text: string, model: string, voice: string, style: string | undefined, signal?: AbortSignal): Promise<Uint8Array> {
  const url = new URL(`${cred.baseURL}/realtime`);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("model", model);
  // WebSockets bypass publicFetch, so a non-admin's own base URL is checked here. The socket does its
  // own DNS lookup, so only TLS keeps a rebinding host from reaching a private plain-HTTP service.
  if (cred.conn?.guarded) {
    if (url.protocol !== "wss:") throw new HTTPException(400, { message: "OpenAI Realtime needs an https base URL." });
    await assertPublicHost(new URL(cred.baseURL!), "That base URL points to a private address.");
  }
  const instructions = promptText("speechRealtime", { style: style ? `Speak in this style: ${style}` : "" }).trim();
  const pcm: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    // Node's WebSocket (undici) accepts headers in its init object.
    const ws = new WebSocket(url, { headers: { ...bearer(cred), "User-Agent": USER_AGENT } } as unknown as string[]);
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    signal?.addEventListener("abort", abort);
    const timer = setTimeout(() => finish(new HTTPException(504, { message: "OpenAI Realtime did not finish in time." })), UPSTREAM_TIMEOUT_MS);
    ws.addEventListener("error", () => finish(new HTTPException(502, { message: "OpenAI Realtime could not be reached." })));
    ws.addEventListener("close", (e) => finish(done ? undefined : new HTTPException(502, { message: `OpenAI Realtime closed the session (${e.code}).` })));
    ws.addEventListener("message", (e) => {
      let event: { type?: string; delta?: string; error?: { message?: string }; response?: { status?: string; status_details?: { error?: { message?: string } } } };
      try {
        event = JSON.parse(String(e.data));
      } catch {
        return;
      }
      // A listener that throws becomes an uncaught exception, so a non-object event is ignored.
      if (!event || typeof event !== "object") return;
      switch (event.type) {
        case "session.created":
          ws.send(JSON.stringify({
            type: "session.update",
            session: { type: "realtime", output_modalities: ["audio"], instructions, audio: { input: { turn_detection: null }, output: { format: { type: "audio/pcm", rate: 24000 }, voice } } },
          }));
          break;
        case "session.updated":
          ws.send(JSON.stringify({
            type: "response.create",
            response: { conversation: "none", output_modalities: ["audio"], input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }] },
          }));
          break;
        case "response.output_audio.delta":
          if (event.delta) pcm.push(Buffer.from(event.delta, "base64"));
          break;
        case "response.done":
          if (event.response?.status === "completed") finish();
          else finish(new HTTPException(502, { message: `OpenAI Realtime stopped: ${event.response?.status_details?.error?.message ?? event.response?.status ?? "unknown"}`.slice(0, 300) }));
          break;
        case "error":
          finish(new HTTPException(502, { message: `OpenAI Realtime: ${event.error?.message ?? "error"}`.slice(0, 300) }));
          break;
      }
    });
  });
  return wav(Buffer.concat(pcm), 24000);
}

export function wav(pcm: Buffer, rate: number): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(pcm.length, 40);
  return new Uint8Array(Buffer.concat([header, pcm]));
}
