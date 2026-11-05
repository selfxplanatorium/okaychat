import { t } from "@/i18n";
import { usePermissions } from "@/state/permissions";
import type { PermissionsQuery, PolicyFilter } from "@/state/permissions-query";
import { Select } from "@/components/ui/select";
import { FILTER_LABELS } from "./labels";
import { SubjectDetail } from "./SubjectDetail";
import { SubjectPicker } from "./SubjectPicker";

export function FeaturesPage({ query, onQuery }: { query: PermissionsQuery; onQuery: (patch: Partial<PermissionsQuery>) => void }) {
  const loaded = usePermissions((state) => Object.keys(state.subjects).length > 0);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="bg-card flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 shadow-[var(--depth-highlight),var(--shadow-raised)]">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs sm:max-w-xs">
          <span className="text-muted-foreground">{t("permissions.subject")}</span>
          <SubjectPicker subject={query.subject} onChange={(subject) => onQuery({ subject })} />
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
        <p className="text-muted-foreground w-full text-xs">{t("permissions.featuresDescription")}</p>
      </div>
      {loaded && <SubjectDetail subject={query.subject} modelRef={query.modelRef} tab={query.tab} filter={query.filter} onQuery={onQuery} />}
    </div>
  );
}
