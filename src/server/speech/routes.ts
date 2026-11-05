import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  DEFAULT_STT_ENGINE,
  SPEECH_KEY_SERVICES,
  speechConnectionId,
  STT_ENGINES,
  TTS_ENGINES,
  WHISPER_MODELS,
  type SpeechEngineStatus,
  type SpeechKeyService,
  type SpeechStatus,
  type SttEngineId,
  type TtsEngineId,
} from "../../shared/speech.js";
import { requireAdmin, type AppEnv } from "../auth.js";
import { deleteConnection, getConnection, mayUsePrivateHosts, saveConnection, type ConnectionScope } from "../catalog/providers.js";
import { db } from "../db.js";
import { assertPublicHost, BlockedAddressError } from "../public-fetch.js";
import { getSettings } from "../settings.js";
import { adminSpeech, adminSpeechSchema, deleteRecordings, recordingStats, retainRecording, setAdminSpeech } from "./config.js";
import { credentialFor, MAX_AUDIO_BYTES, MAX_TTS_CHARS, sniffAudio, synthesize, transcribe } from "./engines.js";
import { speechOptions } from "./options.js";
import { speechWorkerConfigured, workerHealth, workerModels, workerPreload } from "./worker.js";
import { assertFeature } from "../permissions/guard.js";

// Speech API. Recordings arrive as multipart uploads, are transcribed in memory, and are dropped when the
// request ends unless an admin set a retention period. See docs/implementation/speech.md.

/** Speech requests in flight per account. Each one may hold a provider connection for up to two minutes. */
const MAX_CONCURRENT = 6;
const inFlight = new Map<string, number>();

/** Worker diagnostics are shown to admins, so keep them short and never unbounded. */
const bounded = (value: unknown, max: number): string | null => (typeof value === "string" && value ? value.slice(0, max) : null);

async function limited<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const n = inFlight.get(userId) ?? 0;
  if (n >= MAX_CONCURRENT) throw new HTTPException(429, { message: "Too many speech requests at once. Wait a moment." });
  inFlight.set(userId, n + 1);
  try {
    return await fn();
  } finally {
    const left = (inFlight.get(userId) ?? 1) - 1;
    if (left > 0) inFlight.set(userId, left);
    else inFlight.delete(userId);
  }
}

function engineStatus(userId: string, def: (typeof STT_ENGINES)[number] | (typeof TTS_ENGINES)[number], kind: "stt" | "tts"): SpeechEngineStatus {
  const base = { id: def.id, name: def.name, credential: def.credential, shared: false };
  switch (def.credential.type) {
    case "browser":
      return { ...base, ready: true };
    case "local": {
      const enabled = kind === "stt" ? adminSpeech().local.stt : adminSpeech().local.tts;
      if (!speechWorkerConfigured()) return { ...base, ready: false, reason: "This server has no speech worker." };
      return enabled ? { ...base, ready: true } : { ...base, ready: false, reason: "Turned off by your admin." };
    }
    default: {
      const cred = credentialFor(userId, def.credential);
      return cred ? { ...base, ready: true, shared: !!cred.conn?.shared } : { ...base, ready: false, reason: "Not connected." };
    }
  }
}

function speechStatus(userId: string): SpeechStatus {
  const admin = adminSpeech();
  const keys: SpeechStatus["keys"] = {};
  for (const service of Object.keys(SPEECH_KEY_SERVICES) as SpeechKeyService[]) {
    const conn = getConnection(userId, speechConnectionId(service));
    keys[service] = {
      connected: !!conn && (service.startsWith("compatible-") ? !!conn.baseURL : !!conn.apiKey),
      shared: !!conn?.shared,
      ...(service === "azure" && conn?.baseURL ? { region: new URL(conn.baseURL).hostname.split(".")[0] } : {}),
      ...(service.startsWith("compatible-") && conn?.baseURL && !conn.shared ? { baseURL: conn.baseURL } : {}),
    };
  }
  return {
    stt: STT_ENGINES.map((d) => engineStatus(userId, d, "stt")),
    tts: TTS_ENGINES.map((d) => engineStatus(userId, d, "tts")),
    keys,
    retentionHours: admin.retentionHours,
    maxRecordingSeconds: admin.maxRecordingSeconds,
    worker: speechWorkerConfigured(),
    localVoice: admin.local.defaultVoice,
  };
}

const keyInput = z
  .object({
    apiKey: z.string().trim().max(500).optional(),
    region: z.string().trim().regex(/^[a-z0-9]{2,40}$/, "Region names look like westeurope or eastus.").optional(),
    baseURL: z.string().trim().url().max(500).optional(),
  })
  .strict();

