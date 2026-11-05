import {
  N8N_LIMITS,
  N8N_REF_PREFIX,
  type AgentUsageCounters,
  type N8nAgentConfig,
  type N8nAgentDetail,
  type N8nAgentSummary,
  type N8nAgentTarget,
} from "../../shared/n8n-agents.js";
import type { ShareAudience } from "../../shared/types.js";
import { decrypt, encrypt, newId } from "../crypto.js";
import { afterCommit, db, tx } from "../db.js";
import { AppError } from "../errors.js";
import { audienceIncludes, clearAudience, getAudience, setAudience } from "../groups.js";
import { assertStorage } from "../quota.js";
import { fullConfig, nextAuthHeader, validateAgentInput, type AgentInputBody } from "./schemas.js";
import { clearAgentStatus } from "./status.js";

// Encrypted n8n agent definitions (docs/implementation/n8n-agents.md). The whole config, URL included, is
// one AES-GCM blob: a webhook path or query can itself be the credential. Only management detail for the
// owner (or an admin, for shared rows) and the moment before sending ever decrypt it.

interface AgentRow {
  id: string;
  owner_id: string;
  shared: number;
  name: string;
  description: string;
  avatar: string;
  enabled: number;
  config_enc: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

/** Server-only view of an agent the viewer may chat with, read fresh from storage. */
export interface ResolvedAgent {
  id: string;
  ownerId: string;
  revision: number;
  name: string;
  shared: boolean;
  enabled: boolean;
  config: N8nAgentConfig;
}

/** own: the caller's private definitions. shared: admin management of server-wide definitions. */
export type AgentScope = { kind: "own"; userId: string } | { kind: "shared"; adminId: string };

const RUN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const agentRef = (id: string) => `${N8N_REF_PREFIX}${id}`;
export const agentIdOfRef = (ref: string): string | null => {
  if (!ref.startsWith(N8N_REF_PREFIX)) return null;
  const id = ref.slice(N8N_REF_PREFIX.length);
  return /^agt_[A-Za-z0-9_-]{8,40}$/.test(id) ? id : null;
};

const notFound = () => new AppError({ code: "not_found", message: "That agent was not found." });
const conflict = () => new AppError({ code: "conflict", message: "This agent was changed elsewhere. Reload it and try again." });

function readConfig(row: Pick<AgentRow, "config_enc">): N8nAgentConfig {
  try {
    return JSON.parse(decrypt(row.config_enc)) as N8nAgentConfig;
  } catch {
    // A wrong OKAYCHAT_SECRET or a tampered row: refuse without echoing anything from the ciphertext.
    throw new AppError({ code: "unknown", message: "This agent's settings could not be decrypted. Edit and save it again." });
  }
}

const isAdmin = (userId: string) =>
  (db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | undefined)?.role === "admin";

const visible = () => `((a.shared = 0 AND a.owner_id = ?) OR (a.shared = 1 AND ${audienceIncludes("n8n", "a.id")}))`;

function summary(row: AgentRow, canManage: boolean): N8nAgentSummary {
  const config = readConfig(row);
  return {
    id: row.id,
    ref: agentRef(row.id),
    name: row.name,
    description: row.description,
    avatar: row.avatar,
    enabled: row.enabled === 1,
    shared: row.shared === 1,
    canManage,
    memoryMode: config.memoryMode,
    protocol: config.protocol,
    revision: row.revision,
  };
}

function detail(row: AgentRow, canManage: boolean): N8nAgentDetail {
  const { authHeader, ...config } = readConfig(row);
  return {
    ...summary(row, canManage),
    config,
    authHeader: authHeader ? { name: authHeader.name, configured: true } : null,
    ...(row.shared === 1 ? { audience: getAudience("n8n", row.id) } : {}),
  };
}

/** Own definitions plus shared ones whose audience includes the viewer, disabled ones too (management list). */
export function listVisibleAgents(viewerId: string): N8nAgentSummary[] {
  const admin = isAdmin(viewerId);
  const rows = db.prepare(`SELECT a.* FROM n8n_agents a WHERE ${visible()} ORDER BY a.shared, a.name COLLATE NOCASE, a.id`).all(viewerId, viewerId, viewerId) as unknown as AgentRow[];
  return rows.map((row) => summary(row, row.shared === 1 ? admin : true));
}

export function listOwnedAgents(userId: string): N8nAgentSummary[] {
  const rows = db.prepare("SELECT * FROM n8n_agents WHERE owner_id = ? AND shared = 0 ORDER BY name COLLATE NOCASE, id").all(userId) as unknown as AgentRow[];
  return rows.map((row) => summary(row, true));
}

export function listSharedAgentsForAdmin(): N8nAgentSummary[] {
  const rows = db.prepare("SELECT * FROM n8n_agents WHERE shared = 1 ORDER BY name COLLATE NOCASE, id").all() as unknown as AgentRow[];
  return rows.map((row) => summary(row, true));
}

/** Enabled visible agents as chat targets. Built from row metadata, never from a client copy. */
export function listAgentTargets(viewerId: string): N8nAgentTarget[] {
  return listVisibleAgents(viewerId)
    .filter((agent) => agent.enabled)
    .map((agent) => ({
      kind: "agent",
      ref: agent.ref,
      providerId: "n8n",
      id: agent.id,
      name: agent.name,
      description: agent.description,
      avatar: agent.avatar,
      shared: agent.shared,
      memoryMode: agent.memoryMode,
      reasoning: false,
      toolCall: false,
      attachments: false,
      inputModalities: ["text"],
      temperature: false,
      free: false,
      context: 0,
      maxOutput: 0,
    }));
}

function managedRow(scope: AgentScope, id: string): AgentRow {
  if (scope.kind === "shared" && !isAdmin(scope.adminId)) throw new AppError({ code: "forbidden" });
  const row = (scope.kind === "own"
    ? db.prepare("SELECT * FROM n8n_agents WHERE id = ? AND owner_id = ? AND shared = 0").get(id, scope.userId)
    : db.prepare("SELECT * FROM n8n_agents WHERE id = ? AND shared = 1").get(id)) as unknown as AgentRow | undefined;
  // A shared recipient, another user's private row, or a missing row all look the same.
  if (!row) throw notFound();
  return row;
}

export function getAgentDetail(scope: AgentScope, id: string): N8nAgentDetail {
  return detail(managedRow(scope, id), true);
}

/** The stored config of a definition the scope manages, for unsaved test overlays. */
export function managedConfig(scope: AgentScope, id: string, revision: number): { config: N8nAgentConfig; name: string } {
  const row = managedRow(scope, id);
  if (row.revision !== revision) throw conflict();
  return { config: readConfig(row), name: row.name };
}

/** Fresh, permission-checked agent for one send. Disabled agents are visible but refuse to run. */
export function resolveAgent(viewerId: string, id: string): ResolvedAgent | null {
  const row = db.prepare(`SELECT a.* FROM n8n_agents a WHERE a.id = ? AND ${visible()}`).get(id, viewerId, viewerId, viewerId) as unknown as AgentRow | undefined;
  if (!row) return null;
  return { id: row.id, ownerId: row.owner_id, revision: row.revision, name: row.name, shared: row.shared === 1, enabled: row.enabled === 1, config: readConfig(row) };
}

/** Cheap access recheck right before a POST, and for revocation sweeps. */
export function agentAccessible(viewerId: string, id: string, revision: number): boolean {
  return !!db.prepare(`SELECT 1 FROM n8n_agents a WHERE a.id = ? AND a.revision = ? AND a.enabled = 1 AND ${visible()}`).get(id, revision, viewerId, viewerId, viewerId);
}

const definitionBytes = (row: Pick<AgentRow, "name" | "description" | "avatar" | "config_enc">) =>
  Buffer.byteLength(row.name) + Buffer.byteLength(row.description) + Buffer.byteLength(row.avatar) + Buffer.byteLength(row.config_enc);

function sealConfig(config: N8nAgentConfig): string {
  const sealed = encrypt(JSON.stringify(config));
  if (Buffer.byteLength(sealed) > N8N_LIMITS.configCipherBytes) {
    throw new AppError({ code: "validation", message: "These agent settings are too large to store." });
  }
  return sealed;
}

export function createAgent(scope: AgentScope, input: AgentInputBody): N8nAgentDetail {
  if (scope.kind === "shared" && !isAdmin(scope.adminId)) throw new AppError({ code: "forbidden" });
  const { name, description } = validateAgentInput(input);
  const ownerId = scope.kind === "own" ? scope.userId : scope.adminId;
  const shared = scope.kind === "shared" ? 1 : 0;
  const config = fullConfig(input.config, nextAuthHeader(null, input.config.webhookUrl, input.authHeader));
  const row = { name, description, avatar: input.avatar, config_enc: sealConfig(config) };
  const id = newId("agt");
  const now = Date.now();
  tx(() => {
    const owned = (db.prepare("SELECT count(*) AS n FROM n8n_agents WHERE owner_id = ?").get(ownerId) as { n: number }).n;
    if (owned >= N8N_LIMITS.ownedPerAccount) throw new AppError({ code: "validation", message: `An account can define at most ${N8N_LIMITS.ownedPerAccount} agents.` });
    if (shared) {
      const total = (db.prepare("SELECT count(*) AS n FROM n8n_agents WHERE shared = 1").get() as { n: number }).n;
      if (total >= N8N_LIMITS.sharedPerServer) throw new AppError({ code: "validation", message: `The server can share at most ${N8N_LIMITS.sharedPerServer} agents.` });
    }
    assertStorage(ownerId, definitionBytes(row));
    db.prepare(
      "INSERT INTO n8n_agents (id, owner_id, shared, name, description, avatar, enabled, config_enc, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
    ).run(id, ownerId, shared, name, description, input.avatar, input.enabled ? 1 : 0, row.config_enc, now, now);
    if (shared && input.audience) setAudience("n8n", id, input.audience as ShareAudience);
  });
  return getAgentDetail(scope, id);
}

export function updateAgent(scope: AgentScope, id: string, revision: number, input: AgentInputBody): N8nAgentDetail {
  const { name, description } = validateAgentInput(input);
  const previous = managedRow(scope, id);
  if (previous.revision !== revision) throw conflict();
  const before = readConfig(previous);
  const config = fullConfig(input.config, nextAuthHeader(before, input.config.webhookUrl, input.authHeader));
  const row = { name, description, avatar: input.avatar, config_enc: sealConfig(config) };
  tx(() => {
    const delta = definitionBytes(row) - definitionBytes(previous);
    if (delta > 0) assertStorage(previous.owner_id, delta);
    const result = db.prepare(
      "UPDATE n8n_agents SET name = ?, description = ?, avatar = ?, enabled = ?, config_enc = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
    ).run(name, description, input.avatar, input.enabled ? 1 : 0, row.config_enc, Date.now(), id, revision);
    if (result.changes !== 1) throw conflict();
    // Every revision forgets remote sessions: a new destination, protocol, or memory mode must not inherit them.
    db.prepare("DELETE FROM n8n_agent_sessions WHERE agent_id = ?").run(id);
    if (previous.shared === 1 && input.audience) setAudience("n8n", id, input.audience as ShareAudience);
  });
  clearAgentStatus(id);
  abortAgentRuns((run) => run.agentId === id);
  return getAgentDetail(scope, id);
}

export function deleteAgent(scope: AgentScope, id: string, revision: number): void {
  const row = managedRow(scope, id);
  if (row.revision !== revision) throw conflict();
  tx(() => {
    const result = db.prepare("DELETE FROM n8n_agents WHERE id = ? AND revision = ?").run(id, revision);
    if (result.changes !== 1) throw conflict();
    // Sessions go by cascade; the audience rows are polymorphic and need an explicit clear.
    clearAudience("n8n", id);
  });
  clearAgentStatus(id);
  abortAgentRuns((run) => run.agentId === id);
}

/** Before deleting a user: their shared agents' audiences have no foreign key to cascade through. */
export function clearOwnedAgentAudiences(ownerId: string): void {
  const ids = db.prepare("SELECT id FROM n8n_agents WHERE owner_id = ? AND shared = 1").all(ownerId) as Array<{ id: string }>;
  for (const { id } of ids) clearAudience("n8n", id);
  abortAgentRuns((run) => run.viewerId === ownerId || ids.some((agent) => agent.id === run.agentId));
}

// Remote sessions: one opaque id per (user, thread, agent), with a digest of the transcript it has seen.

export interface AgentSession {
  sessionId: string;
  historyHash: string;
  revision: number;
}

export function getSession(userId: string, threadId: string, agentId: string): AgentSession | null {
  const row = db.prepare("SELECT session_enc, history_hash, agent_revision FROM n8n_agent_sessions WHERE user_id = ? AND thread_id = ? AND agent_id = ?").get(userId, threadId, agentId) as
    | { session_enc: string; history_hash: string; agent_revision: number }
    | undefined;
  if (!row) return null;
  try {
    return { sessionId: decrypt(row.session_enc), historyHash: row.history_hash, revision: row.agent_revision };
  } catch {
    return null;
  }
}

/** Stores the session for a thread the user owns; quota covers its bytes. Returns false when the thread is gone. */
export function saveSession(userId: string, threadId: string, agentId: string, revision: number, sessionId: string, historyHash: string): boolean {
  const sessionEnc = encrypt(sessionId);
  return tx(() => {
    if (!db.prepare("SELECT 1 FROM threads WHERE id = ? AND user_id = ?").get(threadId, userId)) return false;
    // The agent may have been edited (new revision) while the reply streamed; that edit already reset sessions.
    if (!agentAccessible(userId, agentId, revision)) return false;
    const old = db.prepare("SELECT length(CAST(session_enc AS BLOB)) + length(CAST(history_hash AS BLOB)) AS n FROM n8n_agent_sessions WHERE user_id = ? AND thread_id = ? AND agent_id = ?").get(userId, threadId, agentId) as
      | { n: number }
      | undefined;
    const delta = Buffer.byteLength(sessionEnc) + Buffer.byteLength(historyHash) - (old?.n ?? 0);
    if (delta > 0) assertStorage(userId, delta);
    db.prepare(
      `INSERT INTO n8n_agent_sessions (user_id, thread_id, agent_id, agent_revision, session_enc, history_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, thread_id, agent_id) DO UPDATE SET agent_revision = excluded.agent_revision, session_enc = excluded.session_enc,
         history_hash = excluded.history_hash, updated_at = excluded.updated_at`,
    ).run(userId, threadId, agentId, revision, sessionEnc, historyHash, Date.now());
    return true;
  });
}

export function deleteSession(userId: string, threadId: string, agentId?: string): void {
  if (agentId) db.prepare("DELETE FROM n8n_agent_sessions WHERE user_id = ? AND thread_id = ? AND agent_id = ?").run(userId, threadId, agentId);
  else db.prepare("DELETE FROM n8n_agent_sessions WHERE user_id = ? AND thread_id = ?").run(userId, threadId);
}

// Run counters: no bodies, no URLs, kept 90 days.

export interface AgentRunRecord {
  id: string;
  userId: string;
  threadId: string | null;
  agentId: string;
  status: "ok" | "error" | "aborted";
  durationMs: number;
  inputBytes: number;
  outputBytes: number;
}

export function recordRun(run: AgentRunRecord): void {
  const now = Date.now();
  tx(() => {
    db.prepare("DELETE FROM n8n_agent_runs WHERE user_id = ? AND created_at < ?").run(run.userId, now - RUN_RETENTION_MS);
    // The thread may have been deleted while the request ran; the counter stays without it.
    const threadId = run.threadId && db.prepare("SELECT 1 FROM threads WHERE id = ? AND user_id = ?").get(run.threadId, run.userId) ? run.threadId : null;
    if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(run.userId)) return;
    db.prepare(
      "INSERT OR IGNORE INTO n8n_agent_runs (id, user_id, thread_id, agent_id, status, duration_ms, input_bytes, output_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(run.id, run.userId, threadId, run.agentId, run.status, Math.max(0, Math.round(run.durationMs)), run.inputBytes, run.outputBytes, now);
  });
}

export function agentUsage(userId: string, since = 0): AgentUsageCounters {
  const row = db.prepare(
    `SELECT count(*) AS runs, COALESCE(SUM(status = 'ok'), 0) AS ok, COALESCE(SUM(status = 'error'), 0) AS error,
       COALESCE(SUM(status = 'aborted'), 0) AS aborted, COALESCE(SUM(duration_ms), 0) AS durationMs
     FROM n8n_agent_runs WHERE user_id = ? AND created_at >= ?`,
  ).get(userId, since) as unknown as AgentUsageCounters;
  return { runs: row.runs, ok: row.ok, error: row.error, aborted: row.aborted, durationMs: row.durationMs };
}

export const threadAgentRequests = (userId: string, threadId: string): number =>
  (db.prepare("SELECT count(*) AS n FROM n8n_agent_runs WHERE user_id = ? AND thread_id = ?").get(userId, threadId) as { n: number }).n;

// Active requests, so an edit, deletion, or revoked audience stops a running upload instead of only hiding the agent.

export interface ActiveAgentRun {
  viewerId: string;
  threadId: string | null;
  agentId: string;
  revision: number;
  controller: AbortController;
}

const activeRuns = new Set<ActiveAgentRun>();

/** Registers a run; the returned function unregisters it (call in finally). */
export function registerAgentRun(run: ActiveAgentRun): () => void {
  activeRuns.add(run);
  return () => activeRuns.delete(run);
}

export function abortAgentRuns(match: (run: ActiveAgentRun) => boolean): void {
  for (const run of activeRuns) if (match(run)) run.controller.abort(new AppError({ code: "forbidden", message: "This agent changed or is no longer available to you." }));
}

/** After an audience, group, or role change: stop only the runs whose viewer lost access. */
export function abortRevokedAgentRuns(): void {
  abortAgentRuns((run) => !agentAccessible(run.viewerId, run.agentId, run.revision));
}

export const activeAgentRunCount = () => activeRuns.size;
