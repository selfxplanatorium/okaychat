import type { UIMessage } from "ai";
import { applyWidgetEdits, type WidgetEdit } from "generative-frame/tools";
import { parseSpecStream, type Spec } from "generative-frame/spec";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ArtifactToolResult, DocumentArtifactKind, SharedPart, SharedThread } from "../shared/types.js";
import {
  MAX_SHARE_LABEL,
  MAX_SHARE_PASSWORD,
  MAX_SHARE_EXPIRY_MS,
  MAX_SHARES_PER_THREAD,
  MAX_SHARES_PER_USER,
  MAX_SNAPSHOT_BYTES,
  MIN_SHARE_PASSWORD,
  SHARE_MODES,
  normalizeShareLabel,
  shareExpired,
  type ShareLink,
  type ShareMode,
} from "../shared/share-links.js";
import { artifactData, artifactVersions, DOCUMENT_MIME, documentFilename } from "./artifacts.js";
import { previewXlsx } from "./documents/lazy.js";
import { assertFeature, featureAllowed } from "./permissions/guard.js";
import { forgiveFailure, limited, recordFailure, type AppEnv } from "./auth.js";
import { hashPassword, randomToken, verifyPassword } from "./crypto.js";
import { db } from "./db.js";
import { AppError, errorJson } from "./errors.js";
import { refUploadId } from "./media/refs.js";
import { getMedia, mediaPath } from "./media/store.js";
import { serveImage } from "./media/variants.js";
import { assertStorage } from "./quota.js";
import {
  clearShareCookie,
  setShareCookie,
  SHARE_COOKIE_TTL_SECONDS,
  shareCookie,
  unlockKey,
  verifyShareCookie,
} from "./share-access.js";
import { imagePath } from "./tools/image.js";
import { currentBranch, getThread, isTemporaryThread } from "./threads.js";
import { threadBusy } from "./thread-runs.js";

// Read-only public links. A link is live (the chat's current branch) or frozen (a captured snapshot),
// may expire, and may need a password. Only text, generated images, artifacts, and generative UI are
// exposed: reasoning, tool inputs, usage, and costs stay private.

interface ShareRow {
  token: string;
  user_id: string;
  thread_id: string;
  label: string;
  mode: ShareMode;
  expires_at: number | null;
  password_hash: string | null;
  snapshot_json: string | null;
  snapshot_assets_json: string | null;
  snapshot_at: number | null;
  view_count: number;
  last_viewed_at: number | null;
  created_at: number;
  thread_title?: string | null;
}

interface ShareAssets {
  artifacts: Record<string, number>;
  images: string[];
  uploads: string[];
}

interface SnapshotPayload {
  title: string | null;
  createdAt: number;
  messages: SharedThread["messages"];
}

const byToken = (token: string) =>
  db.prepare("SELECT * FROM shares WHERE token = ?").get(token) as ShareRow | undefined;

const ownedByToken = (userId: string, token: string) =>
  db.prepare(
    `SELECT s.*, t.title AS thread_title FROM shares s LEFT JOIN threads t ON t.id = s.thread_id
      WHERE s.token = ? AND s.user_id = ?`,
  ).get(token, userId) as ShareRow | undefined;

/** A public read needs the row, a live (unexpired) link, and the owner's current sharing permission. */
const publicShare = (token: string): ShareRow | undefined => {
  const share = byToken(token);
  if (!share || shareExpired(share.expires_at) || !featureAllowed(share.user_id, "sharing")) return undefined;
  return share;
};

const toolName = (part: { type: string; toolName?: string }) => part.toolName ?? part.type.replace(/^tool-/, "");

const ARTIFACT_TOOLS = new Set(["create_artifact", "update_artifact", "create_document", "edit_document", "import_document"]);
// Helpers (`read_me`, `preview_widget`) render nothing in the chat either.
const GENERATIVE_TOOLS = new Set(["show_widget", "edit_widget", "render_spec", "read_me", "preview_widget"]);

