import { HistoryIcon, Loader2Icon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { cn } from "@/lib/utils";
import { usePermissions, type AuditKind } from "@/state/permissions";
import { WorkspaceCard } from "./Shared";

const KIND_LABEL: Record<AuditKind, "permissions.auditKindPolicy" | "permissions.auditKindPrompt" | "permissions.auditKindAudience" | "permissions.auditKindEntitlement" | "permissions.auditKindMembership" | "permissions.auditKindGroupOrder" | "permissions.auditKindSubjectDelete" | "permissions.auditKindMigration"> = {
  policy: "permissions.auditKindPolicy",
  prompt: "permissions.auditKindPrompt",
  audience: "permissions.auditKindAudience",
  entitlement: "permissions.auditKindEntitlement",
  membership: "permissions.auditKindMembership",
  group_order: "permissions.auditKindGroupOrder",
  subject_delete: "permissions.auditKindSubjectDelete",
  migration: "permissions.auditKindMigration",
};

// Permission history. The list is bounded by the server cursor; detail is fetched only when requested and
// shows the decrypted destinations an admin already has access to. No summary or prompt text is rendered as HTML.

export function AuditPage() {
  const state = usePermissions();
  const users = state.bootstrap?.subjects.users ?? [];
  const detail = state.auditDetail;

  useEffect(() => {
    void usePermissions.getState().loadAudit({ reset: true });
  }, [state.generation]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <WorkspaceCard
        title={t("permissions.auditTitle")}
        description={t("permissions.auditRetention", { days: state.auditRetentionDays })}
        actions={
          <Button type="button" size="sm" variant="outline" onClick={() => void usePermissions.getState().loadAudit({ reset: true })}>
            {state.auditStatus === "loading" ? <Loader2Icon className="animate-spin" /> : <HistoryIcon />} {t("permissions.auditRefresh")}
          </Button>
        }
      >
        {state.auditStatus === "error" && <p role="alert" className="text-error px-4 py-3 text-sm">{state.auditError ?? t("permissions.stateLoadFailed")}</p>}
        <ul className="divide-border flex flex-col divide-y">
          {state.auditRows.map((row) => {
            const actor = row.actorId ? users.find((user) => user.id === row.actorId) : undefined;
            const active = detail?.revision === row.revision;
            return (
              <li key={row.revision}>
                <button
                  type="button"
                  onClick={() => void usePermissions.getState().loadAuditDetail(row.revision)}
                  aria-expanded={active}
                  className={cn("hover:bg-accent flex w-full min-w-0 flex-col gap-1 px-4 py-3 text-left transition-colors duration-(--motion-fast) pointer-coarse:min-h-11", active && "depth-row-active")}
                >
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className="bg-muted rounded px-1.5 py-0.5 text-[11px] tabular-nums">#{row.revision}</span>
                    {t(KIND_LABEL[row.kind])}
                    <span className="text-muted-foreground ml-auto text-xs font-normal tabular-nums">{formatDateTime(row.occurredAt)}</span>
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {t("permissions.auditActor")}: {actor?.name ?? row.actorId ?? t("permissions.auditSystem")}
                    {row.reason ? ` · ${row.reason}` : ""}
                  </span>
                </button>
                {active && detail && (
                  <div className="bg-muted/30 flex flex-col gap-2 px-4 pb-4">
                    <p className="text-muted-foreground text-xs">
                      {t("permissions.auditRetention", { days: state.auditRetentionDays })}
                    </p>
                    {detail.changes.length === 0 && <p className="text-muted-foreground text-xs">{t("permissions.stateEmpty")}</p>}
                    {detail.changes.map((change, index) => (
                      <div key={`${change.destination}-${index}`} className="bg-card rounded-lg border p-2">
                        <p className="font-mono text-[11px] break-all">{change.destination}</p>
                        <div className="mt-1 grid gap-2 sm:grid-cols-2">
                          <div>
                            <p className="text-muted-foreground text-[11px]">{t("permissions.auditBefore")}</p>
                            <pre className="max-h-40 overflow-auto text-[11px] break-words whitespace-pre-wrap">{formatValue(change.before)}</pre>
                          </div>
                          <div>
                            <p className="text-muted-foreground text-[11px]">{t("permissions.auditAfter")}</p>
                            <pre className="max-h-40 overflow-auto text-[11px] break-words whitespace-pre-wrap">{formatValue(change.after)}</pre>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
          {!state.auditRows.length && state.auditStatus !== "loading" && <li className="text-muted-foreground px-4 py-8 text-center text-sm">{t("permissions.auditEmpty")}</li>}
        </ul>
        {state.auditNextCursor && (
          <div className="p-3">
            <Button type="button" size="sm" variant="outline" onClick={() => void usePermissions.getState().loadAudit()}>
              {state.auditStatus === "loading" ? <Loader2Icon className="animate-spin" /> : null} {t("permissions.auditLoadMore")}
            </Button>
          </div>
        )}
      </WorkspaceCard>
    </div>
  );
}

/** Config values are JSON; show a compact readable form and never inject it as markup. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
