import type {
  KnowledgeCollectionView,
  KnowledgeOwnedCollection,
  KnowledgeRetrievalReason,
  KnowledgeSharedCollection,
  KnowledgeSourceSummary,
} from "../../shared/knowledge.js";
import type { ShareAudience } from "../../shared/types.js";
import { db, tx } from "../db.js";
import { featureAllowed } from "../permissions/guard.js";
import { recordRevision } from "../permissions/audit.js";
import { audienceIncludes, getAudience, setAudience, clearAudience } from "../groups.js";
import { requestKnowledgeRevocation } from "./revocation.js";
import {
  deleteCollection,
  embeddingNeedsReindex,
  getCollectionRow,
  ownedViews,
  retrievalCapabilityOf,
  statsFor,
  toOwnedView,
  type CollectionRow,
  type CollectionStats,
} from "./store.js";

// One authority surface for shared knowledge. Every read resolves live rows: the viewer exists, the owner
// exists, both accounts may use knowledge, and the collection is either the viewer's own or published to an
// audience that includes them. No caller can supply a trusted row, and no query narrows by the viewer's id
// for content that belongs to someone else.

const liveUser = (id: string): boolean => !!db.prepare("SELECT 1 FROM users WHERE id = ?").get(id);

/** The published-to-this-viewer SQL condition; bind the viewer id twice. */
const sharedAudience = (alias: string) => `${alias}.visibility = 'shared' AND ${audienceIncludes("knowledge", `${alias}.id`)}`;

export interface CollectionCursor {
  updatedAt: number;
  id: string;
}

export function encodeCursor(cursor: CollectionCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.id]), "utf8").toString("base64url");
}

export function decodeCursor(value: string | undefined | null): CollectionCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [updatedAt, id] = parsed;
    if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < 0) return null;
    if (typeof id !== "string" || !id || id.length > 200) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

const cursorSql = (cursor: CollectionCursor | null): string => (cursor ? " AND (updated_at < ? OR (updated_at = ? AND id > ?))" : "");
const cursorArgs = (cursor: CollectionCursor | null): Array<number | string> => (cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : []);

const projectSql = (project: string | null | undefined): { sql: string; args: Array<string> } => {
  if (project === undefined) return { sql: "", args: [] };
  if (project === null) return { sql: " AND k.project_id IS NULL", args: [] };
  // A chat in a project may use global collections plus its own project's collections.
  return { sql: " AND (k.project_id = ? OR k.project_id IS NULL)", args: [project] };
};

/** SQL already restricts to published rows; this removes owners whose knowledge feature is denied. */
function ownerIdAllowed(ownerId: string, viewerId: string): boolean {
  if (ownerId === viewerId) return true;
  return liveUser(ownerId) && featureAllowed(ownerId, "knowledge");
}

const ownerAllowed = (row: CollectionRow, viewerId: string): boolean => ownerIdAllowed(row.user_id, viewerId);

export function knowledgeAllowed(userId: string): boolean {
  return liveUser(userId) && featureAllowed(userId, "knowledge");
}

/** The viewer may read this collection now: own and allowed, or shared to a live audience. */
export function readableCollectionRow(viewerId: string, id: string): CollectionRow | undefined {
  const row = getCollectionRow(viewerId, id);
  if (row) return knowledgeAllowed(viewerId) ? row : undefined;
  const shared = db
    .prepare(`SELECT k.* FROM knowledge_collections k WHERE k.id = ? AND k.user_id <> ? AND ${sharedAudience("k")}`)
    .get(id, viewerId, viewerId, viewerId) as CollectionRow | undefined;
  if (!shared) return undefined;
  if (!knowledgeAllowed(viewerId) || !liveUser(shared.user_id) || !featureAllowed(shared.user_id, "knowledge")) return undefined;
  return shared;
}

export function readableCollectionRows(viewerId: string, ids: readonly string[]): CollectionRow[] {
  const out: CollectionRow[] = [];
  for (const id of [...new Set(ids)]) {
    const row = readableCollectionRow(viewerId, id);
    if (row) out.push(row);
  }
  return out;
}

/** Readable and legal for this chat: own collections keep their project binding; shared ones are global. */
export function readableCollectionsForChat(viewerId: string, ids: readonly string[], projectId: string | null): CollectionRow[] {
  return readableCollectionRows(viewerId, ids).filter((row) => {
    if (row.user_id !== viewerId) return true;
    return row.project_id === null || row.project_id === projectId;
  });
}

