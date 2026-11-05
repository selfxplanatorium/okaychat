import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { requireAdmin, requireUser, sessionAlive, type AppEnv } from "../auth.js";
import { db, tx } from "../db.js";
import { encrypt } from "../crypto.js";
import { AppError } from "../errors.js";
import { featureAllowed, requireFeature } from "../permissions/guard.js";
import { assertStorage } from "../quota.js";
import { resolveModel } from "../catalog/providers.js";
import { CHANNEL_LIMITS, isChannelNotifyMode, isChannelReaction, type ChannelEventFrame } from "../../shared/channels.js";
import {
  accountRole,
  assertChannelMember,
  assertChannelRole,
  assertRoom,
  assertWritable,
  channelAccess,
  channelRow,
  conflict,
  groupEligible,
  invalid,
  memberRow,
  notFound,
} from "./access.js";
import { channelHistory } from "./history.js";
import { currentCursor, decodeCursor, eventVisible, eventWakeGeneration, latestEventId, projectEvent, readEvents, scanChanges, acquireStream, cursorFor, eventState, waitForEvents } from "./events.js";
import { buildSnapshot, prepareChannelPrompt, resolveChannelBinding, storedBinding, trimSnapshot } from "./ai.js";
import { channelSummary, directoryEntry, inviteSummary, projectMessages, unreadCounts, type ChannelMessageRow } from "./projections.js";
import { chargeRate } from "./rate.js";
import { searchChannels } from "./search.js";
import {
  acceptInvite,
  archiveChannel,
  assertGroupsOwnedBy,
  audit,
  createChannel,
  createRunInTx,
  declineInvite,
  deleteChannel,
  deleteHumanMessage,
  editHumanMessage,
  inviteMembers,
  joinChannel,
  leaveChannel,
  postHumanMessage,
  postRequestHash,
  removeMember,
  revokeInvite,
  runByClient,
  runRow,
  setMemberRole,
  setNotifyMode,
  setReadCursor,
  toggleReaction,
  transferOwner,
  unblockMember,
  updateChannel,
  validateRoomFields,
} from "./store.js";
import { abortChannelRuns, cancelChannelRun, cancelRunsForSource, channelQueueDepth, enqueueChannelRun, runState, settleRunsForDeletion } from "./worker.js";
import { assertContent, bindingSchema, createChannelSchema, createDmSchema, addDmMembersSchema, threadReadSchema, deleteChannelSchema, deleteMessageSchema, editMessageSchema, inviteSchema, patchChannelSchema, postMessageSchema, readSchema, aiRunSchema, archiveSchema, preferencesSchema, roleSchema, transferSchema, adminModerateSchema, adminPatchSchema, adminDeleteSchema } from "./schema.js";
import { addDmMembers, blockUser, createDm, deleteDm, leaveDm, listBlocks, unblockUser } from "./dms.js";
import { resolveThreadPlacement, setThreadRead, threadPage } from "./threads.js";
import { serveChannelAttachment } from "./attachments.js";

const NO_STORE = { "Cache-Control": "private, no-store" };

const json = (c: Context<AppEnv>, value: unknown, status = 200) => c.json(value as never, status as never, NO_STORE);

async function readBody(c: { req: { text: () => Promise<string> } }, maxBytes: number): Promise<unknown> {
  const text = await c.req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new AppError({ code: "validation", status: 413, message: "That request is too large." });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError({ code: "validation", status: 400, message: "That request is not valid JSON." });
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const path = result.error.issues[0]?.path.join(".") ?? "body";
    throw new AppError({ code: "validation", status: 400, message: `Invalid ${path}.` });
  }
  return result.data;
}

const listCursor = (row: { updated_at: number; id: string }) => Buffer.from(JSON.stringify({ v: 1, u: row.updated_at, i: row.id }), "utf8").toString("base64url");
function parseListCursor(raw: string | undefined): { updatedAt: number; id: string } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { v?: number; u?: number; i?: string };
    if (value.v !== 1 || !Number.isSafeInteger(value.u) || typeof value.i !== "string" || !value.i) throw new Error("bad");
    return { updatedAt: value.u!, id: value.i };
  } catch {
    throw new AppError({ code: "validation", status: 400, message: "Invalid list cursor." });
  }
}

const memberCursor = (row: { name: string; id: string }) => Buffer.from(JSON.stringify({ v: 1, n: row.name, i: row.id }), "utf8").toString("base64url");
function parseMemberCursor(raw: string | undefined): { name: string; id: string } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { v?: number; n?: string; i?: string };
    if (value.v !== 1 || typeof value.n !== "string" || typeof value.i !== "string") throw new Error("bad");
    return { name: value.n, id: value.i };
  } catch {
    throw new AppError({ code: "validation", status: 400, message: "Invalid member cursor." });
  }
}