type GenerativePart = Extract<SharedPart, { type: "widget" | "spec" }>;

/**
 * Widgets and specs are replayed from history the way generative-frame does on the client: `show_widget`
 * sets a title's code and `edit_widget` applies to it; `render_spec` patches apply onto the title's earlier
 * spec. Results of earlier tools are not mounted under `/tools`, since tool outputs stay private.
 */
function generativeUI() {
  const codes = new Map<string, string>();
  const specs = new Map<string, Spec>();
  return (name: string, input: Record<string, unknown>): GenerativePart | undefined => {
    const title = typeof input.title === "string" ? input.title : "";
    if (name === "show_widget" && typeof input.widget_code === "string" && input.widget_code.trim()) {
      codes.set(title, input.widget_code);
      return { type: "widget", title, code: input.widget_code };
    }
    if (name === "edit_widget" && Array.isArray(input.edits)) {
      const previous = codes.get(title);
      const applied = previous === undefined ? undefined : applyWidgetEdits(previous, input.edits as WidgetEdit[]);
      if (!applied?.ok) return undefined;
      codes.set(title, applied.code);
      return { type: "widget", title, code: applied.code };
    }
    if (name === "render_spec") {
      const base = specs.get(title);
      let spec: Spec | undefined;
      if (input.spec && typeof input.spec === "object" && typeof (input.spec as Spec).root === "string") {
        const given = input.spec as Spec;
        spec = { state: {}, ...given, elements: given.elements && typeof given.elements === "object" ? given.elements : {} };
      } else if (typeof input.patches === "string") spec = parseSpecStream(input.patches, base ? { initial: base } : {}).spec;
      if (!spec) return undefined;
      specs.set(title, spec);
      return { type: "spec", title, spec };
    }
    return undefined;
  };
}

function sharedParts(message: UIMessage, token: string, resolveUI: ReturnType<typeof generativeUI>): SharedPart[] {
  const out: SharedPart[] = [];
  for (const raw of message.parts) {
    const part = raw as { type: string; text?: string; mediaType?: string; url?: string; state?: string; input?: unknown; output?: unknown; toolName?: string };
    if (part.type === "text" && part.text?.trim()) out.push({ type: "text", text: part.text });
    else if (part.type === "file" && part.mediaType?.startsWith("image/") && part.url?.startsWith("data:")) out.push({ type: "image", url: part.url });
    else if (part.type === "file" && part.mediaType?.startsWith("image/") && refUploadId(part.url)) {
      out.push({ type: "image", url: `/api/public/shares/${token}/uploads/${refUploadId(part.url)}`, variants: true });
    }
    else if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
      const name = toolName(part);
      const output = part.state === "output-available" ? part.output : undefined;
      const ui = GENERATIVE_TOOLS.has(name) && part.input && typeof part.input === "object" ? resolveUI(name, part.input as Record<string, unknown>) : undefined;
      if (ui) {
        // A later call with the same title in the same message replaces what an earlier one shows.
        const earlier = out.findIndex((p) => (p.type === "widget" || p.type === "spec") && p.type === ui.type && p.title === ui.title);
        if (earlier >= 0) out.splice(earlier, 1);
        out.push(ui);
      } else if (GENERATIVE_TOOLS.has(name)) continue;
      else if (name === "generate_image" && (output as { id?: string })?.id) {
        const image = output as { id: string; width?: number | null; height?: number | null };
        out.push({ type: "image", url: `/api/public/shares/${token}/images/${image.id}`, variants: true, ...(image.width && image.height ? { width: image.width, height: image.height } : {}) });
      } else if (ARTIFACT_TOOLS.has(name) && (output as ArtifactToolResult)?.id) {
        const a = output as ArtifactToolResult;
        out.push({ type: "artifact", id: a.id, title: a.title, kind: a.kind, version: a.version });
      } else out.push({ type: "tool", name });
    }
  }
  return out;
}