async function saveKey(scope: ConnectionScope, service: SpeechKeyService, raw: unknown) {
  const body = keyInput.safeParse(raw);
  if (!body.success) throw new HTTPException(400, { message: body.error.issues[0]?.message ?? "Invalid key." });
  const { apiKey, region, baseURL } = body.data;
  const fields = SPEECH_KEY_SERVICES[service].fields;
  if (fields.includes("region") && !region) throw new HTTPException(400, { message: "Enter the Azure region." });
  if (fields.includes("baseURL") && !baseURL) throw new HTTPException(400, { message: "Enter the server address." });
  if (!fields.includes("baseURL") && !apiKey) throw new HTTPException(400, { message: "Enter an API key." });
  const url = region ? `https://${region}.api.cognitive.microsoft.com` : baseURL;
  if (baseURL && scope !== null && !mayUsePrivateHosts(scope)) {
    try {
      await assertPublicHost(new URL(baseURL));
    } catch (error) {
      throw new HTTPException(400, { message: error instanceof BlockedAddressError ? "Only admins can use local or private network addresses." : (error as Error).message });
    }
  }
  // A new address always takes a fresh key (or none), so a stored key never follows it elsewhere.
  saveConnection(scope, speechConnectionId(service), { apiKey: apiKey ?? "", baseURL: url ?? "", enabled: true });
}

const serviceParam = (value: string): SpeechKeyService => {
  if (!(value in SPEECH_KEY_SERVICES)) throw new HTTPException(404, { message: "Not found" });
  return value as SpeechKeyService;
};