export function readableIdSet(viewerId: string, ids: readonly string[]): Set<string> {
  return new Set(readableCollectionRows(viewerId, ids).map((row) => row.id));
}

/** Every collection the viewer can read now, used to gate a whole page before projection. */
export function readableCollectionIds(viewerId: string): Set<string> {
  if (!knowledgeAllowed(viewerId)) return new Set();
  const rows = db
    .prepare(
      `SELECT k.id, k.user_id FROM knowledge_collections k
       WHERE k.user_id = ? OR (k.user_id <> ? AND ${sharedAudience("k")})`,
    )
    .all(viewerId, viewerId, viewerId, viewerId) as Array<{ id: string; user_id: string }>;
  return new Set(rows.filter((row) => ownerIdAllowed(row.user_id, viewerId)).map((row) => row.id));
}

function displayNames(ids: readonly string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!ids.length) return out;
  const rows = db.prepare(`SELECT id, name FROM users WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ id: string; name: string }>;
  for (const row of rows) out.set(row.id, row.name?.trim() || null);
  return out;
}

export function toSharedView(row: CollectionRow, stats: CollectionStats | undefined, ownerName: string | null): KnowledgeSharedCollection {
  const s = stats ?? { source_count: 0, chunk_count: 0, bytes: 0, processing: 0, failed: 0 };
  const reason: KnowledgeRetrievalReason = row.embedding_provider === "none" ? "not_configured" : "shared_lexical";
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    // Reader status is coarse on purpose: detailed failures stay with the owner.
    status: s.processing > 0 ? "processing" : s.source_count === 0 ? "empty" : s.chunk_count > 0 ? "ready" : s.failed > 0 ? "failed" : "empty",
    sourceCount: s.source_count,
    chunkCount: s.chunk_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    access: "reader",
    visibility: "shared",
    owner: { id: row.user_id, displayName: ownerName },
    retrieval: { mode: "lexical", reason },
  };
}

export interface CollectionPage {
  collections: KnowledgeCollectionView[];
  nextCursor: string | null;
}

function projectPage(viewerId: string, rows: CollectionRow[], hasMore: boolean, limit: number, lastFetched: CollectionRow | undefined): CollectionPage {
  const names = displayNames([...new Set(rows.filter((row) => row.user_id !== viewerId).map((row) => row.user_id))]);
  const owned = rows.filter((row) => row.user_id === viewerId);
  const shared = rows.filter((row) => row.user_id !== viewerId);
  const ownedRows = ownedViews(viewerId, owned);
  const sharedStats = new Map<string, CollectionStats>();
  for (const row of shared) {
    // Stats are computed with the owner's id because that is the payer column on sources and chunks.
    const stats = statsFor(row.user_id, [row]).get(row.id);
    if (stats) sharedStats.set(row.id, stats);
  }
  const byId = new Map<string, KnowledgeCollectionView>();
  for (const view of ownedRows) byId.set(view.id, view);
  for (const row of shared) byId.set(row.id, toSharedView(row, sharedStats.get(row.id), names.get(row.user_id) ?? null));
  return {
    collections: [...byId.values()].slice(0, limit),
    // The cursor follows the last fetched row, even when a feature check hid it, so pages never repeat.
    nextCursor: hasMore && lastFetched ? encodeCursor({ updatedAt: lastFetched.updated_at, id: lastFetched.id }) : null,
  };
}

/** Cursor uses the last fetched row even when it was hidden by a feature check, so pages cannot repeat. */
function filterOwners(viewerId: string, rows: CollectionRow[]): CollectionRow[] {
  return rows.filter((row) => ownerAllowed(row, viewerId) && (row.user_id === viewerId ? knowledgeAllowed(viewerId) : true));
}

export function listOwnedPage(viewerId: string, project: string | null | undefined, limit: number, cursor: CollectionCursor | null): CollectionPage {
  // Own metadata stays listable while the feature is denied, so the owner can still reach cleanup controls.
  const projectFilter = projectSql(project);
  const rows = db
    .prepare(
      `SELECT k.* FROM knowledge_collections k WHERE k.user_id = ?${projectFilter.sql}${cursorSql(cursor)}
       ORDER BY k.updated_at DESC, k.id ASC LIMIT ?`,
    )
    .all(viewerId, ...projectFilter.args, ...cursorArgs(cursor), limit + 1) as unknown as CollectionRow[];
  const page = rows.slice(0, limit);
  return projectPage(viewerId, page, rows.length > limit, limit, page.at(-1));
}

export function listSharedPage(viewerId: string, limit: number, cursor: CollectionCursor | null): CollectionPage {
  if (!knowledgeAllowed(viewerId)) return { collections: [], nextCursor: null };
  const rows = db
    .prepare(
      `SELECT k.* FROM knowledge_collections k
       WHERE k.user_id <> ? AND ${sharedAudience("k")}${cursorSql(cursor)}
       ORDER BY k.updated_at DESC, k.id ASC LIMIT ?`,
    )
    .all(viewerId, viewerId, viewerId, ...cursorArgs(cursor), limit + 1) as unknown as CollectionRow[];
  const fetched = rows.slice(0, limit);
  return projectPage(viewerId, filterOwners(viewerId, fetched), rows.length > limit, limit, fetched.at(-1));
}

/** Own collections legal for this project, plus every readable shared collection. */
export function listAttachablePage(viewerId: string, project: string | null, limit: number, cursor: CollectionCursor | null): CollectionPage {
  if (!knowledgeAllowed(viewerId)) return { collections: [], nextCursor: null };
  const projectFilter = projectSql(project);
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT k.* FROM knowledge_collections k WHERE k.user_id = ?${projectFilter.sql}
         UNION ALL
         SELECT k.* FROM knowledge_collections k WHERE k.user_id <> ? AND ${sharedAudience("k")}
       ) ${cursor ? "WHERE (updated_at < ? OR (updated_at = ? AND id > ?))" : ""}
       ORDER BY updated_at DESC, id ASC LIMIT ?`,
    )
    .all(viewerId, ...projectFilter.args, viewerId, viewerId, viewerId, ...cursorArgs(cursor), limit + 1) as unknown as CollectionRow[];
  const fetched = rows.slice(0, limit);
  return projectPage(viewerId, filterOwners(viewerId, fetched), rows.length > limit, limit, fetched.at(-1));
}

