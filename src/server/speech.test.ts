import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { SpeechStatus } from "../shared/speech.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-speech-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "speech-test-secret-only-not-for-production";
process.env.OKAYCHAT_SPEECH_TOKEN = "speech-worker-token-for-tests-0123456789";
const { db } = await import("./db.js");
const { requireUser } = await import("./auth.js");
const { sha256 } = await import("./crypto.js");
const { saveConnection } = await import("./catalog/providers.js");
const { updateSettings, getSettings } = await import("./settings.js");
const { purgeRecordings, setAdminSpeech, adminSpeech } = await import("./speech/config.js");
const { speechRoutes } = await import("./speech/routes.js");
const services = await import("./services.js");
const { DEFAULT_ADMIN_SPEECH } = await import("../shared/speech.js");

// ---- fake upstreams ----

const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(200, 1)]);
const WAV = (() => {
  const b = Buffer.alloc(244);
  b.write("RIFF", 0, "latin1");
  b.write("WAVE", 8, "latin1");
  return b;
})();

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}
const seen: Seen[] = [];
let reply: (req: Seen) => { status?: number; type?: string; body: Buffer | string | object } = () => ({ body: {} });

/** Mock for every hosted API with a fixed address (Deepgram, ElevenLabs, Azure). */
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!/(deepgram\.com|elevenlabs\.io|microsoft\.com)$/.test(url.hostname)) return realFetch(input, init);
  const req = new Request(url, init);
  const s: Seen = { method: req.method, url: url.href, headers: Object.fromEntries(req.headers), body: Buffer.from(await req.arrayBuffer()) };
  seen.push(s);
  return respond(reply(s));
}) as typeof fetch;

function respond(r: ReturnType<typeof reply>): Response {
  const body = Buffer.isBuffer(r.body) ? r.body : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  return new Response(body as BodyInit, { status: r.status ?? 200, headers: { "Content-Type": r.type ?? (Buffer.isBuffer(r.body) ? "audio/mpeg" : "application/json") } });
}

/** One local server plays OpenAI-compatible APIs, Mistral, the speech worker, and the Realtime WebSocket. */
let server: Server;
let base = "";
let realtimeEvents: string[] = [];
before(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      const s: Seen = { method: req.method ?? "GET", url: req.url ?? "", headers: req.headers as Record<string, string>, body: Buffer.concat(chunks) };
      seen.push(s);
      const r = reply(s);
      const body = Buffer.isBuffer(r.body) ? r.body : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
      res.writeHead(r.status ?? 200, { "Content-Type": r.type ?? (Buffer.isBuffer(r.body) ? "audio/mpeg" : "application/json") });
      res.end(body);
    });
  });
  // A minimal WebSocket server: enough of RFC 6455 for text frames under 64 KiB.
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    seen.push({ method: "WS", url: req.url ?? "", headers: req.headers as Record<string, string>, body: Buffer.alloc(0) });
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (value: object) => {
      const payload = Buffer.from(JSON.stringify(value));
      const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
      socket.write(Buffer.concat([header, payload]));
    };
    let buffer = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 2) {
        const opcode = buffer[0]! & 15;
        let len = buffer[1]! & 127;
        let offset = 2;
        if (len === 126) {
          len = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (buffer.length < offset + 4 + len) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + len).map((b, i) => b ^ mask[i % 4]!));
        buffer = buffer.subarray(offset + 4 + len);
        if (opcode === 8) return socket.end();
        const event = JSON.parse(payload.toString()) as { type: string };
        realtimeEvents.push(payload.toString());
        if (event.type === "session.update") send({ type: "session.updated" });
        if (event.type === "response.create") {
          send({ type: "response.output_audio.delta", delta: Buffer.alloc(480, 7).toString("base64") });
          send({ type: "response.output_audio.delta", delta: Buffer.alloc(480, 9).toString("base64") });
          send({ type: "response.done", response: { status: "completed" } });
        }
      }
    });
    socket.on("error", () => {});
    send({ type: "session.created" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.OKAYCHAT_SPEECH_URL = `${base}/worker`;
});

after(() => {
  globalThis.fetch = realFetch;
  server.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ---- app ----

for (const [id, role] of [["admin", "admin"], ["bob", "user"]] as const) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'unused', ?, ?)").run(id, `${id}@example.test`, id, role, Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
}
// Same error shape as index.ts.
const app = new Hono()
  .use(requireUser)
  .route("/", speechRoutes)
  .onError((error, c) => (error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: String(error) }, 500)));
