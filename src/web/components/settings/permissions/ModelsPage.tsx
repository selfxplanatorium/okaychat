import { AlertTriangleIcon, SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { formatNumber } from "@/i18n/format";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/state/permissions";
import type { PermissionsQuery } from "@/state/permissions-query";
import { BackButton, WorkspaceCard } from "./Shared";
import { SubjectDetail } from "./SubjectDetail";

// Model catalog view. Selecting a model opens the everyone/exact-model policy, which is where account-wide
// model access lives; shared credentials keep their audience editor in Server settings.

export function ModelsPage({ query, onQuery }: { query: PermissionsQuery; onQuery: (patch: Partial<PermissionsQuery>) => void }) {
  const state = usePermissions();
  const models = state.bootstrap?.modelCatalog ?? [];
  const statuses = state.bootstrap?.catalogStatus ?? [];
  const q = query.q.trim().toLowerCase();
  const shown = models.filter((model) => !q || `${model.name} ${model.ref}`.toLowerCase().includes(q));
  const selected = query.modelRef;
  const everyone = { kind: "everyone", id: "" } as const;

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)]">
      <div className={cn("min-w-0", selected && "max-md:hidden")}>
        <WorkspaceCard title={t("permissions.navModels")} description={t("permissions.modelsDescription")}>
          <div className="p-3">
            <div className="relative">
              <SearchIcon className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" aria-hidden />
              <Input aria-label={t("permissions.searchModels")} placeholder={t("permissions.searchModels")} value={query.q} onChange={(event) => onQuery({ q: event.currentTarget.value })} className="h-8 pl-8" />
            </div>
          </div>
          <div className="flex flex-col p-1" role="listbox" aria-label={t("permissions.navModels")}>
            {shown.map((model) => {
              const status = statuses.find((row) => row.providerId === model.providerId);
              const active = selected === model.ref;
              return (
                <button
                  key={model.ref}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => onQuery({ view: "models", subject: everyone, modelRef: model.ref, tab: "access", q: "" })}
                  className={cn(
                    "hover:bg-accent flex min-w-0 flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors duration-(--motion-fast) pointer-coarse:min-h-11",
                    active && "depth-row-active",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <span className="truncate">{model.name}</span>
                    {!model.present && (
                      <span className="bg-warning/15 text-warning rounded px-1 py-0.5 text-[10px]">{t("permissions.modelsMissing")}</span>
                    )}
                    {status?.state === "unavailable" && <AlertTriangleIcon className="text-warning size-3.5 shrink-0" aria-label={t("permissions.modelsUnavailable")} />}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">{model.ref}</span>
                  <span className="text-muted-foreground text-[11px] tabular-nums">
                    {model.providerId}
                    {model.context ? ` · ${t("permissions.modelsContext", { tokens: formatNumber(model.context) })}` : ""}
                  </span>
                </button>
              );
            })}
            {!shown.length && <p className="text-muted-foreground px-3 py-4 text-sm">{t("permissions.stateEmpty")}</p>}
          </div>
        </WorkspaceCard>
      </div>

      <div className={cn("min-w-0", !selected && "max-md:hidden")}>
        {selected ? (
          <>
            <div className="mb-2 md:hidden">
              <BackButton onClick={() => onQuery({ modelRef: null })} label={t("permissions.backToList")} />
            </div>
            <SubjectDetail subject={everyone} modelRef={selected} tab={query.tab} filter={query.filter} onQuery={onQuery} />
          </>
        ) : (
          <WorkspaceCard title={t("permissions.selectModel")} description={t("permissions.modelsCredentialNote")}>
            <p className="text-muted-foreground px-4 py-12 text-center text-sm">{t("permissions.selectModelHint")}</p>
          </WorkspaceCard>
        )}
      </div>
    </div>
  );
}