/** Detail with a discriminant: owner rows keep the full source contract, readers get safe summaries. */
export function collectionDetail(viewerId: string, id: string):
  | { access: "owner"; collection: KnowledgeOwnedCollection; row: CollectionRow }
  | { access: "reader"; collection: KnowledgeSharedCollection; row: CollectionRow }
  | null {
  // Own metadata is reachable even while the feature is denied (cleanup), but never reader content.
  const own = getCollectionRow(viewerId, id);
  if (own) {
    const stats = statsFor(viewerId, [own]).get(own.id);
    return {
      access: "owner",
      collection: toOwnedView(own, stats, own.visibility === "shared" ? getAudience("knowledge", id) : null),
      row: own,
    };
  }
  const row = readableCollectionRow(viewerId, id);
  if (!row) return null;
  const stats = statsFor(row.user_id, [row]).get(row.id);
  const name = displayNames([row.user_id]).get(row.user_id) ?? null;
  return { access: "reader", collection: toSharedView(row, stats, name), row };
}

/** Own row for a mutation, without the reader fallback. Routes use this after a read-authority check. */
export function ownedRow(userId: string, id: string): CollectionRow | undefined {
  return getCollectionRow(userId, id);
}

export function collectionSharingState(userId: string, id: string): { visibility: "private" | "shared"; audience: ShareAudience; revision: number } | null {
  const row = getCollectionRow(userId, id);
  if (!row) return null;
  return {
    visibility: row.visibility,
    audience: row.visibility === "shared" ? getAudience("knowledge", id) : { mode: "all", userIds: [], groupIds: [] },
    revision: row.access_revision,
  };
}

const AUDIENCE_CAP = 200;
const ID_MAX = 200;

