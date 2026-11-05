import { Loader2Icon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { N8nAgentDetail, N8nAgentStatus, N8nAgentSummary } from "@shared/types";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { t, type PlainMessageKey } from "@/i18n";
import { useCommand } from "@/keyboard/registry";
import { refreshAgentsAndTargets, useN8nAgents } from "@/state/n8n-agents";
import { AgentCard } from "./AgentCard";
import { AgentDeleteDialog } from "./AgentDeleteDialog";
import { AgentEditor, type AgentScope } from "./AgentEditor";
import { AgentEmptyState } from "./AgentEmptyState";
import { agentErrorText } from "./agent-error";

const basePath = (scope: AgentScope) => (scope === "shared" ? "/admin/agents/n8n" : "/agents/n8n");

/**
 * Own definitions (plus audience-visible shared ones, read-only) or the server-wide shared inventory.
 * Status evidence is fetched with the list and never probes a webhook.
 */
export function AgentManagement({ scope }: { scope: AgentScope }) {
  const ownAgents = useN8nAgents((s) => s.agents);
  const statuses = useN8nAgents((s) => s.statuses);
  const ownLoaded = useN8nAgents((s) => s.loaded);
  const ownLoading = useN8nAgents((s) => s.loading);
  const ownFailed = useN8nAgents((s) => s.failed);
  const [sharedAgents, setSharedAgents] = useState<N8nAgentSummary[] | null>(null);
  const [sharedStatuses, setSharedStatuses] = useState<Record<string, N8nAgentStatus>>({});
  const [sharedFailed, setSharedFailed] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [deleting, setDeleting] = useState<N8nAgentSummary | null>(null);
  const [notice, setNotice] = useState<PlainMessageKey | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  const refreshShared = useCallback(() => {
    setSharedFailed(false);
    void Promise.all([
      api<{ agents: N8nAgentSummary[] }>(basePath("shared")),
      api<{ statuses: N8nAgentStatus[] }>(`${basePath("shared")}/status`),
    ]).then(
      ([list, evidence]) => {
        setSharedAgents(list.agents);
        setSharedStatuses(Object.fromEntries(evidence.statuses.map((status) => [status.agentId, status])));
      },
      () => setSharedFailed(true),
    );
  }, []);

  const refresh = useCallback(() => {
    if (scope === "shared") {
      refreshShared();
      return;
    }
    void useN8nAgents.getState().refresh();
    void useN8nAgents.getState().refreshStatuses();
  }, [scope, refreshShared]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const agents = scope === "shared" ? (sharedAgents ?? []) : ownAgents;
  const loading = scope === "shared" ? sharedAgents === null && !sharedFailed : ownLoading && !ownLoaded;
  const failed = scope === "shared" ? sharedFailed : ownFailed;

  const openCreate = () => {
    setNotice(null);
    setActionError(null);
    setEditing({ id: null });
  };
  useCommand("agents.create", openCreate, !loading);

  const saved = (detail: N8nAgentDetail) => {
    setNotice("agents.saved");
    setActionError(null);
    if (scope === "own" && !detail.shared) useN8nAgents.getState().applySummary(detail);
    if (scope === "shared") refreshShared();
    void refreshAgentsAndTargets().then(() => {
      if (scope === "own") void useN8nAgents.getState().refreshStatuses();
    });
  };

  const deleted = (agent: N8nAgentSummary) => {
    setNotice("agents.deleted");
    setActionError(null);
    if (scope === "shared") refreshShared();
    else useN8nAgents.getState().removeAgent(agent.id);
    void refreshAgentsAndTargets();
    // The menu that opened the dialog is gone; return focus to the page's primary action.
    requestAnimationFrame(() => addRef.current?.focus());
  };

  const toggleEnabled = async (agent: N8nAgentSummary, enabled: boolean) => {
    setToggling(agent.id);
    setActionError(null);
    try {
      // Toggling is a metadata edit, but the contract is a full replacement: read the detail first so the
      // stored URL, config, and header are never re-entered or cleared from a summary.
      const detail = await api<N8nAgentDetail>(`${basePath(scope)}/${encodeURIComponent(agent.id)}`);
      const updated = await api<N8nAgentDetail>(`${basePath(scope)}/${encodeURIComponent(agent.id)}`, {
        method: "PUT",
        json: {
          revision: detail.revision,
          name: detail.name,
          description: detail.description,
          avatar: detail.avatar,
          enabled,
          config: detail.config,
          ...(scope === "shared" ? { audience: detail.audience } : {}),
        },
      });
      if (scope === "shared") refreshShared();
      else useN8nAgents.getState().applySummary(updated);
      void refreshAgentsAndTargets();
    } catch (error) {
      setActionError(agentErrorText(error).message);
    } finally {
      setToggling(null);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3">
        {scope === "shared" ? <h2 className="text-sm font-medium">{t("admin.sharedAgents")}</h2> : <span />}
        <Button ref={addRef} type="button" size="sm" onClick={openCreate} disabled={loading} data-command="agents.create" className="min-h-9 pointer-coarse:min-h-11">
          <PlusIcon /> {t("agents.add")}
        </Button>
      </div>
      {notice && (
        <p role="status" aria-live="polite" className="text-success text-xs">
          {t(notice)}
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-destructive flex items-start gap-1.5 text-xs wrap-break-word">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" /> {actionError}
        </p>
      )}
      <div className="bg-card divide-border flex flex-col divide-y overflow-hidden rounded-xl shadow-[var(--depth-highlight),var(--shadow-raised)]">
        {loading && (
          <p role="status" className="text-muted-foreground flex items-center gap-2 px-4 py-6 text-sm">
            <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" /> {t("common.loading")}
          </p>
        )}
        {!loading && failed && (
          <div className="flex flex-col items-start gap-2 px-4 py-6">
            <p role="alert" className="text-destructive text-sm">
              {t("agents.loadFailed")}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={refresh}>
              {t("common.tryAgain")}
            </Button>
          </div>
        )}
        {!loading && !failed && agents.length === 0 && <AgentEmptyState onAdd={openCreate} />}
        {!loading &&
          !failed &&
          agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              status={scope === "shared" ? sharedStatuses[agent.id] : statuses[agent.id]}
              canManage={scope === "shared" ? agent.canManage : agent.canManage && !agent.shared}
              onEdit={() => setEditing({ id: agent.id })}
              onTest={() => setEditing({ id: agent.id })}
              onDelete={() => setDeleting(agent)}
              onEnabledChange={(enabled) => void toggleEnabled(agent, enabled)}
              busy={toggling === agent.id}
            />
          ))}
      </div>
      <AgentEditor
        open={editing !== null}
        agentId={editing?.id ?? null}
        scope={scope}
        onClose={() => setEditing(null)}
        onSaved={saved}
        onTested={scope === "shared" ? refreshShared : undefined}
      />
      <AgentDeleteDialog agent={deleting} scope={scope} onClose={() => setDeleting(null)} onDeleted={deleted} />
    </section>
  );
}