const call = (user: string, url: string, init: RequestInit & { json?: unknown } = {}) => {
  const { json, ...rest } = init;
  return app.request(url, {
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    headers: { Cookie: `okaychat_session=${user}`, ...(json !== undefined ? { "Content-Type": "application/json" } : {}) },
  });
};
const upload = (user: string, bytes: Buffer, fields: Record<string, string> = {}, type = "audio/webm") => {
  const form = new FormData();
  form.append("file", new Blob([bytes as BodyInit as Uint8Array<ArrayBuffer>], { type }), "recording.webm");
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return call(user, "/speech/transcribe", { method: "POST", body: form });
};
const AUDIO = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000, 3)]);

beforeEach(() => {
  seen.length = 0;
  realtimeEvents = [];
  reply = () => ({ body: {} });
  db.exec("DELETE FROM provider_connections; DELETE FROM shared_connections; DELETE FROM user_settings; DELETE FROM speech_recordings; DELETE FROM server_settings WHERE key = 'speech';");
});

const lastTo = (pattern: RegExp) => [...seen].reverse().find((s) => pattern.test(s.url))!;
const form = (s: Seen) => new Response(s.body as BodyInit, { headers: { "Content-Type": s.headers["content-type"]! } }).formData();

// ---- settings ----

test("speech settings: valid values are kept and unknown engines or values are rejected", () => {
  updateSettings("bob", { speech: { stt: { engine: "local", language: "de", silenceSeconds: 2 }, tts: { engine: "elevenlabs", speed: 1.25, split: "paragraph", voices: { elevenlabs: "abc" } } } });
  assert.equal(getSettings("bob").speech?.tts?.voices?.elevenlabs, "abc");
  for (const bad of [{ tts: { engine: "pico" } }, { tts: { speed: 3 } }, { stt: { language: "German" } }, { stt: { extra: true } }, { tts: { voices: { nope: "x" } } }]) {
    assert.throws(() => updateSettings("bob", { speech: bad as never }), /speech/);
  }
});

test("read aloud is off by default and every engine reports why it is not ready", async () => {
  const status = (await (await call("bob", "/speech")).json()) as SpeechStatus;
  assert.equal(status.retentionHours, 0);
  assert.equal(status.worker, true);
  assert.equal(status.tts.find((e) => e.id === "local")?.ready, true);
  assert.equal(status.tts.find((e) => e.id === "openai")?.reason, "Not connected.");
  const res = await call("bob", "/speech/synthesize", { method: "POST", json: { text: "Hello" } });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /off/);
});

// ---- keys ----

test("speech keys: Azure stores its region, private addresses need an admin, admin keys are shared", async () => {
  let res = await call("bob", "/speech/keys/azure", { method: "PUT", json: { apiKey: "az-key", region: "westeurope" } });
  assert.equal(res.status, 200);
  const status = (await res.json()) as SpeechStatus;
  assert.deepEqual(status.keys.azure, { connected: true, shared: false, region: "westeurope" });
  assert.equal(status.stt.find((e) => e.id === "azure")?.ready, true);

  res = await call("bob", "/speech/keys/compatible-tts", { method: "PUT", json: { baseURL: `${base}/v1` } });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /admins/);

  res = await call("admin", "/admin/speech/keys/elevenlabs", { method: "PUT", json: { apiKey: "shared-11" } });
  assert.equal(res.status, 200);
  const bobStatus = (await (await call("bob", "/speech")).json()) as SpeechStatus;
  assert.deepEqual(bobStatus.keys.elevenlabs, { connected: true, shared: true });
  assert.equal((await call("bob", "/admin/speech/keys/elevenlabs", { method: "PUT", json: { apiKey: "x" } })).status, 403);
  assert.equal((await call("bob", "/admin/speech")).status, 403);
  // The secret never comes back.
  assert.doesNotMatch(JSON.stringify(bobStatus), /shared-11|az-key/);
});

// ---- speech to text ----

