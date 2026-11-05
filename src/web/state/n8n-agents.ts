import { create } from "zustand";
import type { N8nAgentStatus, N8nAgentSummary } from "@shared/types";
import { isAgentTarget } from "@shared/n8n-agents";
import { api } from "@/lib/api";
import { getActiveTarget, useData } from "./data";

// The signed-in account's agent summaries and last-response evidence. Summaries carry no config,
// URL, or header value: management detail is fetched by the editor on open and kept in local React
// state only, so a secret can never survive in this store, localStorage, or IndexedDB.

interface N8nAgentsState {
  /** The account this list belongs to; null before the first signed-in user is known. */
  accountId: string | null;
  /** Bumped for every account start and sign-out, so a late response is dropped instead of applied. */
  epoch: number;
  agents: N8nAgentSummary[];
  statuses: Record<string, N8nAgentStatus>;
  loaded: boolean;
  loading: boolean;
  /** The list request failed; the page offers Retry instead of pretending the account has no agents. */
  failed: boolean;
  refresh: () => Promise<void>;
  refreshStatuses: () => Promise<void>;
  applySummary: (summary: N8nAgentSummary) => void;
  removeAgent: (id: string) => void;
  setStatus: (status: N8nAgentStatus) => void;
  stop: () => void;
}

let epochCounter = 0;

export const useN8nAgents = create<N8nAgentsState>((set, get) => ({
  accountId: null,
  epoch: 0,
  agents: [],
  statuses: {},
  loaded: false,
  loading: false,
  failed: false,
  refresh: async () => {
    const { accountId, epoch } = get();
    if (!accountId) return;
    set({ loading: true, failed: false });
    try {
      const { agents } = await api<{ agents: N8nAgentSummary[] }>("/agents/n8n");
      if (get().accountId !== accountId || get().epoch !== epoch) return;
      set({ agents, loaded: true, loading: false });
    } catch {
      if (get().accountId !== accountId || get().epoch !== epoch) return;
      set({ loading: false, failed: true });
    }
  },
  refreshStatuses: async () => {
    const { accountId, epoch } = get();
    if (!accountId) return;
    try {
      const { statuses } = await api<{ statuses: N8nAgentStatus[] }>("/agents/n8n/status");
      if (get().accountId !== accountId || get().epoch !== epoch) return;
      set({ statuses: Object.fromEntries(statuses.map((status) => [status.agentId, status])) });
    } catch {
      // Status is advisory evidence: a failed read leaves the previous labels rather than marking agents down.
    }
  },
  applySummary: (summary) =>
    set((s) => ({
      agents: s.agents.some((agent) => agent.id === summary.id)
        ? s.agents.map((agent) => (agent.id === summary.id ? summary : agent))
        : [...s.agents, summary],
    })),
  removeAgent: (id) =>
    set((s) => {
      const statuses = { ...s.statuses };
      delete statuses[id];
      return { agents: s.agents.filter((agent) => agent.id !== id), statuses };
    }),
  setStatus: (status) => set((s) => ({ statuses: { ...s.statuses, [status.agentId]: status } })),
  stop: () => {
    epochCounter++;
    set({ accountId: null, epoch: 0, agents: [], statuses: {}, loaded: false, loading: false, failed: false });
  },
}));

/** Starts (or restarts) the account-scoped list. Called once the shell knows the signed-in user. */
export function startAgentAccount(userId: string) {
  const state = useN8nAgents.getState();
  if (state.accountId === userId) return;
  epochCounter++;
  useN8nAgents.setState({
    accountId: userId,
    epoch: epochCounter,
    agents: [],
    statuses: {},
    loaded: false,
    loading: true,
    failed: false,
  });
  void useN8nAgents.getState().refresh();
  void useN8nAgents.getState().refreshStatuses();
}

/** The last-response evidence for one agent, when it belongs to the current definition revision. */
export function useAgentStatus(agentId: string, revision: number): N8nAgentStatus | undefined {
  return useN8nAgents((s) => {
    const status = s.statuses[agentId];
    return status && status.revision === revision ? status : undefined;
  });
}

/** Refreshes the account's agent summaries and the chat target list after a management change. */
export async function refreshAgentsAndTargets() {
  await Promise.all([useN8nAgents.getState().refresh(), useData.getState().refreshProviders()]);
}

/**
 * Drops the local remote-memory session after a persistence failure, so the next message starts a fresh
 * remote conversation instead of claiming a history the server could not store. Best effort: a failure
 * here leaves the old session, and the server's digest check resets it on the next send.
 */
export async function invalidateAgentSession(threadId: string): Promise<void> {
  if (threadId.startsWith("tmp_")) return;
  const target = getActiveTarget(threadId).target;
  if (!target || !isAgentTarget(target)) return;
  await api(`/threads/${encodeURIComponent(threadId)}/agents/n8n/${encodeURIComponent(target.id)}/session`, { method: "DELETE" }).catch(() => {});
}