function normalizeAudience(audience: ShareAudience): ShareAudience | null {
  if (audience.mode === "all") return { mode: "all", userIds: [], groupIds: [] };
  const userIds = [...new Set(audience.userIds)];
  const groupIds = [...new Set(audience.groupIds)];
  if (userIds.length > AUDIENCE_CAP || groupIds.length > AUDIENCE_CAP) return null;
  if ([...userIds, ...groupIds].some((id) => !id || id.length > ID_MAX)) return null;
  for (const userId of userIds) if (!liveUser(userId)) return null;
  for (const groupId of groupIds) if (!db.prepare("SELECT 1 FROM user_groups WHERE id = ?").get(groupId)) return null;
  return { mode: "selected", userIds, groupIds };
}

export interface SharingInput {
  visibility: "private" | "shared";
  audience?: ShareAudience;
  expectedRevision: number;
}

export class KnowledgeConflictError extends Error {}

/**
 * Compare-and-set publication. Returns null for a missing/foreign collection (404 at the boundary), throws
 * `KnowledgeConflictError` for a stale revision, an invalid audience, or a project-bound collection. The
 * revision + audience + audit row commit together, and the audience change invalidates live readers after
 * the commit only.
 */
export function setCollectionSharing(userId: string, id: string, input: SharingInput): { visibility: "private" | "shared"; audience: ShareAudience; revision: number } | null {
  const row = getCollectionRow(userId, id);
  if (!row) return null;
  if (row.project_id !== null && input.visibility === "shared") throw new KnowledgeConflictError("project_bound");
  if (input.expectedRevision !== row.access_revision) throw new KnowledgeConflictError("conflict");
  const audience = input.visibility === "shared" ? normalizeAudience(input.audience ?? { mode: "all", userIds: [], groupIds: [] }) : { mode: "all" as const, userIds: [], groupIds: [] };
  if (!audience) throw new KnowledgeConflictError("invalid_audience");
  const before: { visibility: "private" | "shared"; audience: ShareAudience; revision: number } = {
    visibility: row.visibility,
    audience: row.visibility === "shared" ? getAudience("knowledge", id) : { mode: "all", userIds: [], groupIds: [] },
    revision: row.access_revision,
  };
  const same = before.visibility === input.visibility
    && (input.visibility === "private" || (before.audience.mode === audience.mode
      && [...before.audience.userIds].sort().join(",") === [...audience.userIds].sort().join(",")
      && [...before.audience.groupIds].sort().join(",") === [...audience.groupIds].sort().join(",")));
  if (same) return { visibility: row.visibility, audience: before.audience, revision: row.access_revision };
  const nextRevision = row.access_revision + 1;
  tx(() => {
    db.prepare("UPDATE knowledge_collections SET visibility = ?, access_revision = ?, updated_at = ? WHERE user_id = ? AND id = ? AND access_revision = ?")
      .run(input.visibility, nextRevision, Date.now(), userId, id, row.access_revision);
    if (input.visibility === "private") clearAudience("knowledge", id);
    else setAudience("knowledge", id, audience);
    recordRevision("audience", userId, [{
      destination: `knowledge:${id}:sharing`,
      before,
      after: { visibility: input.visibility, audience: input.visibility === "private" ? null : audience, revision: nextRevision },
    }], { resource: "knowledge", collectionId: id });
  });
  requestKnowledgeRevocation();
  return {
    visibility: input.visibility,
    audience: input.visibility === "private" ? { mode: "all", userIds: [], groupIds: [] } : audience,
    revision: nextRevision,
  };
}

/**
 * The sharing dialog's minimal directory. Ordinary accounts discover their own groups, people who share a
 * group with them, and themselves. Admins may select from every live account and group. No email, member
 * count, or foreign group ever appears; an exact known account id is allowed within that same scope.
 */