test("transcription request shapes for every cloud engine", async () => {
  saveConnection("admin", "openai", { apiKey: "sk-openai", baseURL: `${base}/openai/v1` });
  saveConnection("admin", "groq", { apiKey: "gsk", baseURL: `${base}/groq/v1` });
  saveConnection("admin", "mistral", { apiKey: "mk", baseURL: `${base}/mistral/v1` });
  saveConnection("admin", "speech-compatible-stt", { baseURL: `${base}/self/v1` });
  saveConnection("admin", "speech-deepgram", { apiKey: "dg" });
  saveConnection("admin", "speech-elevenlabs", { apiKey: "el" });
  saveConnection("admin", "speech-azure", { apiKey: "az", baseURL: "https://westeurope.api.cognitive.microsoft.com" });
  reply = (s) => {
    if (s.url.includes("deepgram")) return { body: { results: { channels: [{ alternatives: [{ transcript: "deepgram text" }], detected_language: "en" }] } } };
    if (s.url.includes("elevenlabs")) return { body: { text: "eleven text", language_code: "en" } };
    if (s.url.includes("microsoft")) return { body: { combinedPhrases: [{ text: "azure text" }] } };
    return { body: { text: ` ${s.url.split("/")[1]} text ` } };
  };

  const cases: Array<[string, RegExp, string]> = [
    ["openai", /\/openai\/v1\/audio\/transcriptions$/, "openai text"],
    ["groq", /\/groq\/v1\/audio\/transcriptions$/, "groq text"],
    ["mistral", /\/mistral\/v1\/audio\/transcriptions$/, "mistral text"],
    ["openai-compatible", /\/self\/v1\/audio\/transcriptions$/, "self text"],
    ["deepgram", /api\.deepgram\.com\/v1\/listen/, "deepgram text"],
    ["elevenlabs", /api\.elevenlabs\.io\/v1\/speech-to-text$/, "eleven text"],
    ["azure", /westeurope\.api\.cognitive\.microsoft\.com\/speechtotext\/transcriptions:transcribe/, "azure text"],
  ];
  for (const [engine, url, text] of cases) {
    updateSettings("admin", { speech: { stt: { engine: engine as never, language: "de", models: { openai: "gpt-transcribe" } } } });
    const res = await upload("admin", AUDIO);
    assert.equal(res.status, 200, engine);
    assert.equal(((await res.json()) as { text: string }).text, text, engine);
    const s = lastTo(url);
    assert.ok(s, `${engine} reached ${url}`);
    if (["openai", "groq", "mistral"].includes(engine)) {
      const f = await form(s);
      assert.equal(s.headers.authorization, `Bearer ${engine === "openai" ? "sk-openai" : engine === "groq" ? "gsk" : "mk"}`);
      assert.equal(f.get("language"), "de");
      assert.equal((f.get("file") as File).size, AUDIO.length);
      assert.equal((f.get("file") as File).name, "recording.webm", "named after the sniffed format");
      if (engine === "openai") assert.equal(f.get("model"), "gpt-transcribe");
      if (engine === "mistral") assert.equal(f.get("model"), "voxtral-mini-transcribe-3");
    }
    if (engine === "openai-compatible") assert.equal(s.headers.authorization, undefined, "no key, no header");
    if (engine === "deepgram") {
      assert.equal(s.headers.authorization, "Token dg");
      assert.match(s.url, /model=nova-3/);
      assert.match(s.url, /language=de/);
      assert.equal(s.headers["content-type"], "audio/webm");
      assert.equal(s.body.length, AUDIO.length);
    }
    if (engine === "elevenlabs") {
      const f = await form(s);
      assert.equal(s.headers["xi-api-key"], "el");
      assert.equal(f.get("model_id"), "scribe_v2");
      assert.equal(f.get("language_code"), "de");
    }
    if (engine === "azure") {
      const f = await form(s);
      assert.equal(s.headers["ocp-apim-subscription-key"], "az");
      assert.deepEqual(JSON.parse(f.get("definition") as string), { locales: ["de-DE"] });
    }
  }
});

test("Whisper on the server: worker call, admin switch, and the admin's model choice", async () => {
  reply = (s) => (s.url.startsWith("/worker/transcribe") ? { body: { text: "local text", language: "en" } } : { body: {} });
  updateSettings("bob", { speech: { stt: { engine: "local" } } });
  setAdminSpeech({ ...DEFAULT_ADMIN_SPEECH, local: { ...DEFAULT_ADMIN_SPEECH.local, whisperModel: "small", vad: false } });
  const res = await upload("bob", AUDIO);
  assert.deepEqual(await res.json(), { text: "local text", language: "en" });
  const s = lastTo(/^\/worker\/transcribe/);
  assert.equal(s.headers.authorization, `Bearer ${process.env.OKAYCHAT_SPEECH_TOKEN}`);
  assert.match(s.url, /model=small/);
  assert.match(s.url, /vad=0/);
  assert.match(s.url, /max_seconds=600/);
  assert.equal(s.body.length, AUDIO.length);

  setAdminSpeech({ ...DEFAULT_ADMIN_SPEECH, local: { ...DEFAULT_ADMIN_SPEECH.local, stt: false } });
  assert.equal((await upload("bob", AUDIO)).status, 400);
  const status = (await (await call("bob", "/speech")).json()) as SpeechStatus;
  assert.equal(status.stt.find((e) => e.id === "local")?.reason, "Turned off by your admin.");
});

