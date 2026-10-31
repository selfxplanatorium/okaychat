/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-voice-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "voice-backend-test-secret-0123456789";
delete process.env.OKAYCHAT_SPEECH_URL;

const { db } = await import("../db.js");
const { saveConnection } = await import("../catalog/providers.js");
const { sha256 } = await import("../crypto.js");
const { voiceAvailability, openaiRealtime, selectEngine, wavPcm, workerBackends, CallFailure } = await import("./backend.js");
const { reportServiceFailure, serviceDown, resetServicesForTests } = await import("../services.js");
const { voiceOriginAllowed, voiceRoutes } = await import("./routes.js");
const { requireUser } = await import("../auth.js");

for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    `${id}@example.test`,
    id,
    "unused",
    "user",
    Date.now(),
  );
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 60_000);
}
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const cookie = (user: string) => ({ cookie: `okaychat_session=${user}` });

test("origin checks refuse foreign pages, missing Origins, and crafted spellings", () => {
  assert.equal(voiceOriginAllowed("https://app.test", "https://app.test"), true);
  assert.equal(voiceOriginAllowed("https://public.test", "http://127.0.0.1:8787", "https://public.test"), true);
  // Dev TLS proxy: same host, different scheme, no forwarded-proto header.
  assert.equal(voiceOriginAllowed("https://app.test:5173", "http://app.test:5173"), true);
  assert.equal(voiceOriginAllowed("https://evil.test", "https://app.test"), false);
  assert.equal(voiceOriginAllowed(undefined, "https://app.test"), false);
  assert.equal(voiceOriginAllowed("https://app.test", "https://app.test", undefined, "cross-site"), false);
  // A same-host downgrade is only the https page → http proxy case, never the other way round.
  assert.equal(voiceOriginAllowed("http://app.test", "https://app.test"), false);
  assert.equal(voiceOriginAllowed("https://app.test", "https://app.test:8443"), false);
  // Only a canonical serialized http(s) origin is an Origin.
  for (const crafted of [
    "ftp://app.test",
    "file://app.test",
    "https://user@app.test",
    "https://user:pass@app.test",
    "https://app.test/",
    "https://app.test/path",
    "https://app.test?x=1",
    "https://app.test#x",
    "//app.test",
    "app.test",
    "null",
    "https://app.test:443",
  ]) {
    assert.equal(voiceOriginAllowed(crafted, "https://app.test"), false, crafted);
  }
});

test("availability reports an absent worker without loading a model", async () => {
  const status = await voiceAvailability("alice");
  assert.equal(status.local, false);
  assert.equal(status.worker, false);
  assert.equal(status.localReason?.code, "unavailable");
  assert.equal(status.maxSeconds > 0, true);
  assert.equal(status.maxUtteranceSeconds >= 5, true);
});

test("a configured but unreachable worker is reported as unavailable", async () => {
  process.env.OKAYCHAT_SPEECH_URL = "http://127.0.0.1:9";
  const status = await voiceAvailability("alice");
  assert.equal(status.local, false);
  assert.equal(status.localReason?.code, "worker");
  assert.equal(status.worker, false);
  delete process.env.OKAYCHAT_SPEECH_URL;
});

test("a reachable worker makes the local pipeline available without loading a model", async () => {
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, stt: false, tts: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.OKAYCHAT_SPEECH_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const status = await voiceAvailability("alice");
    assert.equal(status.local, true);
    assert.equal(status.worker, true);
    assert.equal(status.voice.length > 0, true);
    assert.equal(status.localReason, undefined);
  } finally {
    delete process.env.OKAYCHAT_SPEECH_URL;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the voice routes require the session and a same-origin upgrade", async () => {
  const app = new Hono().route("/voice", voiceRoutes);
  assert.equal((await app.request("http://app/voice")).status, 401);
  assert.equal((await app.request("http://app/voice", { headers: cookie("alice") })).status, 200);
  // A GET without an Origin is refused before Hono's upgrade helper sees it.
  assert.equal((await app.request("http://app/voice/call", { headers: cookie("alice") })).status, 403);
  assert.equal(
    (await app.request("http://app/voice/call", { headers: { ...cookie("alice"), origin: "https://evil.test" } })).status,
    403,
  );
  // Same origin but not a WebSocket request: no upgrade to perform.
  assert.notEqual((await app.request("http://app/voice/call", { headers: { ...cookie("alice"), origin: "http://app" } })).status, 401);
});

