import type { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";

/**
 * Test-only helpers for the channel suites. Each suite sets its own data directory and secret before
 * importing the database, then builds the same app shape and uses these helpers.
 */

export type Call = (url: string, init?: { method?: string; json?: unknown; body?: BodyInit; user?: string; headers?: Record<string, string> }) => Promise<Response>;

export function seedUsers(db: DatabaseSync, users: Array<[id: string, name: string, role?: "admin" | "user"]>): void {
  for (const [id, name, role] of users) {
    db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'unused', ?, 1)").run(id, `${id}@example.test`, name, role ?? "user");
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256Like(id), id, Date.now() + 3_600_000);
  }
}

// The suites import sha256 from crypto; this helper only needs the same deterministic token per user.
import { createHash } from "node:crypto";
const sha256Like = (value: string) => createHash("sha256").update(value).digest("hex");

export function makeCall(app: Hono): Call {
  return (url, init = {}) => {
    const headers: Record<string, string> = {
      cookie: `okaychat_session=${init.user ?? "alice"}`,
      ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    };
    return Promise.resolve(
      app.request(`http://app/api${url}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
      }),
    );
  };
}

export async function createRoom(call: Call, input: Record<string, unknown>, user = "alice"): Promise<{ id: string; revision: number }> {
  const response = await call("/channels", { method: "POST", json: { clientId: crypto.randomUUID(), ...input }, user });
  const body = (await response.json()) as { channel: { id: string; revision: number } };
  if (response.status !== 201) throw new Error(`create room failed: ${response.status} ${JSON.stringify(body)}`);
  return body.channel;
}

export async function joinRoom(call: Call, id: string, user: string): Promise<void> {
  const response = await call(`/channels/${id}/join`, { method: "POST", json: {}, user });
  if (response.status !== 200) throw new Error(`join failed: ${response.status}`);
}

export async function postMessage(call: Call, id: string, input: Record<string, unknown>, user = "alice"): Promise<{ message: { id: string; seq: number; revision: number; threadRootId: string | null } }> {
  const response = await call(`/channels/${id}/messages`, { method: "POST", json: { clientId: crypto.randomUUID(), ...input }, user });
  const body = (await response.json()) as { message: { id: string; seq: number; revision: number; threadRootId: string | null } };
  if (response.status !== 201) throw new Error(`post failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

export async function uploadFile(call: Call, id: string, file: File, user = "alice"): Promise<{ id: string; url: string; image: boolean; mime: string; name: string }> {
  const form = new FormData();
  form.set("file", file);
  const response = await call(`/channels/${id}/attachments`, { method: "POST", body: form, user });
  const body = (await response.json()) as { attachment: { id: string; url: string; image: boolean; mime: string; name: string } };
  if (response.status !== 201) throw new Error(`upload failed: ${response.status} ${JSON.stringify(body)}`);
  return body.attachment;
}