test("admin speech status: reports the worker's actual device, model, and fallback; old payloads stay safe", async () => {
  // The admin page forces a fresh probe, but production keeps the shared per-source cooldown; this test
  // changes the fake worker twice in a row, so it permits both.
  services.setServiceTimingForTests({ forceCooldownMs: 0 });
  reply = (s) => {
    if (s.url === "/worker/health") {
      return {
        body: {
          ok: true, stt: false, tts: false, requestedDevice: "cuda", device: "cpu", computeType: "int8",
          gpuName: null, cudaVersion: null, cudaAvailable: false, degraded: true,
          reason: "CUDA was requested, but no NVIDIA GPU is visible to the speech container.", model: null,
        },
      };
    }
    if (s.url === "/worker/models") return { body: { models: [], downloaded: ["base"] } };
    return { body: {} };
  };
  const body = (await (await call("admin", "/admin/speech")).json()) as { worker: Record<string, unknown> };
  assert.deepEqual(body.worker, {
    configured: true, reachable: true, sttRunning: false, ttsRunning: false,
    requestedDevice: "cuda", device: "cpu", computeType: "int8", gpuName: null, cudaVersion: null,
    cudaAvailable: false, degraded: true,
    reason: "CUDA was requested, but no NVIDIA GPU is visible to the speech container.", model: null, downloaded: ["base"],
  });

  // A worker from before GPU support has none of the device fields.
  reply = (s) => {
    if (s.url === "/worker/health") return { body: { ok: true, stt: false, tts: false } };
    if (s.url === "/worker/models") return { body: { models: [], downloaded: [] } };
    return { body: {} };
  };
  const old = (await (await call("admin", "/admin/speech")).json()) as { worker: Record<string, unknown> };
  assert.deepEqual(old.worker, {
    configured: true, reachable: true, sttRunning: false, ttsRunning: false,
    requestedDevice: null, device: null, computeType: null, gpuName: null, cudaVersion: null,
    cudaAvailable: null, degraded: false, reason: null, model: null, downloaded: [],
  });
});

test("uploads: audio is checked by type or bytes, size is capped, worker errors pass through", async () => {
  updateSettings("bob", { speech: { stt: { engine: "local" } } });
  reply = () => ({ status: 413, body: { error: "The recording is 12.0 minutes long; the limit is 10." } });
  assert.equal((await upload("bob", Buffer.from("<html>not audio</html>"), {}, "text/html")).status, 400);
  assert.equal((await upload("bob", Buffer.from("plain bytes"), {}, "application/octet-stream")).status, 400);
  const sniffed = await upload("bob", AUDIO, {}, "application/octet-stream");
  assert.equal(sniffed.status, 413);
  assert.match(((await sniffed.json()) as { error: string }).error, /minutes long/);
  const big = await upload("bob", Buffer.alloc(25 * 1024 * 1024 + 10));
  assert.equal(big.status, 413);
});

test("attached audio files fall back to a ready server engine when dictation uses the browser", async () => {
  updateSettings("bob", { speech: { stt: { engine: "browser" } } });
  reply = () => ({ body: { text: "from file" } });
  const res = await upload("bob", AUDIO, { purpose: "file" });
  assert.deepEqual(await res.json(), { text: "from file" });
  assert.ok(lastTo(/^\/worker\/transcribe/));
  // A dictated recording with the browser engine has no server engine to use.
  assert.equal((await upload("bob", AUDIO)).status, 400);
});

// ---- retention ----