function sharedMessages(share: { user_id: string; thread_id: string; token: string }): SharedThread["messages"] {
  const resolveUI = generativeUI();
  return currentBranch(share.user_id, share.thread_id)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ id: m.id, role: m.role as "user" | "assistant", parts: sharedParts(m, share.token, resolveUI) }))
    .filter((m) => m.parts.length > 0);
}

/**
 * The artifacts (newest version shown) and images the shared branch displays. Asset routes serve
 * only these, so artifacts and images from discarded branches stay private.
 */
function sharedAssets(share: { user_id: string; thread_id: string; token: string }) {
  const artifacts = new Map<string, number>();
  const images = new Set<string>();
  const uploads = new Set<string>();
  const imagePrefix = `/api/public/shares/${share.token}/images/`;
  const uploadPrefix = `/api/public/shares/${share.token}/uploads/`;
  for (const message of sharedMessages(share)) {
    for (const part of message.parts) {
      if (part.type === "artifact") artifacts.set(part.id, Math.max(artifacts.get(part.id) ?? 0, part.version));
      else if (part.type === "image" && part.url.startsWith(imagePrefix)) images.add(part.url.slice(imagePrefix.length));
      else if (part.type === "image" && part.url.startsWith(uploadPrefix)) uploads.add(part.url.slice(uploadPrefix.length));
    }
  }
  return { artifacts, images, uploads };
}

/** The capture is stored twice: the payload and the asset allowlist. Both count against the quota. */
function buildSnapshot(share: { user_id: string; thread_id: string; token: string }): { json: string; assetsJson: string; bytes: number } {
  const thread = getThread(share.user_id, share.thread_id);
  const payload: SnapshotPayload = { title: thread?.title ?? null, createdAt: thread?.createdAt ?? Date.now(), messages: sharedMessages(share) };
  const live = sharedAssets(share);
  const assets: ShareAssets = { artifacts: Object.fromEntries(live.artifacts), images: [...live.images], uploads: [...live.uploads] };
  const json = JSON.stringify(payload);
  const assetsJson = JSON.stringify(assets);
  return { json, assetsJson, bytes: Buffer.byteLength(json) + Buffer.byteLength(assetsJson) };
}

/** Live links read the branch (or the capture) every time; frozen links never look at the chat again. */
function payloadFor(share: ShareRow): SharedThread {
  const mode = share.mode;
  if (mode === "frozen") {
    // A frozen link never falls back to the live branch: a missing or unreadable capture is empty,
    // not a window onto later messages.
    const empty: SharedThread = { title: null, createdAt: share.created_at, messages: [], mode, frozenAt: share.snapshot_at, expiresAt: share.expires_at };
    if (!share.snapshot_json) return empty;
    try {
      const stored = JSON.parse(share.snapshot_json) as SnapshotPayload;
      return { ...stored, mode, frozenAt: share.snapshot_at, expiresAt: share.expires_at };
    } catch {
      return empty;
    }
  }
  const thread = getThread(share.user_id, share.thread_id);
  return {
    title: thread?.title ?? null,
    createdAt: thread?.createdAt ?? share.created_at,
    messages: sharedMessages(share),
    mode: "live",
    frozenAt: null,
    expiresAt: share.expires_at,
  };
}

function assetsFor(share: ShareRow): ShareAssets {
  if (share.mode === "frozen" && share.snapshot_assets_json) {
    try {
      const parsed = JSON.parse(share.snapshot_assets_json) as Partial<ShareAssets>;
      const artifacts: Record<string, number> = {};
      for (const [id, version] of Object.entries(parsed.artifacts ?? {})) {
        if (typeof version === "number" && Number.isFinite(version)) artifacts[id] = version;
      }
      return {
        artifacts,
        images: Array.isArray(parsed.images) ? parsed.images.filter((id): id is string => typeof id === "string") : [],
        uploads: Array.isArray(parsed.uploads) ? parsed.uploads.filter((id): id is string => typeof id === "string") : [],
      };
    } catch {
      return { artifacts: {}, images: [], uploads: [] };
    }
  }
  const live = sharedAssets(share);
  return { artifacts: Object.fromEntries(live.artifacts), images: [...live.images], uploads: [...live.uploads] };
}