test("a recovered worker clears the fail-fast guard before warming, and a new outage is a worker error", async () => {
  let refuseWarm = false;
  let warms = 0;
  const server = createServer((req, res) => {
    const health = req.url === "/health";
    if (!health) warms++;
    res.writeHead(!health && refuseWarm ? 503 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(health ? { ok: true, stt: false, tts: false } : { ok: !refuseWarm }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.OKAYCHAT_SPEECH_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    reportServiceFailure("speech");
    assert.equal(serviceDown("speech"), true);
    const local = workerBackends.local("alice");
    assert.equal(local.ok, true);
    if (!local.ok) return;
    await local.value.warm(new AbortController().signal);
    assert.equal(serviceDown("speech"), false);
    assert.equal(warms, 2, "both engines reach the recovered worker");
    refuseWarm = true;
    await assert.rejects(local.value.warm(new AbortController().signal), (error) => error instanceof CallFailure && error.code === "worker");
  } finally {
    delete process.env.OKAYCHAT_SPEECH_URL;
    resetServicesForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a Realtime call without an OpenAI key is unavailable, never half-started", () => {
  assert.deepEqual(openaiRealtime("bob", "tmp_test"), { ok: false, code: "unavailable", detail: "No OpenAI connection with a key." });
});

test("the Realtime signalling exchange posts the offer and the session to OpenAI", async () => {
  // No explicit base URL: a stored address makes a non-admin connection `guarded` (publicFetch, not fetch).
  saveConnection("alice", "openai", { apiKey: "sk-test", enabled: true });
  const realFetch = globalThis.fetch;
  let seen: { url: string; authorization: string | null; sdp: string; session: Record<string, unknown> } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "api.openai.com") return realFetch(input, init);
    const req = new Request(url, init);
    const form = await req.formData();
    seen = {
      url: url.href,
      authorization: req.headers.get("authorization"),
      sdp: String(form.get("sdp")),
      session: JSON.parse(String(form.get("session"))) as Record<string, unknown>,
    };
    return new Response("v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n", { status: 200 });
  }) as typeof fetch;
  try {
    const target = openaiRealtime("alice", "tmp_test");
    assert.equal(target.ok, true);
    if (!target.ok) return;
    assert.equal(target.value.voice.length > 0, true);
    const answer = await target.value.answer("v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n", new AbortController().signal);
    assert.match(answer, /^v=0/);
    assert.equal(seen?.url, "https://api.openai.com/v1/realtime/calls");
    assert.equal(seen?.authorization, "Bearer sk-test");
    assert.match(seen?.sdp ?? "", /^v=0/);
    assert.equal(seen?.session.model, target.value.model);
    assert.equal((seen?.session.instructions as string).includes("voice conversation"), true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Realtime rechecks a shared model grant when the delayed SDP offer arrives", async (t) => {
  const { setModelAccessPolicies } = await import("../entitlements.js");
  saveConnection(null, "openai", { apiKey: "sk-shared-test", enabled: true });
  try {
    const target = openaiRealtime("bob", "tmp_test");
    assert.equal(target.ok, true);
    if (!target.ok) return;
    setModelAccessPolicies("openai", [{ target: { kind: "everyone", id: "" }, mode: "selected", modelIds: [] }]);
    const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("a revoked key must not be used"); });
    await assert.rejects(target.value.answer("v=0\r\n", new AbortController().signal), (error) => error instanceof CallFailure && /administrator/.test(error.message));
    assert.equal(upstream.mock.callCount(), 0);
  } finally {
    db.exec("DELETE FROM shared_connections WHERE provider_id = 'openai'");
  }
});

test("Realtime falls back to local with its reason, but local never falls back to the cloud", () => {
  const ok = { ok: true as const, value: {} };
  const no = { ok: false as const, code: "unavailable" as const, detail: "No key." };
  assert.deepEqual(selectEngine("realtime", ok, () => no), { engine: "local", fallback: { code: "unavailable", detail: "No key." } });
  assert.deepEqual(selectEngine("realtime", no, () => no), { error: { code: "unavailable", detail: "No key." } });
  assert.deepEqual(selectEngine("local", no, () => ok), { error: { code: "unavailable", detail: "No key." } });
  assert.deepEqual(selectEngine("realtime", no, () => ok), { engine: "realtime" });
});

test("WAV parsing reads Piper's PCM16 mono and rejects anything else", () => {
  const pcm = Buffer.from([0, 0, 1, 0, 2, 0]);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(22_050, 24);
  header.writeUInt32LE(44_100, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(pcm.length, 40);
  const wav = new Uint8Array(Buffer.concat([header, pcm]));
  const parsed = wavPcm(wav);
  assert.equal(parsed.rate, 22_050);
  assert.deepEqual([...parsed.pcm], [0, 0, 1, 0, 2, 0]);
  assert.throws(() => wavPcm(new Uint8Array([1, 2, 3])), /not a WAV/);
});

void requireUser;