test("recordings: nothing is stored by default; retention stores encrypted copies and purges them", async () => {
  updateSettings("bob", { speech: { stt: { engine: "local" } } });
  reply = () => ({ body: { text: "secret words" } });
  await upload("bob", AUDIO);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM speech_recordings").get() as { n: number }).n, 0);

  setAdminSpeech({ ...adminSpeech(), retentionHours: 2 });
  await upload("bob", AUDIO);
  await upload("bob", AUDIO, { purpose: "file" });
  await upload("bob", AUDIO, { temporary: "1" });
  const rows = db.prepare("SELECT audio_enc, transcript_enc, created_at FROM speech_recordings").all() as Array<{ audio_enc: Uint8Array; transcript_enc: string; created_at: number }>;
  assert.equal(rows.length, 1, "attached files and temporary chats are not kept");
  assert.ok(!Buffer.from(rows[0]!.audio_enc).includes(AUDIO.subarray(4, 100)));
  assert.doesNotMatch(rows[0]!.transcript_enc, /secret/);
  assert.deepEqual(await (await call("bob", "/speech/recordings")).json(), { count: 1, bytes: AUDIO.length });

  assert.equal(purgeRecordings(rows[0]!.created_at + 3600_000), 0);
  assert.equal(purgeRecordings(rows[0]!.created_at + 2 * 3600_000 + 1), 1);

  await upload("bob", AUDIO);
  assert.deepEqual(await (await call("bob", "/speech/recordings", { method: "DELETE" })).json(), { deleted: 1 });
  await upload("bob", AUDIO);
  // Turning retention off deletes everything at once.
  assert.equal((await call("admin", "/admin/speech", { method: "PUT", json: { ...adminSpeech(), retentionHours: 0 } })).status, 200);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM speech_recordings").get() as { n: number }).n, 0);
});

// ---- text to speech ----

test("read-aloud request shapes for every engine; responses must be audio", async () => {
  saveConnection("admin", "openai", { apiKey: "sk-openai", baseURL: `${base}/openai/v1` });
  saveConnection("admin", "mistral", { apiKey: "mk", baseURL: `${base}/mistral/v1` });
  saveConnection("admin", "speech-compatible-tts", { apiKey: "kokoro", baseURL: `${base}/kokoro/v1` });
  saveConnection("admin", "speech-elevenlabs", { apiKey: "el" });
  saveConnection("admin", "speech-azure", { apiKey: "az", baseURL: "https://westeurope.api.cognitive.microsoft.com" });
  reply = (s) => {
    if (s.url.startsWith("/worker/speak")) return { type: "audio/wav", body: WAV };
    if (s.url.startsWith("/mistral")) return { body: { audio_data: MP3.toString("base64") } };
    return { body: MP3 };
  };
  updateSettings("admin", { speech: { tts: { engine: "openai", instructions: "calm", voices: { openai: "marin", azure: "de-DE-KatjaNeural", elevenlabs: "voice123", mistral: "voice_478", local: "de_DE-thorsten-medium" }, models: { openai: "gpt-4o-mini-tts" } } } });

  const speak = async (engine: string, text = "Hello & <world>") => {
    const res = await call("admin", "/speech/synthesize", { method: "POST", json: { text, engine } });
    assert.equal(res.status, 200, `${engine}: ${res.status}`);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    return res;
  };

  assert.equal((await speak("openai")).headers.get("content-type"), "audio/mpeg");
  let s = lastTo(/\/openai\/v1\/audio\/speech$/);
  assert.deepEqual(JSON.parse(s.body.toString()), { model: "gpt-4o-mini-tts", input: "Hello & <world>", voice: "marin", response_format: "mp3", instructions: "calm" });

  // tts-1 rejects instructions, so they are left out.
  await call("admin", "/speech/synthesize", { method: "POST", json: { text: "Hi", engine: "openai", model: "tts-1" } });
  assert.equal(JSON.parse(lastTo(/\/openai\/v1\/audio\/speech$/).body.toString()).instructions, undefined);

  await speak("openai-compatible");
  s = lastTo(/\/kokoro\/v1\/audio\/speech$/);
  assert.equal(s.headers.authorization, "Bearer kokoro");
  assert.equal(JSON.parse(s.body.toString()).voice, "alloy");

  assert.equal((await speak("mistral")).headers.get("content-type"), "audio/mpeg");
  s = lastTo(/\/mistral\/v1\/audio\/speech$/);
  assert.deepEqual(JSON.parse(s.body.toString()), { model: "voxtral-mini-tts-3-0", input: "Hello & <world>", voice_id: "voice_478", response_format: "mp3" });

  await speak("elevenlabs");
  s = lastTo(/elevenlabs\.io\/v1\/text-to-speech\/voice123/);
  assert.equal(s.headers["xi-api-key"], "el");
  assert.deepEqual(JSON.parse(s.body.toString()), { text: "Hello & <world>", model_id: "eleven_flash_v2_5" });

  await speak("azure");
  s = lastTo(/westeurope\.tts\.speech\.microsoft\.com\/cognitiveservices\/v1$/);
  assert.equal(s.headers["content-type"], "application/ssml+xml");
  assert.equal(s.body.toString(), '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="de-DE"><voice name="de-DE-KatjaNeural">Hello &amp; &lt;world&gt;</voice></speak>');

  assert.equal((await speak("local")).headers.get("content-type"), "audio/wav");
  s = lastTo(/^\/worker\/speak/);
  assert.match(s.url, /voice=de_DE-thorsten-medium/);
  assert.equal(s.body.toString(), "Hello & <world>");

  // An upstream that answers with HTML is never served.
  reply = () => ({ type: "text/html", body: "<script>alert(1)</script>" });
  const bad = await call("admin", "/speech/synthesize", { method: "POST", json: { text: "Hi", engine: "openai" } });
  assert.equal(bad.status, 502);
  assert.match(((await bad.json()) as { error: string }).error, /not audio/);
});