/** Versions of a shared artifact up to the newest one the shared branch (or capture) shows. */
function sharedVersions(share: ShareRow, id: string) {
  const newest = assetsFor(share).artifacts[id];
  if (newest === undefined) return [];
  return artifactVersions(share.thread_id, id).filter((v) => v.version <= newest);
}

const toShareLink = (row: ShareRow): ShareLink => ({
  token: row.token,
  threadId: row.thread_id,
  threadTitle: row.thread_title ?? null,
  label: row.label,
  mode: row.mode,
  expiresAt: row.expires_at,
  frozenAt: row.mode === "frozen" ? row.snapshot_at : null,
  hasPassword: !!row.password_hash,
  createdAt: row.created_at,
  lastViewedAt: row.last_viewed_at,
  viewCount: row.view_count,
  expired: shareExpired(row.expires_at),
});

function expiryProblem(value: number | null): AppError | null {
  if (value === null) return null;
  const now = Date.now();
  if (!Number.isInteger(value) || value <= now || value > now + MAX_SHARE_EXPIRY_MS) {
    return new AppError({ code: "validation", message: "Pick an expiry between now and one year from now." });
  }
  return null;
}

function passwordProblem(value: string): AppError | null {
  if (value.length < MIN_SHARE_PASSWORD || value.length > MAX_SHARE_PASSWORD) {
    return new AppError({ code: "validation", message: `A password needs ${MIN_SHARE_PASSWORD} to ${MAX_SHARE_PASSWORD} characters.` });
  }
  return null;
}

const privateHeaders = { "Cache-Control": "private, no-store" };
const publicJson = (c: Context, body: unknown, status: 200 | 400 | 401 | 404 | 409 | 413 | 423 | 429 = 200) =>
  c.json(body, status, { "Cache-Control": "no-store" });

/** The shared shape for a missing, expired, or forbidden link: one sentence, never which one it was. */
const missingLink = (c: Context) => publicJson(c, { error: "This link was revoked or never existed." }, 404);

const createBody = z.object({
  label: z.string().max(MAX_SHARE_LABEL).optional(),
  mode: z.enum(SHARE_MODES).optional(),
  expiresAt: z.number().int().nullable().optional(),
  password: z.string().max(MAX_SHARE_PASSWORD).optional(),
});

const updateBody = z.object({
  label: z.string().max(MAX_SHARE_LABEL).optional(),
  mode: z.enum(SHARE_MODES).optional(),
  expiresAt: z.number().int().nullable().optional(),
  password: z.string().max(MAX_SHARE_PASSWORD).nullable().optional(),
  refreshSnapshot: z.boolean().optional(),
});

