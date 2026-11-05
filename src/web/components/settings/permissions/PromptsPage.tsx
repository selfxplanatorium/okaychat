import { Select } from "@/components/ui/select";
import { t } from "@/i18n";
import { usePermissions, type CatalogModel } from "@/state/permissions";
import type { PermissionsQuery, PolicyFilter } from "@/state/permissions-query";
import { FILTER_LABELS } from "./labels";
import { PromptWorkspace } from "./PromptWorkspace";
import { SubjectPicker } from "./SubjectPicker";

const NO_MODELS: CatalogModel[] = [];

export function PromptsPage({ query, onQuery }: { query: PermissionsQuery; onQuery: (patch: Partial<PermissionsQuery>) => void }) {
  const models = usePermissions((state) => state.bootstrap?.modelCatalog ?? NO_MODELS);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="bg-card flex flex-wrap items-end gap-3 rounded-xl px-4 py-3 shadow-[var(--depth-highlight),var(--shadow-raised)]">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs sm:max-w-xs">
          <span className="text-muted-foreground">{t("permissions.subject")}</span>
          <SubjectPicker subject={query.subject} onChange={(subject) => onQuery({ subject })} />
        </label>
        <label className="flex w-full flex-col gap-1 text-xs sm:w-64">
          <span className="text-muted-foreground">{t("permissions.modelScope")}</span>
          <Select
            aria-label={t("permissions.modelScope")}
            value={query.modelRef ?? ""}
            onValueChange={(modelRef) => onQuery({ modelRef: modelRef || null })}
            options={[{ value: "", label: t("permissions.scopeAllModels") }, ...models.map((model) => ({ value: model.ref, label: model.name }))]}
          />
        </label>
        <label className="flex w-full flex-col gap-1 text-xs sm:w-44">
          <span className="text-muted-foreground">{t("permissions.filterLabel")}</span>
          <Select
            aria-label={t("permissions.filterLabel")}
            value={query.filter}
            onValueChange={(filter) => onQuery({ filter: filter as PolicyFilter })}
            options={(Object.keys(FILTER_LABELS) as PolicyFilter[]).map((filter) => ({ value: filter, label: t(FILTER_LABELS[filter]) }))}
          />
        </label>
        <p className="text-muted-foreground w-full text-xs">{t("permissions.promptPageHelp")}</p>
      </div>
      <div className="bg-card overflow-hidden rounded-xl shadow-[var(--depth-highlight),var(--shadow-raised)]">
        <PromptWorkspace subject={query.subject} modelRef={query.modelRef} filter={query.filter} />
      </div>
    </div>
  );
}