test("OpenAI Realtime reads text through a session and returns 24 kHz WAV", async () => {
  saveConnection("admin", "openai", { apiKey: "sk-rt", baseURL: `${base}/openai/v1` });
  updateSettings("admin", { speech: { tts: { engine: "openai-realtime", instructions: "whisper softly", voices: { "openai-realtime": "cedar" } } } });
  const res = await call("admin", "/speech/synthesize", { method: "POST", json: { text: "Read me." } });
  assert.equal(res.status, 200);
  const wav = Buffer.from(await res.arrayBuffer());
  assert.equal(wav.toString("latin1", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(40), 960);
  const ws = seen.find((x) => x.method === "WS")!;
  assert.match(ws.url, /\/openai\/v1\/realtime\?model=gpt-realtime-2\.1-mini/);
  assert.equal(ws.headers.authorization, "Bearer sk-rt");
  const [update, create] = realtimeEvents.map((e) => JSON.parse(e) as { session?: { instructions: string; audio: { output: { voice: string } } }; response?: { conversation: string; input: Array<{ content: Array<{ text: string }> }> } });
  assert.equal(update!.session!.audio.output.voice, "cedar");
  assert.match(update!.session!.instructions, /exactly as written/);
  assert.match(update!.session!.instructions, /whisper softly/);
  assert.equal(create!.response!.conversation, "none");
  assert.equal(create!.response!.input[0]!.content[0]!.text, "Read me.");
});

test("upstream errors keep only the provider's short message; bad keys are a 400", async () => {
  saveConnection("admin", "speech-elevenlabs", { apiKey: "wrong" });
  reply = () => ({ status: 401, body: { detail: "Invalid API key" } });
  const res = await call("admin", "/speech/synthesize", { method: "POST", json: { text: "Hi", engine: "elevenlabs" } });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, "ElevenLabs answered 401: Invalid API key");
  const long = await call("admin", "/speech/synthesize", { method: "POST", json: { text: "x".repeat(4097), engine: "local" } });
  assert.equal(long.status, 400);
});

// ---- lists ----

test("voice and model lists come from the provider and fall back to the built-in list", async () => {
  saveConnection("admin", "speech-elevenlabs", { apiKey: "el" });
  saveConnection("admin", "speech-azure", { apiKey: "az", baseURL: "https://westeurope.api.cognitive.microsoft.com" });
  reply = (s) => {
    if (s.url.includes("/v2/voices")) return { body: { voices: [{ voice_id: "v1", name: "Rachel", labels: { accent: "american", gender: "female" } }] } };
    if (s.url.includes("voices/list")) return { body: [{ ShortName: "de-DE-KatjaNeural", DisplayName: "Katja", LocaleName: "German (Germany)", Locale: "de-DE" }] };
    return { status: 500, body: {} };
  };
  const el = (await (await call("admin", "/speech/options?kind=tts&engine=elevenlabs&what=voices")).json()) as { options: Array<{ id: string; name: string }>; live: boolean };
  assert.deepEqual(el, { options: [{ id: "v1", name: "Rachel · american · female" }], live: true });
  const az = (await (await call("admin", "/speech/options?kind=tts&engine=azure&what=voices")).json()) as { options: Array<{ id: string; name: string }> };
  assert.equal(az.options[0]!.name, "Katja (German (Germany))");
  const none = (await (await call("bob", "/speech/options?kind=tts&engine=openai&what=voices")).json()) as { live: boolean; options: unknown[] };
  assert.equal(none.live, false);
  assert.ok(none.options.length > 5);
});
