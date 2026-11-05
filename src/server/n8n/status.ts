import type { ErrorCode } from "../../shared/errors.js";
import type { N8nAgentStatus } from "../../shared/n8n-agents.js";

// Last-response evidence per (viewer, agent, revision). Nothing probes a webhook: a GET proves nothing about
// a workflow and a POST can run it, so only real chats and explicit saved-definition tests report here.

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 1000;

interface Evidence {
  viewerId: string;
  agentId: string;
  revision: number;
  ok: boolean;
  checkedAt: number;
  latencyMs?: number;
  code?: ErrorCode;
}

const evidence = new Map<string, Evidence>();
const key = (viewerId: string, agentId: string) => `${viewerId}\u0000${agentId}`;

export function noteAgentOutcome(entry: Evidence): void {
  const id = key(entry.viewerId, entry.agentId);
  const current = evidence.get(id);
  // A request that started on an older revision must not overwrite evidence about the current one.
  if (current && current.revision > entry.revision) return;
  evidence.delete(id);
  evidence.set(id, entry);
  while (evidence.size > MAX_ENTRIES) evidence.delete(evidence.keys().next().value!);
}

export function agentStatus(viewerId: string, agentId: string, revision: number, now = Date.now()): N8nAgentStatus {
  const entry = evidence.get(key(viewerId, agentId));
  if (!entry || entry.revision !== revision || now - entry.checkedAt > TTL_MS) return { agentId, revision, state: "unknown", checkedAt: null };
  return {
    agentId,
    revision,
    state: entry.ok ? "ok" : "error",
    checkedAt: entry.checkedAt,
    ...(entry.latencyMs !== undefined ? { latencyMs: entry.latencyMs } : {}),
    ...(entry.code ? { code: entry.code } : {}),
  };
}

export function clearAgentStatus(agentId: string): void {
  for (const [id, entry] of evidence) if (entry.agentId === agentId) evidence.delete(id);
}

export function clearViewerStatus(viewerId: string): void {
  for (const [id, entry] of evidence) if (entry.viewerId === viewerId) evidence.delete(id);
}