export function audienceTargets(
  viewerId: string,
  options: { kind: "users" | "groups"; q?: string; userId?: string; cursor?: CollectionCursor | null; limit: number },
): { items: Array<{ id: string; label: string }>; nextCursor: string | null } {
  const admin = (db.prepare("SELECT role FROM users WHERE id = ?").get(viewerId) as { role?: string } | undefined)?.role === "admin";
  const q = (options.q ?? "").trim().toLowerCase().slice(0, 80);
  if (options.kind === "groups") {
    const rows = db
      .prepare(
        `SELECT g.id, g.name FROM user_groups g
         WHERE ${admin ? "1 = 1" : "EXISTS (SELECT 1 FROM user_group_members m WHERE m.group_id = g.id AND m.user_id = ?)"}
           AND (? = '' OR instr(lower(g.name), ?) > 0)
         ORDER BY g.name COLLATE NOCASE, g.id LIMIT ?`,
      )
      .all(...(admin ? [] : [viewerId]), q, q, options.limit + 1) as Array<{ id: string; name: string }>;
    return {
      items: rows.slice(0, options.limit).map((row) => ({ id: row.id, label: row.name })),
      nextCursor: null,
    };
  }
  const scope = admin
    ? "1 = 1"
    : `(u.id = ? OR EXISTS (SELECT 1 FROM user_group_members m JOIN user_group_members mine ON mine.group_id = m.group_id AND mine.user_id = ?
        WHERE m.user_id = u.id))`;
  const scopeArgs = admin ? [] : [viewerId, viewerId];
  if (options.userId) {
    const row = db.prepare(`SELECT u.id, u.name FROM users u WHERE u.id = ? AND ${scope}`).get(options.userId, ...scopeArgs) as { id: string; name: string } | undefined;
    return { items: row ? [{ id: row.id, label: row.name }] : [], nextCursor: null };
  }
  const rows = db
    .prepare(`SELECT u.id, u.name FROM users u WHERE ${scope} AND (? = '' OR instr(lower(u.name), ?) > 0) ORDER BY u.name COLLATE NOCASE, u.id LIMIT ?`)
    .all(...scopeArgs, q, q, options.limit + 1) as Array<{ id: string; name: string }>;
  return { items: rows.slice(0, options.limit).map((row) => ({ id: row.id, label: row.name })), nextCursor: null };
}

/** Collection ids in dependent chats whose audience/feature state changed, for the admin cleanup view. */
export function sharedCollectionMetadata(ownerId: string | null, limit: number, cursor: CollectionCursor | null): { items: Array<Record<string, number | string>>; nextCursor: string | null } {
  const rows = db
    .prepare(
      `SELECT k.id, k.user_id, k.visibility, k.status, k.access_revision, k.updated_at,
         (SELECT COUNT(*) FROM knowledge_sources s WHERE s.collection_id = k.id AND s.user_id = k.user_id) AS source_count,
         (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.collection_id = k.id AND c.user_id = k.user_id) AS chunk_count,
         (SELECT COALESCE(SUM(s.bytes + s.text_bytes), 0) FROM knowledge_sources s WHERE s.collection_id = k.id AND s.user_id = k.user_id)
           + (SELECT COALESCE(SUM(length(CAST(c.text AS BLOB)) + COALESCE(length(c.embedding), 0)), 0) FROM knowledge_chunks c WHERE c.collection_id = k.id AND c.user_id = k.user_id) AS bytes
       FROM knowledge_collections k
       WHERE k.visibility = 'shared'${ownerId ? " AND k.user_id = ?" : ""}${cursor ? " AND (k.updated_at < ? OR (k.updated_at = ? AND k.id > ?))" : ""}
       ORDER BY k.updated_at DESC, k.id ASC LIMIT ?`,
    )
    .all(...(ownerId ? [ownerId] : []), ...cursorArgs(cursor), limit + 1) as Array<{
      id: string; user_id: string; visibility: string; status: string; access_revision: number; updated_at: number; source_count: number; chunk_count: number; bytes: number;
    }>;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id,
      ownerId: row.user_id,
      visibility: row.visibility,
      status: row.status,
      sourceCount: row.source_count,
      chunkCount: row.chunk_count,
      bytes: row.bytes,
      accessRevision: row.access_revision,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor({ updatedAt: last.updated_at, id: last.id }) : null,
  };
}