export const shareRoutes = new Hono<AppEnv>()
  // The pre-wave-3 single-link endpoints stay for older clients and bookmarks: they map to the thread's
  // first live link, and revoking them removes every link of that chat.
  .get("/threads/:id/share", (c) => {
    const row = db
      .prepare("SELECT token FROM shares WHERE user_id = ? AND thread_id = ? ORDER BY created_at, token LIMIT 1")
      .get(c.get("user").id, c.req.param("id")) as { token: string } | undefined;
    return c.json({ token: row?.token ?? null });
  })
  .post("/threads/:id/share", async (c) => {
    const user = c.get("user");
    assertFeature(user.id, "sharing");
    const thread = getThread(user.id, c.req.param("id"));
    if (!thread) return c.json({ error: "Thread not found" }, 404);
    if (isTemporaryThread(thread.id)) return c.json({ error: "A temporary chat cannot be shared." }, 409);
    if (thread.compareGroupId) return c.json({ error: "Open this answer as a chat before sharing it." }, 409);
    const existing = db
      .prepare("SELECT token FROM shares WHERE user_id = ? AND thread_id = ? ORDER BY created_at, token LIMIT 1")
      .get(user.id, thread.id) as { token: string } | undefined;
    if (existing) return c.json({ token: existing.token });
    const threadLinks = db.prepare("SELECT COUNT(*) AS n FROM shares WHERE user_id = ? AND thread_id = ?").get(user.id, thread.id) as { n: number };
    const userLinks = db.prepare("SELECT COUNT(*) AS n FROM shares WHERE user_id = ?").get(user.id) as { n: number };
    if (threadLinks.n >= MAX_SHARES_PER_THREAD || userLinks.n >= MAX_SHARES_PER_USER) {
      return c.json({ error: `Up to ${MAX_SHARES_PER_THREAD} links per chat.` }, 409);
    }
    const token = randomToken();
    db.prepare("INSERT INTO shares (token, user_id, thread_id, created_at) VALUES (?, ?, ?, ?)").run(token, user.id, thread.id, Date.now());
    return c.json({ token });
  })
  .delete("/threads/:id/share", (c) => {
    db.prepare("DELETE FROM shares WHERE user_id = ? AND thread_id = ?").run(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .get("/threads/:id/shares", (c) => {
    const userId = c.get("user").id;
    const rows = db
      .prepare(
        `SELECT s.*, t.title AS thread_title FROM shares s LEFT JOIN threads t ON t.id = s.thread_id
          WHERE s.user_id = ? AND s.thread_id = ? ORDER BY s.created_at DESC, s.token DESC`,
      )
      .all(userId, c.req.param("id")) as unknown as ShareRow[];
    return c.json({ shares: rows.map(toShareLink), sharingDisabled: !featureAllowed(userId, "sharing") }, 200, privateHeaders);
  })
  .post("/threads/:id/shares", async (c) => {
    const user = c.get("user");
    assertFeature(user.id, "sharing");
    const body = createBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Invalid share settings" }, 400);
    const thread = getThread(user.id, c.req.param("id"));
    if (!thread) return c.json({ error: "Thread not found" }, 404);
    if (isTemporaryThread(thread.id)) return c.json({ error: "A temporary chat cannot be shared." }, 409);
    if (thread.compareGroupId) return c.json({ error: "Open this answer as a chat before sharing it." }, 409);
    const threadLinks = db.prepare("SELECT COUNT(*) AS n FROM shares WHERE user_id = ? AND thread_id = ?").get(user.id, thread.id) as { n: number };
    if (threadLinks.n >= MAX_SHARES_PER_THREAD) return c.json({ error: `Up to ${MAX_SHARES_PER_THREAD} links per chat.` }, 409);
    const userLinks = db.prepare("SELECT COUNT(*) AS n FROM shares WHERE user_id = ?").get(user.id) as { n: number };
    if (userLinks.n >= MAX_SHARES_PER_USER) return c.json({ error: `Up to ${MAX_SHARES_PER_USER} links per account.` }, 409);
    const mode: ShareMode = body.data.mode ?? "live";
    const expiresAt = body.data.expiresAt ?? null;
    const expiryError = expiryProblem(expiresAt);
    if (expiryError) return errorJson(c, expiryError);
    let passwordHash: string | null = null;
    if (body.data.password) {
      const passwordError = passwordProblem(body.data.password);
      if (passwordError) return errorJson(c, passwordError);
      passwordHash = await hashPassword(body.data.password);
    }
    const token = randomToken();
    const now = Date.now();
    let snapshot: { json: string; assetsJson: string; bytes: number } | null = null;
    if (mode === "frozen") {
      // A reply still streaming is not stored yet, so a capture would silently omit it.
      if (threadBusy(thread.id)) return c.json({ error: "Wait for the reply to finish, or use a live link." }, 409);
      snapshot = buildSnapshot({ user_id: user.id, thread_id: thread.id, token });
      if (snapshot.bytes > MAX_SNAPSHOT_BYTES) return c.json({ error: "This chat is too large to freeze. Share it live instead." }, 413);
      assertStorage(user.id, snapshot.bytes);
    }
    db.prepare(
      `INSERT INTO shares (token, user_id, thread_id, label, mode, expires_at, password_hash, snapshot_json, snapshot_assets_json, snapshot_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      token,
      user.id,
      thread.id,
      normalizeShareLabel(body.data.label ?? ""),
      mode,
      expiresAt,
      passwordHash,
      snapshot?.json ?? null,
      snapshot?.assetsJson ?? null,
      snapshot ? now : null,
      now,
    );
    return c.json({ share: toShareLink(ownedByToken(user.id, token)!) }, 201, privateHeaders);
  })
  .patch("/shares/:token", async (c) => {
    const user = c.get("user");
    const row = ownedByToken(user.id, c.req.param("token"));
    if (!row) return c.json({ error: "Not found" }, 404);
    const body = updateBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Invalid share settings" }, 400);
    // Label and revoke stay available with sharing off; changing what the link shows or who may open it does not.
    if (body.data.mode !== undefined || body.data.password !== undefined || body.data.refreshSnapshot) assertFeature(user.id, "sharing");
    const nextMode: ShareMode = body.data.mode ?? row.mode;
    const expiresAt = body.data.expiresAt === undefined ? row.expires_at : body.data.expiresAt;
    const expiryError = expiryProblem(expiresAt);
    if (expiryError) return errorJson(c, expiryError);
    let passwordHash = row.password_hash;
    if (body.data.password !== undefined) {
      if (body.data.password === null || body.data.password === "") passwordHash = null;
      else {
        const passwordError = passwordProblem(body.data.password);
        if (passwordError) return errorJson(c, passwordError);
        passwordHash = await hashPassword(body.data.password);
      }
    }
    let snapshotJson = row.snapshot_json;
    let snapshotAssets = row.snapshot_assets_json;
    let snapshotAt = row.snapshot_at;
    if (nextMode === "live") {
      // A live link stops carrying the capture, and its bytes stop counting.
      snapshotJson = null;
      snapshotAssets = null;
      snapshotAt = null;
    } else if (row.mode !== "frozen" || !row.snapshot_json || body.data.refreshSnapshot) {
      const thread = getThread(user.id, row.thread_id);
      if (!thread) return c.json({ error: "Thread not found" }, 404);
      if (threadBusy(row.thread_id)) return c.json({ error: "Wait for the reply to finish, or use a live link." }, 409);
      const snapshot = buildSnapshot({ user_id: user.id, thread_id: row.thread_id, token: row.token });
      if (snapshot.bytes > MAX_SNAPSHOT_BYTES) return c.json({ error: "This chat is too large to freeze. Share it live instead." }, 413);
      const previous = (row.snapshot_json ? Buffer.byteLength(row.snapshot_json) : 0) + (row.snapshot_assets_json ? Buffer.byteLength(row.snapshot_assets_json) : 0);
      assertStorage(user.id, snapshot.bytes - previous);
      snapshotJson = snapshot.json;
      snapshotAssets = snapshot.assetsJson;
      snapshotAt = Date.now();
    }
    db.prepare(
      `UPDATE shares SET label = ?, mode = ?, expires_at = ?, password_hash = ?, snapshot_json = ?, snapshot_assets_json = ?, snapshot_at = ?
        WHERE token = ? AND user_id = ?`,
    ).run(
      body.data.label === undefined ? row.label : normalizeShareLabel(body.data.label),
      nextMode,
      expiresAt,
      passwordHash,
      snapshotJson,
      snapshotAssets,
      snapshotAt,
      row.token,
      user.id,
    );
    return c.json({ share: toShareLink(ownedByToken(user.id, row.token)!) });
  })
  .delete("/shares/:token", (c) => {
    db.prepare("DELETE FROM shares WHERE token = ? AND user_id = ?").run(c.req.param("token"), c.get("user").id);
    return c.json({ ok: true });
  })
  .get("/shares", (c) => {
    const userId = c.get("user").id;
    const state = c.req.query("state") ?? "all";
    if (state !== "active" && state !== "expired" && state !== "all") return c.json({ error: "Invalid state" }, 400);
    const limit = Math.min(30, Math.max(1, Number(c.req.query("limit") ?? 30) || 30));
    const where = ["s.user_id = ?"];
    const values: Array<string | number> = [userId];
    const now = Date.now();
    if (state === "active") where.push("(s.expires_at IS NULL OR s.expires_at > ?)"), values.push(now);
    else if (state === "expired") where.push("s.expires_at IS NOT NULL AND s.expires_at <= ?"), values.push(now);
    const cursor = c.req.query("cursor");
    if (cursor) {
      const index = cursor.indexOf(":");
      const createdAt = Number(cursor.slice(0, index));
      const token = cursor.slice(index + 1);
      if (index <= 0 || !Number.isFinite(createdAt) || !token) return c.json({ error: "Invalid cursor" }, 400);
      where.push("(s.created_at < ? OR (s.created_at = ? AND s.token < ?))");
      values.push(createdAt, createdAt, token);
    }
    const rows = db
      .prepare(
        `SELECT s.*, t.title AS thread_title FROM shares s LEFT JOIN threads t ON t.id = s.thread_id
          WHERE ${where.join(" AND ")} ORDER BY s.created_at DESC, s.token DESC LIMIT ?`,
      )
      .all(...values, limit) as unknown as ShareRow[];
    const last = rows.at(-1);
    return c.json(
      {
        shares: rows.map(toShareLink),
        nextCursor: rows.length === limit && last ? `${last.created_at}:${last.token}` : null,
        sharingDisabled: !featureAllowed(userId, "sharing"),
      },
      200,
      privateHeaders,
    );
  });

/** No login. The token is the only key, and every asset re-checks expiry, permission, and the cookie. */
function gated(c: Context, token: string): { share: ShareRow } | { response: Response } {
  const share = publicShare(token);
  if (!share) return { response: missingLink(c) };
  if (share.password_hash && !verifyShareCookie(shareCookie(c, share), share)) {
    return { response: publicJson(c, { locked: true, error: "This link is protected by a password." }, 423) };
  }
  return { share };
}

export const publicShareRoutes = new Hono()
  .get("/:token", (c) => {
    const result = gated(c, c.req.param("token"));
    if ("response" in result) return result.response;
    const share = result.share;
    // A count, not analytics: one bump per link per minute even if the page reloads.
    db.prepare("UPDATE shares SET view_count = view_count + 1, last_viewed_at = ? WHERE token = ? AND (last_viewed_at IS NULL OR last_viewed_at < ?)")
      .run(Date.now(), share.token, Date.now() - 60_000);
    return publicJson(c, payloadFor(share));
  })
  .post(
    "/:token/unlock",
    bodyLimit({ maxSize: 1024, onError: (c) => publicJson(c, { error: "Invalid request" }, 400) }),
    async (c) => {
      const share = publicShare(c.req.param("token"));
      if (!share) return missingLink(c);
      if (!share.password_hash) return publicJson(c, { error: "This link has no password." }, 400);
      const key = unlockKey(c, share.token);
      if (limited(key, 10)) return publicJson(c, { error: "Too many attempts. Try again later." }, 429);
      // Counted before the scrypt run, so a parallel burst cannot all pass the check.
      recordFailure(key);
      const body = z.object({ password: z.string().min(1).max(MAX_SHARE_PASSWORD) }).safeParse(await c.req.json().catch(() => null));
      if (!body.success) return publicJson(c, { error: "Enter the password." }, 400);
      if (!(await verifyPassword(body.data.password, share.password_hash))) {
        return publicJson(c, { error: "Wrong password." }, 401);
      }
      // The attempt counted above succeeded; give it back so honest unlocks do not erode the limit.
      forgiveFailure(key);
      const remaining = share.expires_at === null ? SHARE_COOKIE_TTL_SECONDS : Math.ceil((share.expires_at - Date.now()) / 1000);
      setShareCookie(c, share, Math.min(SHARE_COOKIE_TTL_SECONDS, remaining));
      return publicJson(c, { ok: true });
    },
  )
  .get("/:token/artifacts/:id", (c) => {
    const result = gated(c, c.req.param("token"));
    if ("response" in result) return result.response;
    const versions = sharedVersions(result.share, c.req.param("id"));
    if (!versions.length) return publicJson(c, { error: "Not found" }, 404);
    return publicJson(c, versions);
  })
  .get("/:token/artifacts/:id/file", (c) => {
    const result = gated(c, c.req.param("token"));
    if ("response" in result) return result.response;
    const share = result.share;
    const id = c.req.param("id");
    const version = c.req.query("version") ? Number(c.req.query("version")) : undefined;
    const versions = sharedVersions(share, id);
    const chosen = version === undefined ? versions.at(-1) : versions.find((v) => v.version === version);
    const data = chosen && artifactData(share.thread_id, id, chosen.version);
    if (!data || !chosen) return publicJson(c, { error: "Not found" }, 404);
    const kind = chosen.kind as DocumentArtifactKind;
    return new Response(data as unknown as BodyInit, {
      headers: {
        "Content-Type": DOCUMENT_MIME[kind],
        "Content-Disposition": `inline; filename="${documentFilename(chosen.title, kind)}"`,
        // The bytes never change for a version, but access does: caches must revalidate.
        "Cache-Control": "private, no-cache",
      },
    });
  })
  .get("/:token/artifacts/:id/preview", async (c) => {
    const result = gated(c, c.req.param("token"));
    if ("response" in result) return result.response;
    const share = result.share;
    const id = c.req.param("id");
    const version = c.req.query("version") ? Number(c.req.query("version")) : undefined;
    const versions = sharedVersions(share, id);
    const artifact = version === undefined ? versions.at(-1) : versions.find((v) => v.version === version);
    const data = artifact && artifactData(share.thread_id, id, artifact.version);
    if (!data || !artifact) return publicJson(c, { error: "Not found" }, 404);
    if (artifact.kind !== "xlsx") return publicJson(c, { error: "Preview is only available for spreadsheets" }, 400);
    return publicJson(c, await previewXlsx(data));
  })
  // Every response and revalidation re-checks the link and that the shared branch or capture shows the
  // image, so revoking a link or editing the branch away ends access; `no-cache` keeps caches honest.
  .get("/:token/images/:id", async (c) => {
    const result = gated(c, c.req.param("token"));
    if ("response" in result) return result.response;
    const share = result.share;
    const id = c.req.param("id");
    const image = assetsFor(share).images.includes(id) && (db.prepare(`SELECT i.id, i.mime, i.size FROM images i
      WHERE i.id = ? AND i.user_id = ? AND (i.thread_id = ? OR EXISTS (SELECT 1 FROM image_threads r WHERE r.image_id = i.id AND r.thread_id = ?))`)
      .get(id, share.user_id, share.thread_id, share.thread_id) as { id: string; mime: string; size: number } | undefined);
    if (!image) return publicJson(c, { error: "Not found" }, 404);
    return serveImage(c, { userId: share.user_id, key: image.id, file: imagePath(share.user_id, image.id), mime: image.mime, size: image.size, etag: image.id });
  })
  .get("/:token/uploads/:id", async (c) => {
    const result = gated(c, c.req.param("token"));
    if ("response" in result) return result.response;
    const share = result.share;
    const id = c.req.param("id");
    const upload = assetsFor(share).uploads.includes(id) && (db.prepare("SELECT media_id FROM uploads WHERE id = ? AND user_id = ?").get(id, share.user_id) as { media_id: string | null } | undefined);
    const media = upload && upload.media_id ? getMedia(upload.media_id) : undefined;
    if (!media || media.user_id !== share.user_id) return publicJson(c, { error: "Not found" }, 404);
    return serveImage(c, { userId: share.user_id, key: media.id, file: mediaPath(media), mime: media.mime, size: media.size, etag: media.sha256.slice(0, 32) });
  });