const synthInput = z
  .object({
    text: z.string().trim().min(1).max(MAX_TTS_CHARS),
    // Overrides for previews in settings; otherwise the account's choices apply.
    engine: z.enum(TTS_ENGINES.map((e) => e.id) as [TtsEngineId, ...TtsEngineId[]]).optional(),
    voice: z.string().trim().min(1).max(200).optional(),
    model: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const speechRoutes = new Hono<AppEnv>()
  .get("/speech", (c) => c.json(speechStatus(c.get("user").id)))
  .post(
    "/speech/transcribe",
    bodyLimit({ maxSize: MAX_AUDIO_BYTES + 64 * 1024, onError: (c) => c.json({ error: "Recordings are limited to 25 MB." }, 413) }),
    async (c) => {
      const user = c.get("user");
      assertFeature(user.id, "voice");
      const form = await c.req.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File) || file.size === 0) return c.json({ error: "Send the recording as `file`." }, 400);
      if (file.size > MAX_AUDIO_BYTES) return c.json({ error: "Recordings are limited to 25 MB." }, 413);
      const audio = new Uint8Array(await file.arrayBuffer());
      // Browsers label some audio files octet-stream or nothing, so the bytes decide when the type does not.
      const mime = file.type.split(";")[0]!.trim().toLowerCase();
      if (!/^(audio|video)\//.test(mime) && !sniffAudio(audio)) return c.json({ error: "That file is not audio." }, 400);
      const prefs = getSettings(user.id).speech?.stt ?? {};
      const requested = form?.get("engine");
      // Attached audio files need a server engine even when dictation uses the browser or is off.
      const attached = form?.get("purpose") === "file";
      let engine = (typeof requested === "string" && requested ? requested : (prefs.engine ?? DEFAULT_STT_ENGINE)) as SttEngineId | "off";
      if (attached && (engine === "browser" || engine === "off")) {
        const ready = speechStatus(user.id).stt.find((e) => e.ready && e.credential.type !== "browser");
        if (!ready) return c.json({ error: "No speech recognition engine is set up. Choose one in Settings → Voice." }, 400);
        engine = ready.id as SttEngineId;
      }
      if (engine === "off" || !STT_ENGINES.some((e) => e.id === engine)) return c.json({ error: "Choose a speech recognition engine in Settings → Voice." }, 400);
      const sttEngine: SttEngineId = engine;
      const language = typeof form?.get("language") === "string" && /^[a-z]{2,3}$/.test(form.get("language") as string) ? (form.get("language") as string) : prefs.language;
      const result = await limited(user.id, () =>
        transcribe(user.id, { audio, mime: file.type || "application/octet-stream", filename: file.name || "recording.webm" }, { engine: sttEngine, model: prefs.models?.[sttEngine], language }, c.req.raw.signal),
      );
      // Attached files are kept (or not) by the attachment itself; only dictated recordings fall under retention,
      // and never those from a temporary chat, which stores nothing.
      if (!attached && form?.get("temporary") !== "1") retainRecording(user.id, engine, file.type || "application/octet-stream", audio, result.text);
      return c.json(result);
    },
  )
  .post("/speech/synthesize", async (c) => {
    const user = c.get("user");
    assertFeature(user.id, "voice");
    const body = synthInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "Invalid request." }, 400);
    const prefs = getSettings(user.id).speech?.tts ?? {};
    const engine = body.data.engine ?? (prefs.engine && prefs.engine !== "off" ? prefs.engine : undefined);
    if (!engine) return c.json({ error: "Read aloud is off. Choose a voice in Settings → Voice." }, 400);
    const speech = await limited(user.id, () =>
      synthesize(
        user.id,
        body.data.text,
        { engine, model: body.data.model ?? prefs.models?.[engine], voice: body.data.voice ?? prefs.voices?.[engine], instructions: prefs.instructions },
        c.req.raw.signal,
      ),
    );
    return new Response(speech.audio as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": speech.mime, "Cache-Control": "private, no-store" } });
  })
  .get("/speech/options", async (c) => {
    assertFeature(c.get("user").id, "voice");
    const kind = c.req.query("kind");
    const what = c.req.query("what");
    if ((kind !== "stt" && kind !== "tts") || (what !== "models" && what !== "voices")) return c.json({ error: "kind must be stt or tts, what models or voices" }, 400);
    return c.json(await speechOptions(c.get("user").id, kind, c.req.query("engine") ?? "", what));
  })
  .put("/speech/keys/:service", async (c) => {
    const userId = c.get("user").id;
    await saveKey(userId, serviceParam(c.req.param("service")), await c.req.json().catch(() => null));
    return c.json(speechStatus(userId));
  })
  .delete("/speech/keys/:service", (c) => {
    const userId = c.get("user").id;
    deleteConnection(userId, speechConnectionId(serviceParam(c.req.param("service"))));
    return c.json(speechStatus(userId));
  })
  .get("/speech/recordings", (c) => c.json(recordingStats(c.get("user").id)))
  .delete("/speech/recordings", (c) => c.json({ deleted: deleteRecordings(c.get("user").id) }))

  // Admin: server-wide settings, the local worker, shared keys, retained recordings.
  .use("/admin/speech/*", requireAdmin)
  .use("/admin/speech", requireAdmin)
  .get("/admin/speech", async (c) => {
    const [health, models] = await Promise.all([workerHealth(true), speechWorkerConfigured() ? workerModels().catch(() => null) : null]);
    const keys: Record<string, { connected: boolean; region?: string; baseURL?: string }> = {};
    for (const service of Object.keys(SPEECH_KEY_SERVICES) as SpeechKeyService[]) {
      // Read the shared row itself: the admin's own key for the same service would hide it in getConnection.
      const shared = db.prepare("SELECT base_url FROM shared_connections WHERE provider_id = ?").get(speechConnectionId(service)) as { base_url: string | null } | undefined;
      keys[service] = {
        connected: !!shared,
        ...(service === "azure" && shared?.base_url ? { region: new URL(shared.base_url).hostname.split(".")[0] } : {}),
        ...(service.startsWith("compatible-") && shared?.base_url ? { baseURL: shared.base_url } : {}),
      };
    }
    return c.json({
      settings: adminSpeech(),
      worker: {
        configured: speechWorkerConfigured(),
        reachable: !!health,
        sttRunning: !!health?.stt,
        ttsRunning: !!health?.tts,
        // Older workers omit these; the settings page handles nulls and undefined.
        requestedDevice: health?.requestedDevice === "cpu" || health?.requestedDevice === "cuda" || health?.requestedDevice === "auto" ? health!.requestedDevice : null,
        device: health?.device === "cpu" || health?.device === "cuda" ? health!.device : null,
        computeType: bounded(health?.computeType, 40),
        gpuName: bounded(health?.gpuName, 120),
        cudaVersion: bounded(health?.cudaVersion, 40),
        cudaAvailable: typeof health?.cudaAvailable === "boolean" ? health.cudaAvailable : null,
        degraded: health?.degraded === true,
        reason: bounded(health?.reason, 300),
        model: bounded(health?.model, 100),
        downloaded: models?.downloaded ?? [],
      },
      whisperModels: WHISPER_MODELS,
      recordings: recordingStats(),
      keys,
    });
  })
  .put("/admin/speech", async (c) => {
    const body = adminSpeechSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "Invalid settings." }, 400);
    const before = adminSpeech();
    setAdminSpeech(body.data);
    // Fetch a newly chosen model now, so the first user does not wait for the download.
    if (speechWorkerConfigured() && body.data.local.stt && body.data.local.whisperModel !== before.local.whisperModel) void workerPreload("stt", body.data.local.whisperModel).catch(() => {});
    if (speechWorkerConfigured() && body.data.local.tts && body.data.local.defaultVoice !== before.local.defaultVoice) void workerPreload("tts", body.data.local.defaultVoice).catch(() => {});
    return c.json(adminSpeech());
  })
  .post("/admin/speech/preload", async (c) => {
    const body = z.object({ kind: z.enum(["stt", "tts"]), name: z.string().min(1).max(100) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Invalid model." }, 400);
    await workerPreload(body.data.kind, body.data.name);
    return c.json({ ok: true });
  })
  .delete("/admin/speech/recordings", (c) => c.json({ deleted: deleteRecordings() }))
  .put("/admin/speech/keys/:service", async (c) => {
    await saveKey(null, serviceParam(c.req.param("service")), await c.req.json().catch(() => null));
    return c.json({ ok: true });
  })
  .delete("/admin/speech/keys/:service", (c) => {
    deleteConnection(null, speechConnectionId(serviceParam(c.req.param("service"))));
    return c.json({ ok: true });
  });