const like = (query: string) => `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

function pageLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new AppError({ code: "validation", message: "Invalid page size." });
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function listChannels(
  userId: string,
  scope: "joined" | "discover" | "invited",
  query: string,
  before: { updatedAt: number; id: string } | null,
  limit: number,
): { items: unknown[]; nextCursor: string | null; cursor: string } {
  const filter = query ? "AND c.name LIKE ? ESCAPE '\\'" : "";
  const args: Array<string | number> = [userId];
  if (query) args.push(like(query));
  if (before) args.push(before.updatedAt, before.updatedAt, before.id);
  args.push(limit + 1);
  if (scope === "joined") {
    const rows = db
      .prepare(
        `SELECT c.* FROM channels c
         JOIN channel_members m ON m.channel_id = c.id AND m.user_id = ?
         WHERE (c.visibility <> 'group' OR EXISTS (
           SELECT 1 FROM channel_groups g JOIN user_group_members gm ON gm.group_id = g.group_id
           WHERE g.channel_id = c.id AND gm.user_id = ?))
         ${filter} ${before ? "AND (c.updated_at < ? OR (c.updated_at = ? AND c.id > ?))" : ""}
         ORDER BY c.updated_at DESC, c.id ASC LIMIT ?`,
      )
      .all(...[args[0]!, userId, ...args.slice(1)]) as unknown as Array<Record<string, unknown>>;
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => channelSummary(row as never, memberRow(String(row.id), userId)!, true, userId)),
      nextCursor: rows.length > limit && page.length ? listCursor(page.at(-1) as never) : null,
      cursor: currentCursor(userId),
    };
  }
  if (scope === "discover") {
    const rows = db
      .prepare(
        `SELECT c.* FROM channels c
         WHERE c.kind = 'room' AND c.visibility IN ('public','group') AND c.archived_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.user_id = ?)
           AND NOT EXISTS (SELECT 1 FROM channel_exclusions x WHERE x.channel_id = c.id AND x.user_id = ?)
           AND (c.visibility <> 'group' OR EXISTS (
             SELECT 1 FROM channel_groups g JOIN user_group_members gm ON gm.group_id = g.group_id
             WHERE g.channel_id = c.id AND gm.user_id = ?))
         ${filter} ${before ? "AND (c.updated_at < ? OR (c.updated_at = ? AND c.id > ?))" : ""}
         ORDER BY c.updated_at DESC, c.id ASC LIMIT ?`,
      )
      .all(...[userId, userId, userId, ...args.slice(1)]) as unknown as Array<Record<string, unknown>>;
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => directoryEntry(row as never, true, false)),
      nextCursor: rows.length > limit && page.length ? listCursor(page.at(-1) as never) : null,
      cursor: currentCursor(userId),
    };
  }
  const rows = db
    .prepare(
      `SELECT c.*, i.created_at AS invited_at, i.invited_by FROM channel_invites i
       JOIN channels c ON c.id = i.channel_id
       WHERE i.user_id = ? AND c.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM channel_exclusions x WHERE x.channel_id = c.id AND x.user_id = i.user_id)
         AND (c.visibility <> 'group' OR EXISTS (
         SELECT 1 FROM channel_groups g JOIN user_group_members gm ON gm.group_id = g.group_id
         WHERE g.channel_id = c.id AND gm.user_id = ?))
       ${filter} ${before ? "AND (c.updated_at < ? OR (c.updated_at = ? AND c.id > ?))" : ""}
       ORDER BY c.updated_at DESC, c.id ASC LIMIT ?`,
    )
    .all(...[args[0]!, userId, ...args.slice(1)]) as unknown as Array<Record<string, unknown>>;
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) =>
      inviteSummary({
        channel_id: String(row.id),
        name: String(row.name),
        description: String(row.description),
        icon: String(row.icon),
        visibility: row.visibility as never,
        invited_at: Number(row.invited_at),
        invited_by: row.invited_by as string | null,
      }),
    ),
    nextCursor: rows.length > limit && page.length ? listCursor(page.at(-1) as never) : null,
    cursor: currentCursor(userId),
  };
}

function historyQuery(c: Context<AppEnv>): Parameters<typeof channelHistory>[2] {
  const before = c.req.query("beforeSeq");
  const after = c.req.query("afterSeq");
  const aroundId = c.req.query("aroundId");
  const limit = c.req.query("limit");
  const number = (value: string | undefined, name: string) => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AppError({ code: "validation", message: `Invalid ${name}.` });
    return parsed;
  };
  return {
    ...(before !== undefined ? { beforeSeq: number(before, "beforeSeq") } : {}),
    ...(after !== undefined ? { afterSeq: number(after, "afterSeq") } : {}),
    ...(aroundId ? { aroundId } : {}),
    ...(limit !== undefined ? { limit: number(limit, "limit") } : {}),
  };
}

/** Resolves an optional binding mutation to the JSON stored in channels.ai_json. */
async function nextAiJson(userId: string, value: unknown, current: string | null): Promise<string | null> {
  if (value === undefined) return current;
  if (value === null) return null;
  const binding = await resolveChannelBinding(userId, parse(bindingSchema, value));
  return JSON.stringify(binding);
}

export const channelRoutes = new Hono<AppEnv>()
  .use("*", requireUser)
  .use("*", requireFeature("channels"))
  // A smaller ceiling than the app's 100 MiB: channel requests are text and small settings bodies.
  .use("*", bodyLimit({ maxSize: CHANNEL_LIMITS.aiRequestBytes, onError: (c) => c.json({ error: "That request is too large." }, 413) }))
  .use("*", async (c, next) => {
    await next();
    // A bounded preview (serveImage) owns `private, no-cache`; everything else is never stored.
    const existing = c.res.headers.get("Cache-Control");
    if (existing?.includes("no-cache")) return;
    c.header("Cache-Control", c.res.headers.get("Content-Type")?.startsWith("text/event-stream") ? "private, no-store, no-transform" : "private, no-store");
  })
  // Static paths precede parameterized ones.
  .get("/groups", (c) => {
    const rows = db
      .prepare(
        `SELECT g.id, g.name FROM user_groups g JOIN user_group_members m ON m.group_id = g.id
         WHERE m.user_id = ? ORDER BY g.name COLLATE NOCASE, g.id`,
      )
      .all(c.get("user").id) as Array<{ id: string; name: string }>;
    return json(c, { items: rows });
  })
  .post("/dms", async (c) => {
    const userId = c.get("user").id;
    const body = parse(createDmSchema, await readBody(c, CHANNEL_LIMITS.requestBytes));
    const result = createDm(userId, body);
    const member = memberRow(result.value.id, userId)!;
    return json(c, { channel: channelSummary(result.value, member, true, userId) }, result.replay ? 200 : 201);
  })
  .get("/people", (c) => {
    const userId = c.get("user").id;
    const query = (c.req.query("q") ?? "").trim();
    if (!query) return json(c, { items: [] });
    if ([...query].length > CHANNEL_LIMITS.peopleQueryChars) throw invalid("That search is too long.");
    chargeRate(userId, "people");
    const row = db.prepare("SELECT id, name FROM users WHERE lower(email) = ?").get(query.toLowerCase()) as { id: string; name: string } | undefined;
    // A miss, a disabled account, yourself, a blocked pair, and a non-shared group are all the same empty list.
    if (!row || row.id === userId || !featureAllowed(row.id, "channels")) return json(c, { items: [] });
    if (db.prepare("SELECT 1 FROM channel_dm_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)").get(userId, row.id, row.id, userId)) {
      return json(c, { items: [] });
    }
    if (accountRole(userId) !== "admin") {
      const shared = db
        .prepare("SELECT 1 FROM user_group_members a JOIN user_group_members b ON b.group_id = a.group_id WHERE a.user_id = ? AND b.user_id = ?")
        .get(userId, row.id);
      if (!shared) return json(c, { items: [] });
    }
    return json(c, { items: [{ id: row.id, name: row.name }] });
  })
  .get("/dm-blocks", (c) => json(c, { items: listBlocks(c.get("user").id) }))
  .post("/dm-blocks/:userId", (c) => {
    blockUser(c.get("user").id, c.req.param("userId"));
    return json(c, { ok: true });
  })
  .delete("/dm-blocks/:userId", (c) => {
    unblockUser(c.get("user").id, c.req.param("userId"));
    return json(c, { ok: true });
  })
  .get("/search", (c) => {
    const q = c.req.query("q") ?? "";
    const result = searchChannels(c.get("user").id, {
      query: q,
      channelId: c.req.query("channelId") || undefined,
      before: c.req.query("before") || undefined,
      limit: pageLimit(c.req.query("limit"), 20, CHANNEL_LIMITS.searchPage),
    });
    return json(c, result);
  })
  .get("/sync", (c) => {
    const userId = c.get("user").id;
    // One synchronous snapshot: no await between these reads, so mutations after it remain replayable.
    const joined = listChannels(userId, "joined", "", null, 100);
    const pending = db
      .prepare(
        `SELECT i.channel_id, i.created_at AS invited_at, i.invited_by, c.name, c.description, c.icon, c.visibility
         FROM channel_invites i JOIN channels c ON c.id = i.channel_id
         WHERE i.user_id = ? AND c.archived_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM channel_exclusions x WHERE x.channel_id = c.id AND x.user_id = i.user_id)
           AND (c.visibility <> 'group' OR EXISTS (
             SELECT 1 FROM channel_groups g JOIN user_group_members gm ON gm.group_id = g.group_id
             WHERE g.channel_id = c.id AND gm.user_id = i.user_id))
         ORDER BY i.created_at DESC, i.channel_id ASC LIMIT 100`,
      )
      .all(userId) as Array<{
      channel_id: string;
      invited_at: number;
      invited_by: string | null;
      name: string;
      description: string;
      icon: string;
      visibility: never;
    }>;
    return json(c, {
      items: joined.items,
      invites: pending.map((row) =>
        inviteSummary({
          channel_id: row.channel_id,
          name: row.name,
          description: row.description,
          icon: row.icon,
          visibility: row.visibility,
          invited_at: row.invited_at,
          invited_by: row.invited_by,
        }),
      ),
      cursor: currentCursor(userId),
    });
  })
  .get("/events", (c) => {
    const userId = c.get("user").id;
    const session = c.get("session");
    const suppliedRaw = c.req.header("last-event-id") ?? c.req.query("cursor");
    // A malformed/tampered/wrong-user/future cursor is a 400 before any headers are sent.
    const supplied = suppliedRaw ? decodeCursor(suppliedRaw) : null;
    if (supplied && supplied.userId !== userId) throw new AppError({ code: "validation", status: 400, message: "That channel cursor is not valid.", details: { reason: "cursor_invalid" } });
    if (supplied && supplied.epoch === eventState().epoch && supplied.seq > latestEventId()) throw new AppError({ code: "validation", status: 400, message: "That channel cursor is not valid.", details: { reason: "cursor_invalid" } });
    chargeRate(userId, "connect");
    const release = acquireStream(userId);
    const state = eventState();
    const expired = !!supplied && (supplied.epoch !== state.epoch || supplied.seq < state.floor);
    let cursor = supplied?.seq ?? latestEventId();
    let pullResolve: (() => void) | null = null;
    const encoder = new TextEncoder();
    const internal = new AbortController();
    const requestSignal = c.req.raw.signal;
    const onRequestAbort = () => internal.abort();
    requestSignal.addEventListener("abort", onRequestAbort, { once: true });
    let released = false;
    const cleanup = () => {
      if (released) return;
      released = true;
      requestSignal.removeEventListener("abort", onRequestAbort);
      internal.abort();
      pullResolve?.();
      pullResolve = null;
      release();
    };
    const signal = internal.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Do not await in start(): the consumer's first pull() only runs after start resolves, so a
        // backpressure wait here would deadlock the ready frame.
        void (async () => {
        let pendingBytes = 0;
        const write = async (text: string, allowed = () => true) => {
          if (signal.aborted) throw new Error("closed");
          // Native streams have no awaited write: wait for the consumer to pull when the queue is full.
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            await Promise.race([
              new Promise<void>((resolve) => { pullResolve = resolve; }),
              new Promise((_, reject) => {
                const timer = setTimeout(() => reject(new Error("write timeout")), 5000);
                timer.unref?.();
              }),
            ]);
          }
          if (signal.aborted) throw new Error("closed");
          if (!allowed()) return;
          const bytes = encoder.encode(text);
          pendingBytes += bytes.byteLength;
          if (pendingBytes > 256 * 1024) throw new Error("overflow");
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              controller.enqueue(bytes),
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("write timeout")), 5000);
                timer.unref?.();
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
            pendingBytes -= bytes.byteLength;
          }
        };
        try {
          await write("retry: 3000\n\n");
          await write('event: ready\ndata: {"v":1}\n\n');
          if (!supplied) await write('event: reset\ndata: {"reason":"initial"}\n\n');
          if (expired) {
            await write('event: reset\ndata: {"reason":"history_expired"}\n\n');
            controller.close();
            cleanup();
            return;
          }
          const startedAt = Date.now();
          let signals = 0;
          while (!signal.aborted && Date.now() - startedAt < 5 * 60_000) {
            if (!featureAllowed(userId, "channels") || !sessionAlive(session)) {
              await write('event: revoked\ndata: {}\n\n').catch(() => {});
              break;
            }
            if (cursor < eventState().floor) {
              await write('event: reset\ndata: {"reason":"history_expired"}\n\n');
              break;
            }
            const generation = eventWakeGeneration();
            const rows = readEvents(cursor, 200);
            if (!rows.length) {
              // A commit between the scan and the waiter registration is not lost: it bumps the
              // generation synchronously, so this iteration scans again instead of sleeping.
              if (eventWakeGeneration() !== generation) continue;
              await waitForEvents(15_000, signal);
              if (!signal.aborted) await write(": heartbeat\n\n");
              continue;
            }
            for (const row of rows) {
              cursor = row.id;
              if (!eventVisible(userId, row)) continue;
              if (signals >= 256) throw new Error("signal cap");
              signals++;
              const frame: ChannelEventFrame = { cursor: cursorFor(userId, row.id), event: projectEvent(row) };
              await write(`id: ${frame.cursor}\nevent: ${row.kind}\ndata: ${JSON.stringify(frame.event)}\n\n`, () => featureAllowed(userId, "channels") && sessionAlive(session) && eventVisible(userId, row));
            }
          }
          controller.close();
        } catch {
          // A slow or vanished consumer closes without advancing the undelivered cursor.
          try { controller.close(); } catch { /* already closed */ }
        } finally {
          cleanup();
        }
        })();
      },
      pull() {
        pullResolve?.();
        pullResolve = null;
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "private, no-store, no-transform",
        "X-Accel-Buffering": "no",
        "Content-Encoding": "identity",
      },
    });
  })
  .get("/changes", (c) => {
    const cursor = c.req.query("cursor");
    if (!cursor) throw new AppError({ code: "validation", status: 400, message: "A channel cursor is required.", details: { reason: "cursor_invalid" } });
    return json(c, scanChanges(c.get("user").id, cursor));
  })
  .get("/", (c) => {
    const userId = c.get("user").id;
    const scopeRaw = c.req.query("scope") ?? "joined";
    if (scopeRaw !== "joined" && scopeRaw !== "discover" && scopeRaw !== "invited") throw invalid("Invalid room list.");
    const query = (c.req.query("q") ?? "").trim();
    if ([...query].length > CHANNEL_LIMITS.channelQueryChars) throw invalid("That search is too long.");
    const before = parseListCursor(c.req.query("before"));
    const limit = pageLimit(c.req.query("limit"), 20, CHANNEL_LIMITS.listPage);
    return json(c, listChannels(userId, scopeRaw, query, before, limit));
  })
  .post("/", async (c) => {
    const userId = c.get("user").id;
    const body = parse(createChannelSchema, await readBody(c, CHANNEL_LIMITS.requestBytes));
    const groupIds = body.groupIds ?? [];
    const cleaned = validateRoomFields(body.name, body.description, body.icon ?? "hash", body.visibility, groupIds);
    assertGroupsOwnedBy(userId, cleaned.groupIds);
    const aiJson = body.ai === undefined || body.ai === null ? null : JSON.stringify(await resolveChannelBinding(userId, body.ai));
    const hash = JSON.stringify({
      name: cleaned.name,
      description: cleaned.description,
      icon: cleaned.icon,
      visibility: body.visibility,
      groupIds: [...cleaned.groupIds].sort(),
      ai: body.ai ?? null,
    });
    const result = createChannel(userId, {
      clientId: body.clientId,
      name: cleaned.name,
      description: cleaned.description,
      icon: cleaned.icon,
      visibility: body.visibility,
      groupIds: cleaned.groupIds,
      aiJson,
      requestHash: hash,
    });
    return json(c, { channel: channelSummary(result.value, memberRow(result.value.id, userId)!, true, userId) }, result.replay ? 200 : 201);
  })
  .get("/:id", (c) => {
    const userId = c.get("user").id;
    const access = channelAccess(userId, c.req.param("id"));
    if (!access || !access.eligible || db.prepare("SELECT 1 FROM channel_exclusions WHERE channel_id = ? AND user_id = ?").get(access.channel.id, userId)) throw notFound();
    if (access.member && access.eligible) return json(c, { channel: channelSummary(access.channel, access.member, true, userId) });
    const discoverable = access.channel.visibility !== "private" && access.eligible && !access.invited;
    if (!access.invited && !discoverable) throw notFound();
    const excluded = !!db.prepare("SELECT 1 FROM channel_exclusions WHERE channel_id = ? AND user_id = ?").get(access.channel.id, userId);
    return json(c, {
      channel: directoryEntry(access.channel, access.eligible && !excluded && access.channel.archived_at === null, access.invited),
    });
  })
  .patch("/:id", async (c) => {
    const userId = c.get("user").id;
    const { channel, member } = assertChannelRole(userId, c.req.param("id"), ["owner"]);
    assertRoom(channel);
    const body = parse(patchChannelSchema, await readBody(c, CHANNEL_LIMITS.aiRequestBytes));
    const aiJson = await nextAiJson(userId, body.ai, channel.ai_json);
    assertChannelRole(userId, channel.id, ["owner"]);
    const updated = updateChannel(
      userId,
      channel.id,
      { revision: body.revision, ...(body.name !== undefined ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description } : {}), ...(body.icon !== undefined ? { icon: body.icon } : {}), ...(body.groupIds !== undefined ? { groupIds: body.groupIds } : {}), aiJson },
      { admin: false },
    );
    return json(c, { channel: channelSummary(updated, memberRow(updated.id, userId)!, true, userId) });
  })
  .post("/:id/join", (c) => {
    const userId = c.get("user").id;
    const result = joinChannel(userId, c.req.param("id"));
    const channel = channelRow(result.value.channel_id)!;
    return json(c, { channel: channelSummary(channel, result.value, true, userId) }, result.replay ? 200 : 200);
  })
  .post("/:id/invite/accept", (c) => {
    const userId = c.get("user").id;
    const member = acceptInvite(userId, c.req.param("id"));
    const channel = channelRow(member.channel_id)!;
    return json(c, { channel: channelSummary(channel, member, true, userId) });
  })
  .delete("/:id/invite", (c) => {
    declineInvite(c.get("user").id, c.req.param("id"));
    return json(c, { ok: true });
  })
  .post("/:id/leave", (c) => {
    const userId = c.get("user").id;
    const channel = channelRow(c.req.param("id"));
    if (!channel) throw notFound();
    if (channel.kind === "dm") leaveDm(userId, channel.id);
    else leaveChannel(userId, channel.id);
    return json(c, { ok: true });
  })
  .get("/:id/audience", (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelRole(userId, c.req.param("id"), ["owner", "moderator"]);
    assertRoom(channel);
    return json(c, { groupIds: (db.prepare("SELECT group_id FROM channel_groups WHERE channel_id = ? ORDER BY group_id").all(channel.id) as Array<{ group_id: string }>).map((row) => row.group_id) });
  })
  .get("/:id/invites", (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelRole(userId, c.req.param("id"), ["owner", "moderator"]);
    assertRoom(channel);
    const rows = db
      .prepare(
        `SELECT i.user_id AS id, u.name, i.created_at AS createdAt FROM channel_invites i
         JOIN users u ON u.id = i.user_id WHERE i.channel_id = ? ORDER BY i.created_at ASC`,
      )
      .all(channel.id) as Array<{ id: string; name: string; createdAt: number }>;
    return json(c, { items: rows });
  })
  .get("/:id/exclusions", (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelRole(userId, c.req.param("id"), ["owner", "moderator"]);
    assertRoom(channel);
    const rows = db
      .prepare(
        `SELECT x.user_id AS id, u.name, x.created_at AS createdAt FROM channel_exclusions x
         JOIN users u ON u.id = x.user_id WHERE x.channel_id = ? ORDER BY x.created_at ASC`,
      )
      .all(channel.id) as Array<{ id: string; name: string; createdAt: number }>;
    return json(c, { items: rows });
  })
  .get("/:id/members", (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelMember(userId, c.req.param("id"));
    const query = (c.req.query("q") ?? "").trim();
    const after = parseMemberCursor(c.req.query("after"));
    const limit = pageLimit(c.req.query("limit"), 50, 50);
    const rows = db
      .prepare(
        `SELECT u.id, u.name, m.role FROM channel_members m JOIN users u ON u.id = m.user_id
         WHERE m.channel_id = ? ${query ? "AND u.name LIKE ? ESCAPE '\\'" : ""}
         ${after ? "AND (u.name COLLATE NOCASE > ? OR (u.name COLLATE NOCASE = ? AND u.id > ?))" : ""}
         ORDER BY u.name COLLATE NOCASE ASC, u.id ASC LIMIT ?`,
      )
      .all(
        ...[
          channel.id,
          ...(query ? [like(query)] : []),
          ...(after ? [after.name, after.name, after.id] : []),
          limit + 1,
        ],
      ) as Array<{ id: string; name: string; role: "owner" | "moderator" | "member" }>;
    const page = rows.slice(0, limit);
    return json(c, {
      items: page,
      nextCursor: rows.length > limit && page.length ? memberCursor(page.at(-1)!) : null,
    });
  })
  .post("/:id/members", async (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelMember(userId, c.req.param("id"));
    if (channel.kind !== "dm") throw notFound();
    const body = parse(addDmMembersSchema, await readBody(c, CHANNEL_LIMITS.requestBytes));
    const updated = addDmMembers(userId, channel.id, body.userIds);
    return json(c, { channel: channelSummary(updated, memberRow(updated.id, userId)!, true, userId) });
  })
  .get("/:id/candidates", (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelRole(userId, c.req.param("id"), ["owner", "moderator"]);
    assertRoom(channel);
    const email = (c.req.query("q") ?? "").trim().toLowerCase();
    if (!email) throw invalid("Enter the account email.");
    chargeRate(userId, "candidate");
    const row = db.prepare("SELECT id, name FROM users WHERE lower(email) = ?").get(email) as { id: string; name: string } | undefined;
    if (!row || !groupEligible(row.id, channel) || !featureAllowed(row.id, "channels")) return json(c, { items: [] });
    if (memberRow(channel.id, row.id)) return json(c, { items: [] });
    if (db.prepare("SELECT 1 FROM channel_exclusions WHERE channel_id = ? AND user_id = ?").get(channel.id, row.id)) return json(c, { items: [] });
    return json(c, { items: [{ id: row.id, name: row.name }] });
  })
  .post("/:id/invites", async (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelRole(userId, c.req.param("id"), ["owner", "moderator"]);
    assertRoom(channel);
    assertWritable(channel);
    const body = parse(inviteSchema, await readBody(c, CHANNEL_LIMITS.requestBytes));
    assertChannelRole(userId, c.req.param("id"), ["owner", "moderator"]);
    for (const id of body.userIds) {
      if (!featureAllowed(id, "channels")) throw invalid("One of those accounts cannot use team channels.", "binding_unavailable");
    }
    const result = inviteMembers(userId, channel.id, body.userIds);
    return json(c, { added: result.added, pending: result.replayed });
  })
  .delete("/:id/invites/:userId", (c) => {
    const userId = c.get("user").id;
    assertChannelRole(userId, c.req.param("id"), ["owner", "moderator"]);
    revokeInvite(userId, c.req.param("id"), c.req.param("userId"));
    return json(c, { ok: true });
  })
  .delete("/:id/members/:userId", (c) => {
    const userId = c.get("user").id;
    const { channel, member } = assertChannelRole(userId, c.req.param("id"), ["owner", "moderator"]);
    const targetId = c.req.param("userId");
    const target = memberRow(channel.id, targetId);
    if (!target) throw notFound();
    if (member.role === "moderator" && target.role === "moderator") throw new AppError({ code: "forbidden", message: "Moderators cannot remove each other." });
    removeMember(userId, channel.id, targetId);
    return json(c, { ok: true });
  })
  .delete("/:id/exclusions/:userId", (c) => {
    const userId = c.get("user").id;
    assertChannelRole(userId, c.req.param("id"), ["owner", "moderator"]);
    unblockMember(userId, c.req.param("id"), c.req.param("userId"));
    return json(c, { ok: true });
  })
  .patch("/:id/members/:userId", async (c) => {
    const userId = c.get("user").id;
    assertChannelRole(userId, c.req.param("id"), ["owner"]);
    const body = parse(roleSchema, await readBody(c, CHANNEL_LIMITS.requestBytes));
    assertChannelRole(userId, c.req.param("id"), ["owner"]);
    setMemberRole(userId, c.req.param("id"), body.revision, c.req.param("userId"), body.role);
    return json(c, { ok: true });
  })
  .post("/:id/transfer", async (c) => {
    const userId = c.get("user").id;
    assertChannelRole(userId, c.req.param("id"), ["owner"]);
    const body = parse(transferSchema, await readBody(c, CHANNEL_LIMITS.requestBytes));
    assertChannelRole(userId, c.req.param("id"), ["owner"]);
    const channel = transferOwner(userId, c.req.param("id"), body.revision, body.userId);
    return json(c, { channel: channelSummary(channel, memberRow(channel.id, userId)!, true, userId) });
  })
  .post("/:id/archive", async (c) => {
    const userId = c.get("user").id;
    assertChannelRole(userId, c.req.param("id"), ["owner", "moderator"]);
    const body = parse(archiveSchema, await readBody(c, CHANNEL_LIMITS.requestBytes));
    assertChannelRole(userId, c.req.param("id"), ["owner", "moderator"]);
    const channel = archiveChannel(userId, c.req.param("id"), body.revision, body.archived);
    if (body.archived) abortChannelRuns(channel.id);
    return json(c, { channel: channelSummary(channel, memberRow(channel.id, userId)!, true, userId) });
  })
  .delete("/:id", async (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelRole(userId, c.req.param("id"), ["owner"]);
    const body = parse(deleteChannelSchema, await readBody(c, CHANNEL_LIMITS.requestBytes));
    if (channel.kind === "dm") {
      deleteDm(userId, channel.id, body.revision);
      return json(c, { ok: true });
    }
    tx(() => {
      assertRoomRevision(c.req.param("id"), body.revision);
      settleRunsForDeletion(c.req.param("id"));
      deleteChannel(userId, c.req.param("id"), body.revision, body.reason ?? "");
    });
    return json(c, { ok: true });
  })
  .get("/:id/messages", (c) => {
    const userId = c.get("user").id;
    assertChannelMember(userId, c.req.param("id"));
    return json(c, channelHistory(c.req.param("id"), userId, historyQuery(c)));
  })
  .get("/:id/messages/:messageId/thread", (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelMember(userId, c.req.param("id"));
    const number = (value: string | undefined, name: string) => {
      if (value === undefined) return undefined;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AppError({ code: "validation", message: `Invalid ${name}.` });
      return parsed;
    };
    return json(
      c,
      threadPage(channel.id, c.req.param("messageId"), userId, {
        ...(c.req.query("beforeSeq") !== undefined ? { beforeSeq: number(c.req.query("beforeSeq"), "beforeSeq") } : {}),
        ...(c.req.query("afterSeq") !== undefined ? { afterSeq: number(c.req.query("afterSeq"), "afterSeq") } : {}),
        ...(c.req.query("limit") !== undefined ? { limit: number(c.req.query("limit"), "limit") } : {}),
      }),
    );
  })
  .post("/:id/threads/:rootId/read", async (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelMember(userId, c.req.param("id"));
    const body = parse(threadReadSchema, await readBody(c, CHANNEL_LIMITS.requestBytes));
    const result = setThreadRead(userId, channel.id, c.req.param("rootId"), body.throughSeq);
    return json(c, { readSeq: result.readSeq, unread: result.unread });
  })
  .get("/:id/attachments/:attachmentId", (c) => serveChannelAttachment(c, c.get("user").id, c.req.param("id"), c.req.param("attachmentId")))
  .get("/:id/messages/:messageId", (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelMember(userId, c.req.param("id"));
    const row = db.prepare("SELECT * FROM channel_messages WHERE channel_id = ? AND id = ?").get(channel.id, c.req.param("messageId")) as ChannelMessageRow | undefined;
    if (!row) throw notFound();
    return json(c, { message: projectMessages([row], userId)[0], cursor: currentCursor(userId) });
  })
  .post("/:id/messages", async (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelMember(userId, c.req.param("id"));
    assertWritable(channel);
    const body = parse(postMessageSchema, await readBody(c, CHANNEL_LIMITS.requestBytes));
    assertChannelMember(userId, c.req.param("id"));
    const normalized = assertContent(body.body, (body.attachmentIds ?? []).length > 0);
    const hash = postRequestHash({ ...body, body: normalized });
    if (body.requestAi) {
      // A reply is never a room AI source, and a DM never runs one: both are refused before model resolution.
      if (!normalized.trim()) {
        throw new AppError({ code: "validation", status: 422, message: "Add a line of text before asking the assistant.", details: { reason: "attachments_only" } });
      }
      if (body.threadRootId) {
        throw new AppError({ code: "validation", status: 422, message: "Assistant replies are not available in threads.", details: { reason: "thread_ai" } });
      }
      if (channel.kind === "dm") {
        throw new AppError({ code: "validation", status: 422, message: "Direct messages do not support assistant replies.", details: { reason: "dm_ai" } });
      }
      // An exact duplicate is answered before model resolution, queue checks, or charges.
      const replay = db
        .prepare("SELECT id, request_hash FROM channel_messages WHERE channel_id = ? AND author_id = ? AND client_id = ? AND kind = 'human'")
        .get(channel.id, userId, body.clientId) as { id: string; request_hash: string | null } | undefined;
      if (replay && replay.request_hash === hash) {
        const run = db.prepare("SELECT id FROM channel_ai_runs WHERE source_id = ?").get(replay.id) as { id: string } | undefined;
        return json(c, { message: messageById(channel.id, replay.id, userId), runId: run?.id ?? null, messageId: replay.id });
      }
      // A bad quote must not reach resolveModel; a quote of a reply also makes this a thread reply.
      const placement = resolveThreadPlacement(channel.id, body.threadRootId, body.replyTo);
      if (placement.threadRoot) {
        throw new AppError({ code: "validation", status: 422, message: "Assistant replies are not available in threads.", details: { reason: "thread_ai" } });
      }
      const binding = storedBinding(channel.ai_json);
      if (!binding) throw conflict("binding_unavailable", "This room has no AI binding. Ask the owner to choose one.");
      if (!featureAllowed(userId, "channels")) throw new AppError({ code: "forbidden", message: "Team channels are disabled for this account." });
      if (channelQueueDepth() >= CHANNEL_LIMITS.aiQueue) throw new AppError({ code: "rate_limited", status: 429, message: "The room AI queue is full.", retryAfterMs: 5_000 });
      const resolved = await resolveModel(userId, binding.modelRef);
      const result = postHumanMessage(
        userId,
        channel.id,
        { clientId: body.clientId, body: normalized, ...(body.replyTo ? { replyTo: body.replyTo } : {}), ...(body.threadRootId ? { threadRootId: body.threadRootId } : {}), ...(body.attachmentIds?.length ? { attachmentIds: body.attachmentIds } : {}), ...(body.mentions ? { mentions: body.mentions } : {}), requestAi: true, requestHash: hash },
        (human) => {
          chargeRate(userId, "ai");
          const snapshot = trimSnapshot(buildSnapshot(channel, human.messageId, userId));
          const prepared = prepareChannelPrompt({
            userId,
            modelRef: binding.modelRef,
            channel,
            binding,
            snapshot,
            modelContext: resolved.model.context,
            modelMaxOutput: resolved.model.maxOutput,
          });
          const configJson = JSON.stringify({ version: 1, binding, injectionFlagged: prepared.injectionFlagged });
          const inputEnc = encrypt(JSON.stringify({ v: 1, snapshot }));
          const reserved = Buffer.byteLength(configJson) + Buffer.byteLength(inputEnc) + 1024 + 64 * 1024;
          assertStorage(channel.owner_id, reserved);
          const run = createRunInTx(userId, channel, human, {
            clientId: body.clientId,
            requestHash: hash,
            modelRef: binding.modelRef,
            configJson,
            inputEnc,
            reservedBytes: reserved,
          });
          return { runId: run.runId };
        },
      );
      if (!result.replay && result.value.runId) enqueueChannelRun(result.value.runId);
      return json(c, { messageId: result.value.messageId, runId: result.value.runId, message: messageById(channel.id, result.value.messageId, userId) }, result.replay ? 200 : 202);
    }
    const result = postHumanMessage(userId, channel.id, { clientId: body.clientId, body: normalized, ...(body.replyTo ? { replyTo: body.replyTo } : {}), ...(body.threadRootId ? { threadRootId: body.threadRootId } : {}), ...(body.attachmentIds?.length ? { attachmentIds: body.attachmentIds } : {}), ...(body.mentions ? { mentions: body.mentions } : {}), requestAi: false, requestHash: hash }, () => null);
    return json(c, { message: messageById(channel.id, result.value.messageId, userId), cursor: currentCursor(userId) }, result.replay ? 200 : 201);
  })
  .patch("/:id/messages/:messageId", async (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelMember(userId, c.req.param("id"));
    assertWritable(channel);
    const body = parse(editMessageSchema, await readBody(c, CHANNEL_LIMITS.requestBytes));
    assertWritable(assertChannelMember(userId, c.req.param("id")).channel);
    const normalized = assertContent(body.body, true);
    editHumanMessage(userId, channel.id, c.req.param("messageId"), body.revision, normalized, body.mentions);
    return json(c, { message: messageById(channel.id, c.req.param("messageId"), userId) });
  })
  .delete("/:id/messages/:messageId", async (c) => {
    const userId = c.get("user").id;
    assertChannelMember(userId, c.req.param("id"));
    // Archived rooms still allow destructive cleanup of their own messages.
    const body = parse(deleteMessageSchema, await readBody(c, CHANNEL_LIMITS.requestBytes));
    const { channel, member } = assertChannelMember(userId, c.req.param("id"));
    const row = db.prepare("SELECT kind FROM channel_messages WHERE channel_id = ? AND id = ?").get(channel.id, c.req.param("messageId")) as { kind: "human" | "ai" } | undefined;
    if (!row) throw notFound();
    // Stopping a reply is the cancel route's decision (requester or moderator), never a side effect here.
    if (row.kind === "ai") throw new AppError({ code: "forbidden", message: "Stop the reply instead of deleting it." });
    const moderator = member.role === "owner" || member.role === "moderator";
    deleteHumanMessage(userId, channel.id, c.req.param("messageId"), body.revision, { moderator, reason: body.reason ?? "" });
    // Only an authorized, committed tombstone stops replies to its source.
    cancelRunsForSource(channel.id, c.req.param("messageId"));
    return json(c, { ok: true });
  })
  .put("/:id/messages/:messageId/reactions/:emoji", (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelMember(userId, c.req.param("id"));
    assertWritable(channel);
    const emoji = c.req.param("emoji");
    if (!isChannelReaction(emoji)) throw invalid("That reaction is not supported.", "reaction");
    const result = toggleReaction(userId, channel.id, c.req.param("messageId"), emoji, true);
    return json(c, { message: messageById(channel.id, c.req.param("messageId"), userId), revision: result.revision });
  })
  .delete("/:id/messages/:messageId/reactions/:emoji", (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelMember(userId, c.req.param("id"));
    assertWritable(channel);
    const emoji = c.req.param("emoji");
    if (!isChannelReaction(emoji)) throw invalid("That reaction is not supported.", "reaction");
    const result = toggleReaction(userId, channel.id, c.req.param("messageId"), emoji, false);
    return json(c, { message: messageById(channel.id, c.req.param("messageId"), userId), revision: result.revision });
  })
  .post("/:id/read", async (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelMember(userId, c.req.param("id"));
    const body = parse(readSchema, await readBody(c, CHANNEL_LIMITS.requestBytes));
    assertChannelMember(userId, c.req.param("id"));
    const result = setReadCursor(userId, channel.id, body.throughSeq);
    return json(c, { readSeq: result.readSeq, ...unreadCounts(channel.id, userId, result.readSeq) });
  })
  .patch("/:id/preferences", async (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelMember(userId, c.req.param("id"));
    const body = parse(preferencesSchema, await readBody(c, CHANNEL_LIMITS.requestBytes));
    assertChannelMember(userId, c.req.param("id"));
    if (!isChannelNotifyMode(body.notifyMode)) throw invalid("Invalid notification mode.");
    setNotifyMode(userId, channel.id, body.notifyMode);
    return json(c, { ok: true });
  })
  .post("/:id/ai-runs", async (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelMember(userId, c.req.param("id"));
    assertRoom(channel);
    assertWritable(channel);
    const body = parse(aiRunSchema, await readBody(c, CHANNEL_LIMITS.requestBytes));
    assertChannelMember(userId, c.req.param("id"));
    const hash = JSON.stringify({ clientId: body.clientId, sourceId: body.sourceId });
    const existing = runByClient(channel.id, userId, body.clientId);
    if (existing) {
      if (existing.request_hash !== hash) throw conflict("capacity", "That reply id was already used for a different request.");
      return json(c, { run: runState(existing.id), message: messageById(channel.id, existing.message_id, userId) });
    }
    const binding = storedBinding(channel.ai_json);
    if (!binding) throw conflict("binding_unavailable", "This room has no AI binding. Ask the owner to choose one.");
    const source = db.prepare("SELECT id, seq, kind, author_id, body, thread_root, deleted_at FROM channel_messages WHERE channel_id = ? AND id = ?").get(channel.id, body.sourceId) as
      | { id: string; seq: number; kind: "human" | "ai"; author_id: string | null; body: string; thread_root: string | null; deleted_at: number | null }
      | undefined;
    if (!source || source.deleted_at !== null) throw notFound();
    if (source.kind !== "human") throw invalid("Only a human message can be answered.", "source_busy");
    if (source.thread_root !== null) {
      throw new AppError({ code: "validation", status: 422, message: "Assistant replies are not available in threads.", details: { reason: "thread_ai" } });
    }
    if (!source.body.trim()) {
      throw new AppError({ code: "validation", status: 422, message: "Add a line of text before asking the assistant.", details: { reason: "attachments_only" } });
    }
    if (db.prepare("SELECT 1 FROM channel_ai_runs WHERE channel_id = ? AND state IN ('queued','running')").get(channel.id)) throw conflict("ai_busy", "A reply is already running in this room.");
    if (db.prepare("SELECT 1 FROM channel_ai_runs WHERE requester_id = ? AND state IN ('queued','running')").get(userId)) throw conflict("ai_busy", "You already have a room reply running.");
    if (channelQueueDepth() >= CHANNEL_LIMITS.aiQueue) throw new AppError({ code: "rate_limited", status: 429, message: "The room AI queue is full.", retryAfterMs: 5_000 });
    const resolved = await resolveModel(userId, binding.modelRef);
    const snapshot = trimSnapshot(buildSnapshot(channel, source.id, userId));
    const prepared = prepareChannelPrompt({
      userId,
      modelRef: binding.modelRef,
      channel,
      binding,
      snapshot,
      modelContext: resolved.model.context,
      modelMaxOutput: resolved.model.maxOutput,
    });
    const configJson = JSON.stringify({ version: 1, binding, injectionFlagged: prepared.injectionFlagged });
    const inputEnc = encrypt(JSON.stringify({ v: 1, snapshot }));
    const reserved = Buffer.byteLength(configJson) + Buffer.byteLength(inputEnc) + 1024 + 64 * 1024;
    assertStorage(channel.owner_id, reserved);
    const created = createRunAfterChecks(userId, channel, source, body.clientId, hash, binding.modelRef, configJson, inputEnc, reserved);
    enqueueChannelRun(created.runId);
    return json(c, { run: runState(created.runId), message: messageById(channel.id, created.messageId, userId) }, 202);
  })
  .get("/:id/ai-runs/:runId", (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelMember(userId, c.req.param("id"));
    const run = runRow(c.req.param("runId"));
    if (!run || run.channel_id !== channel.id) throw notFound();
    return json(c, { run: runState(run.id) });
  })
  .post("/:id/ai-runs/:runId/cancel", (c) => {
    const userId = c.get("user").id;
    const { channel, member } = assertChannelMember(userId, c.req.param("id"));
    const run = runRow(c.req.param("runId"));
    if (!run || run.channel_id !== channel.id) throw notFound();
    const allowed = run.requester_id === userId || member.role === "owner" || member.role === "moderator";
    if (!allowed) throw new AppError({ code: "forbidden", message: "Only the requester or a moderator can stop this reply." });
    cancelChannelRun(run.id);
    return json(c, { run: runState(run.id) });
  });

function messageById(channelId: string, messageId: string, userId: string) {
  const row = db.prepare("SELECT * FROM channel_messages WHERE channel_id = ? AND id = ?").get(channelId, messageId) as ChannelMessageRow | undefined;
  return row ? projectMessages([row], userId)[0] : null;
}

function createRunAfterChecks(
  userId: string,
  channel: NonNullable<ReturnType<typeof channelRow>>,
  source: { id: string; seq: number },
  clientId: string,
  hash: string,
  modelRef: string,
  configJson: string,
  inputEnc: string,
  reserved: number,
): { runId: string; messageId: string } {
  return tx(() => {
    chargeRate(userId, "write");
    chargeRate(userId, "ai");
    return createRunInTx(userId, channel, { messageId: source.id, seq: source.seq }, {
      clientId,
      requestHash: hash,
      modelRef,
      configJson,
      inputEnc,
      reservedBytes: reserved,
    });
  });
}

export const channelAdminRoutes = new Hono<AppEnv>()
  .use("*", requireUser)
  .use("*", requireAdmin)
  .use("*", bodyLimit({ maxSize: CHANNEL_LIMITS.aiRequestBytes, onError: (c) => c.json({ error: "That request is too large." }, 413) }))
  .get("/", (c) => {
    const before = parseListCursor(c.req.query("before"));
    const limit = pageLimit(c.req.query("limit"), 50, 50);
    const rows = db
      .prepare(
        `SELECT c.*, u.name AS owner_name, u.email AS owner_email,
           (SELECT COUNT(*) FROM channel_members m WHERE m.channel_id = c.id) AS member_count,
           (SELECT COUNT(*) FROM channel_messages x WHERE x.channel_id = c.id AND x.deleted_at IS NULL) AS message_count
         FROM channels c LEFT JOIN users u ON u.id = c.owner_id
         ${before ? "WHERE c.kind = 'room' AND (c.updated_at < ? OR (c.updated_at = ? AND c.id > ?))" : "WHERE c.kind = 'room'"}
         ORDER BY c.updated_at DESC, c.id ASC LIMIT ?`,
      )
      .all(...[...(before ? [before.updatedAt, before.updatedAt, before.id] : []), limit + 1]) as Array<Record<string, unknown>>;
    const page = rows.slice(0, limit);
    return json(c, {
      items: page.map((row) => ({
        id: row.id,
        name: row.name,
        visibility: row.visibility,
        archivedAt: row.archived_at,
        ownerId: row.owner_id,
        ownerName: row.owner_name,
        memberCount: row.member_count,
        messageCount: row.message_count,
        revision: row.revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      nextCursor: rows.length > limit && page.length ? listCursor(page.at(-1) as never) : null,
    });
  })
  .get("/:id/messages", (c) => {
    const channel = channelRow(c.req.param("id"));
    if (!channel || channel.kind === "dm") throw notFound();
    const reasonRaw = c.req.query("reason") ?? "";
    const reason = requireReason(reasonRaw);
    audit(c.get("user").id, channel.id, "inspect", null, reason);
    return json(c, channelHistory(channel.id, c.get("user").id, historyQuery(c)));
  })
  .patch("/:id", async (c) => {
    const channel = channelRow(c.req.param("id"));
    if (!channel || channel.kind === "dm") throw notFound();
    const body = parse(adminPatchSchema, await readBody(c, CHANNEL_LIMITS.aiRequestBytes));
    const reason = requireReason(body.reason);
    const aiJson = await nextAiJson(c.get("user").id, body.ai, channel.ai_json);
    assertLiveAdmin(c.get("user").id);
    const updated = updateChannel(
      c.get("user").id,
      channel.id,
      {
        revision: body.revision,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.icon !== undefined ? { icon: body.icon } : {}),
        ...(body.groupIds !== undefined ? { groupIds: body.groupIds } : {}),
        aiJson,
      },
      { admin: true },
    );
    audit(c.get("user").id, channel.id, "update", null, reason);
    return json(c, { channel: updated });
  })
  .delete("/:id", async (c) => {
    assertLiveAdmin(c.get("user").id);
    const channel = channelRow(c.req.param("id"));
    if (!channel || channel.kind === "dm") throw notFound();
    const body = parse(adminDeleteSchema, await readBody(c, CHANNEL_LIMITS.requestBytes));
    tx(() => {
      const reason = requireReason(body.reason);
      assertRoomRevision(c.req.param("id"), body.revision);
      settleRunsForDeletion(c.req.param("id"));
      deleteChannel(c.get("user").id, c.req.param("id"), body.revision, reason);
    });
    return json(c, { ok: true });
  })
  .post("/:id/moderate", async (c) => {
    const userId = c.get("user").id;
    assertLiveAdmin(userId);
    const channel = channelRow(c.req.param("id"));
    if (!channel || channel.kind === "dm") throw notFound();
    const body = parse(adminModerateSchema, await readBody(c, CHANNEL_LIMITS.requestBytes));
    const reason = requireReason(body.reason);
    const target = body.targetId;
    switch (body.action) {
      case "removeMember":
        if (!target) throw invalid("Choose a member.");
        removeMember(userId, channel.id, target);
        break;
      case "setRole":
        if (!target || !body.role) throw invalid("Choose a member and role.");
        setMemberRole(userId, channel.id, body.revision, target, body.role);
        break;
      case "archive":
        archiveChannel(userId, channel.id, body.revision, body.archived ?? true);
        if (body.archived ?? true) abortChannelRuns(channel.id);
        break;
      case "transfer":
        if (!target) throw invalid("Choose a member.");
        transferOwner(userId, channel.id, body.revision, target);
        break;
      case "deleteMessage":
        if (!target) throw invalid("Choose a message.");
        deleteHumanMessage(userId, channel.id, target, body.revision, { moderator: true, reason });
        cancelRunsForSource(channel.id, target);
        break;
      case "unblock":
        if (!target) throw invalid("Choose an account.");
        unblockMember(userId, channel.id, target);
        break;
    }
    audit(userId, channel.id, body.action, target ?? null, reason);
    return json(c, { ok: true });
  });

function assertLiveAdmin(userId: string): void {
  if (accountRole(userId) !== "admin") throw new AppError({ code: "forbidden", message: "Administrator access is required." });
}

function assertRoomRevision(id: string, revision: number): void {
  const channel = channelRow(id);
  if (!channel) throw notFound();
  if (channel.revision !== revision) throw conflict("revision", "This room changed. Reload and try again.");
}

function requireReason(raw: string | undefined): string {
  const reason = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!reason || [...reason].length > CHANNEL_LIMITS.reasonChars) throw invalid("A reason of up to 500 characters is required.");
  return reason;
}
