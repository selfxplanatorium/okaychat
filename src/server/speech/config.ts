import { z } from "zod";
import { DEFAULT_ADMIN_SPEECH, STT_ENGINES, TTS_ENGINES, WHISPER_MODELS, type AdminSpeechSettings, type SpeechSettings } from "../../shared/speech.js";
import { decryptBytes, decrypt, encrypt, encryptBytes, newId } from "../crypto.js";
import { db } from "../db.js";

// Server-wide speech settings (admin) and the retention of recordings. With retention 0, the default, audio
// exists only in memory for the length of the transcription request. See docs/implementation/speech.md.

const PIPER_VOICE = /^[a-z]{2,3}_[A-Z]{2}-[A-Za-z0-9_]+-(x_low|low|medium|high)$/;

export const adminSpeechSchema = z
  .object({
    // Up to 90 days. 0 stores nothing.
    retentionHours: z.number().int().min(0).max(24 * 90),
    maxRecordingSeconds: z.number().int().min(10).max(3600),
    local: z
      .object({
        stt: z.boolean(),
        tts: z.boolean(),
        whisperModel: z.enum(WHISPER_MODELS as [string, ...string[]]),
        vad: z.boolean(),
        defaultVoice: z.string().regex(PIPER_VOICE),
      })
      .strict(),
  })
  .strict();

export function adminSpeech(): AdminSpeechSettings {
  const row = db.prepare("SELECT value FROM server_settings WHERE key = 'speech'").get() as { value: string } | undefined;
  if (!row) return DEFAULT_ADMIN_SPEECH;
  const stored = JSON.parse(row.value) as Partial<AdminSpeechSettings>;
  const merged = { ...DEFAULT_ADMIN_SPEECH, ...stored, local: { ...DEFAULT_ADMIN_SPEECH.local, ...stored.local } };
  return adminSpeechSchema.safeParse(merged).success ? merged : DEFAULT_ADMIN_SPEECH;
}

export function setAdminSpeech(value: AdminSpeechSettings) {
  db.prepare("INSERT INTO server_settings (key, value) VALUES ('speech', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(value));
  purgeRecordings();
}

const sttIds = STT_ENGINES.map((e) => e.id) as [string, ...string[]];
const ttsIds = TTS_ENGINES.map((e) => e.id) as [string, ...string[]];
const choice = z.string().trim().min(1).max(200);

/** Per-account speech preferences, as the settings route accepts them. */
export const speechSettingsSchema = z
  .object({
    stt: z
      .object({
        engine: z.enum([...sttIds, "off"]).optional(),
        language: z.string().regex(/^([a-z]{2,3})?$/).optional(),
        /** Removed setting that older saves still carry; accepted so they stay valid. */
        autoSend: z.boolean().optional(),
        silenceSeconds: z.number().min(0).max(10).optional(),
        models: z.partialRecord(z.enum(sttIds), choice).optional(),
      })
      .strict()
      .optional(),
    tts: z
      .object({
        engine: z.enum([...ttsIds, "off"]).optional(),
        autoPlay: z.boolean().optional(),
        speed: z.number().min(0.5).max(2).optional(),
        split: z.enum(["sentence", "paragraph", "none"]).optional(),
        models: z.partialRecord(z.enum(ttsIds), choice).optional(),
        voices: z.partialRecord(z.enum(ttsIds), choice).optional(),
        instructions: z.string().max(1000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const validSpeechSettings = (value: unknown): value is SpeechSettings => speechSettingsSchema.safeParse(value).success;

/** Keeps a recording when the admin set a retention period. Encrypted with OKAYCHAT_SECRET like other user content. */
export function retainRecording(userId: string, engine: string, mime: string, audio: Uint8Array, transcript: string) {
  const { retentionHours } = adminSpeech();
  if (retentionHours <= 0) return;
  db.prepare(
    "INSERT INTO speech_recordings (id, user_id, engine, mime, size, audio_enc, transcript_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(newId("rec"), userId, engine, mime, audio.byteLength, encryptBytes(audio), encrypt(transcript), Date.now());
}

/** Deletes recordings past the retention period; all of them when retention is off. */
export function purgeRecordings(now = Date.now()): number {
  const { retentionHours } = adminSpeech();
  const cutoff = retentionHours <= 0 ? Number.MAX_SAFE_INTEGER : now - retentionHours * 3_600_000;
  return Number(db.prepare("DELETE FROM speech_recordings WHERE created_at < ?").run(cutoff).changes);
}

export function deleteRecordings(userId?: string): number {
  return Number((userId ? db.prepare("DELETE FROM speech_recordings WHERE user_id = ?").run(userId) : db.prepare("DELETE FROM speech_recordings").run()).changes);
}

export function recordingStats(userId?: string): { count: number; bytes: number } {
  const row = (userId
    ? db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM speech_recordings WHERE user_id = ?").get(userId)
    : db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM speech_recordings").get()) as { count: number; bytes: number };
  return { count: Number(row.count), bytes: Number(row.bytes) };
}

export function readRecording(userId: string, id: string): { mime: string; audio: Buffer; transcript: string } | null {
  const row = db.prepare("SELECT mime, audio_enc, transcript_enc FROM speech_recordings WHERE id = ? AND user_id = ?").get(id, userId) as
    | { mime: string; audio_enc: Uint8Array; transcript_enc: string }
    | undefined;
  return row ? { mime: row.mime, audio: decryptBytes(row.audio_enc), transcript: decrypt(row.transcript_enc) } : null;
}

let timer: NodeJS.Timeout | null = null;

/** Started from index.ts, not on import, so tests never tick. */
export function startRecordingPurge() {
  if (timer) return;
  purgeRecordings();
  timer = setInterval(() => purgeRecordings(), 10 * 60_000);
  timer.unref();
}