/** Safe source rows for a readable collection; the caller has already resolved the collection. */
export function readableSourceSummaries(collection: CollectionRow): KnowledgeSourceSummary[] {
  const rows = db
    .prepare(
      `SELECT id, collection_id, name, kind, status, chunk_count, created_at, updated_at
       FROM knowledge_sources WHERE user_id = ? AND collection_id = ? ORDER BY created_at, id`,
    )
    .all(collection.user_id, collection.id) as Array<{
      id: string; collection_id: string; name: string; kind: KnowledgeSourceSummary["kind"]; status: KnowledgeSourceSummary["status"];
      chunk_count: number; created_at: number; updated_at: number;
    }>;
  return rows.map((row) => ({
    id: row.id,
    collectionId: row.collection_id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export interface PassageRow {
  id: string;
  source_id: string;
  collection_id: string;
  ordinal: number;
  title: string;
  start: number;
  end: number;
  text: string;
  tokens: number;
  source_name: string;
  source_kind: "file" | "paste" | "url";
  source_url: string | null;
  collection_name: string;
  project_id: string | null;
}

/**
 * Citation lookup: chunk → source → collection with matching owner columns, then the live readable check.
 * A forged, deleted, or revoked id is indistinguishable from a missing one.
 */
export function readablePassage(viewerId: string, chunkId: string): PassageRow | undefined {
  const row = db
    .prepare(
      `SELECT c.id, c.source_id, c.collection_id, c.ordinal, c.title, c.start, c."end", c.text, c.tokens,
        s.name AS source_name, s.kind AS source_kind, s.url AS source_url,
        k.name AS collection_name, k.project_id
       FROM knowledge_chunks c
       JOIN knowledge_sources s ON s.id = c.source_id AND s.user_id = c.user_id
       JOIN knowledge_collections k ON k.id = c.collection_id AND k.user_id = c.user_id
       WHERE c.id = ?`,
    )
    .get(chunkId) as PassageRow | undefined;
  if (!row) return undefined;
  return readableCollectionRow(viewerId, row.collection_id) ? row : undefined;
}

/** Bounded passage previews inside one readable collection, optionally narrowed to a source of that collection. */
export function readableChunkRows(collection: CollectionRow, sourceId: string | null, limit: number): Array<{
  id: string; source_id: string; ordinal: number; title: string; start: number; end: number; text: string; tokens: number; source_name: string;
}> {
  const rows = db
    .prepare(
      `SELECT c.id, c.source_id, c.ordinal, c.title, c.start, c."end", c.text, c.tokens, s.name AS source_name
       FROM knowledge_chunks c JOIN knowledge_sources s ON s.id = c.source_id AND s.user_id = c.user_id
       WHERE c.user_id = ? AND c.collection_id = ?${sourceId ? " AND c.source_id = ?" : ""}
       ORDER BY s.created_at, c.ordinal LIMIT ?`,
    )
    .all(...(sourceId ? [collection.user_id, collection.id, sourceId, limit] : [collection.user_id, collection.id, limit])) as Array<{
      id: string; source_id: string; ordinal: number; title: string; start: number; end: number; text: string; tokens: number; source_name: string;
    }>;
  return rows;
}

/** Source passages by id, but only when the source belongs to a readable collection. */
export function readableSourceChunks(viewerId: string, sourceId: string): Array<{ id: string; source_id: string; ordinal: number; title: string; start: number; end: number; text: string; tokens: number }> | null {
  const source = db.prepare("SELECT collection_id FROM knowledge_sources WHERE id = ?").get(sourceId) as { collection_id: string } | undefined;
  if (!source) return null;
  const collection = readableCollectionRow(viewerId, source.collection_id);
  if (!collection) return null;
  return db
    .prepare(`SELECT id, source_id, ordinal, title, start, "end", text, tokens FROM knowledge_chunks WHERE user_id = ? AND source_id = ? ORDER BY ordinal LIMIT 100`)
    .all(collection.user_id, sourceId) as Array<{ id: string; source_id: string; ordinal: number; title: string; start: number; end: number; text: string; tokens: number }>;
}

/** Owner-only delete used by the admin metadata cleanup route; refuses private/unknown rows. */
export function adminDeleteShared(collectionId: string, actorId: string, reason: string): boolean {
  const row = db.prepare("SELECT * FROM knowledge_collections WHERE id = ? AND visibility = 'shared'").get(collectionId) as CollectionRow | undefined;
  if (!row) return false;
  tx(() => {
    recordRevision("subject_delete", actorId, [{
      destination: `knowledge:${collectionId}:delete`,
      before: { ownerId: row.user_id, visibility: row.visibility, accessRevision: row.access_revision },
      after: null,
    }], { resource: "knowledge", collectionId, reason: reason.slice(0, 500) });
    deleteCollection(row.user_id, collectionId);
  });
  requestKnowledgeRevocation();
  return true;
}

export { embeddingNeedsReindex, retrievalCapabilityOf };
