import { MoreHorizontalIcon, PencilIcon, PlayIcon, TrashIcon } from "lucide-react";
import type { N8nAgentStatus, N8nAgentSummary, N8nMemoryMode } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Switch } from "@/components/ui/switch";
import { t, type PlainMessageKey } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./AgentAvatar";

const MEMORY_LABELS = {
  none: "agents.memoryNone",
  history: "agents.memoryHistory",
  remote: "agents.memoryRemote",
} as const satisfies Record<N8nMemoryMode, PlainMessageKey>;

/** Last-response evidence. It is never a liveness probe: an unknown state reads "Not tested". */
export function AgentStatusLine({ agent, status }: { agent: N8nAgentSummary; status?: N8nAgentStatus }) {
  if (!agent.enabled) return <span className="text-muted-foreground">{t("agents.statusDisabled")}</span>;
  if (!status || status.state === "unknown" || status.checkedAt === null) return <span className="text-muted-foreground">{t("agents.statusUnknown")}</span>;
  const checked = t("agents.statusCheckedAt", { time: formatDateTime(status.checkedAt) });
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-1.5", status.state === "ok" ? "text-success" : "text-error")}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", status.state === "ok" ? "bg-success" : "bg-error")} />
      <span className="font-medium">{status.state === "ok" ? t("agents.statusOk") : t("agents.statusError")}</span>
      <span className="text-muted-foreground">· {checked}</span>
    </span>
  );
}

/**
 * One definition in the management list. Shared definitions a viewer may only chat with show no menu;
 * an admin manages them from the shared panel, not from their own list.
 */
export function AgentCard({
  agent,
  status,
  canManage,
  onEdit,
  onDelete,
  onTest,
  onEnabledChange,
  busy = false,
}: {
  agent: N8nAgentSummary;
  status?: N8nAgentStatus;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onTest?: () => void;
  onEnabledChange?: (enabled: boolean) => void;
  busy?: boolean;
}) {
  return (
    <div className="group/card stagger animate-rise-in flex items-start gap-3 px-4 py-3">
      <AgentAvatar avatar={agent.avatar} size="md" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <p className="min-w-0 truncate text-sm font-medium">{agent.name}</p>
          {agent.shared && <span className="bg-muted text-muted-foreground rounded px-1.5 text-[10px]">{t("agents.shared")}</span>}
          {!canManage && <span className="bg-muted text-muted-foreground rounded px-1.5 text-[10px]">{t("agents.readOnly")}</span>}
        </div>
        {agent.description && <p className="text-muted-foreground line-clamp-2 text-xs">{agent.description}</p>}
        <p className="text-muted-foreground mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span>{t(MEMORY_LABELS[agent.memoryMode])}</span>
          <span aria-hidden>·</span>
          <AgentStatusLine agent={agent} status={status} />
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {canManage && onEnabledChange && (
          <Switch className="me-1" checked={agent.enabled} disabled={busy} onCheckedChange={onEnabledChange} aria-label={t("agents.enabled")} />
        )}
        {canManage && (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("common.more")}
                  className="opacity-0 transition-opacity duration-(--motion-fast) focus-visible:opacity-100 group-hover/card:opacity-100 pointer-coarse:opacity-100 pointer-coarse:size-11"
                />
              }
            >
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuContent align="end" className="w-44">
              <MenuItem onClick={onEdit}>
                <PencilIcon /> {t("agents.edit")}
              </MenuItem>
              {onTest && (
                <MenuItem onClick={onTest}>
                  <PlayIcon /> {t("agents.testTitle")}
                </MenuItem>
              )}
              <MenuItem onClick={onDelete} className="text-destructive">
                <TrashIcon /> {t("agents.delete")}
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>
    </div>
  );
}
