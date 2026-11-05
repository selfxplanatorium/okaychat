import { InfoIcon, SparklesIcon, UsersIcon } from "lucide-react";
import { FEATURE_KEYS, LIMIT_KEYS, isBucketLimit, type Subject } from "@shared/permissions";
import { useMemo } from "react";
import { Select } from "@/components/ui/select";
import { t } from "@/i18n";
import { effectivePolicy, usePermissions } from "@/state/permissions";
import type { PolicyFilter, PolicyTab } from "@/state/permissions-query";
import { FeatureField, LimitField, ModelAccessField } from "./PolicyFields";
import { PromptWorkspace } from "./PromptWorkspace";
import { Tabs } from "./Shared";

function subjectName(subject: Subject, users: ReadonlyArray<{ id: string; name: string }>, groups: ReadonlyArray<{ id: string; name: string }>): string {
  if (subject.kind === "everyone") return t("permissions.scopeEveryone");
  if (subject.kind === "group") return groups.find((group) => group.id === subject.id)?.name ?? subject.id;
  return users.find((user) => user.id === subject.id)?.name ?? subject.id;
}

export function SubjectDetail({
  subject,
  modelRef,
  tab,
  filter,
  onQuery,
}: {
  subject: Subject;
  modelRef: string | null;
  tab: PolicyTab;
  filter: PolicyFilter;
  onQuery: (patch: { modelRef?: string | null; tab?: PolicyTab }) => void;
}) {
  const state = usePermissions();
  const bootstrap = state.bootstrap;
  const response = state.subjects[subject.kind + ":" + subject.id];
  const resolved = effectivePolicy(state, subject, modelRef);
  const name = subjectName(subject, bootstrap?.subjects.users ?? [], bootstrap?.subjects.groups ?? []);
  const models = bootstrap?.modelCatalog ?? [];
  const exactScopes = useMemo(() => {
    const set = new Set<string>();
    for (const row of response?.policies ?? []) if (row.modelRef) set.add(row.modelRef);
    for (const row of response?.promptRules ?? []) if (row.modelRef) set.add(row.modelRef);
    if (modelRef) set.add(modelRef);
    return [...set].sort();
  }, [response, modelRef]);
  const scopeItems = [
    { id: "", label: t("permissions.scopeAllModels") },
    ...exactScopes.map((ref) => ({ id: ref, label: models.find((model) => model.ref === ref)?.name ?? ref })),
  ];
  const groupIds = subject.kind === "user" ? (bootstrap?.subjects.groups ?? []).filter((group) => group.userIds.includes(subject.id)) : subject.kind === "group" ? [{ id: subject.id, name }] : [];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="bg-card flex flex-col gap-3 rounded-xl px-4 py-3 shadow-[var(--depth-highlight),var(--shadow-raised)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs">
              {subject.kind === "everyone" ? t("permissions.scopeEveryone") : subject.kind === "group" ? t("permissions.scopeGroup") : t("permissions.scopeUser")} · {modelRef ? t("permissions.scopeModel") : t("permissions.scopeAllModels")}
            </p>
            <h2 className="truncate text-lg font-semibold tracking-tight">{name}</h2>
            <p className="text-muted-foreground mt-0.5 truncate text-xs">
              {subject.kind === "user" ? bootstrap?.subjects.users.find((user) => user.id === subject.id)?.email : modelRef ?? t("permissions.allModelsHint")}
            </p>
          </div>
          <label className="flex w-full max-w-xs flex-col gap-1 text-xs sm:w-64">
            <span className="text-muted-foreground">{t("permissions.modelScope")}</span>
            <Select
              aria-label={t("permissions.modelScope")}
              value={modelRef ?? ""}
              onValueChange={(value) => onQuery({ modelRef: value || null })}
              options={[{ value: "", label: t("permissions.scopeAllModels") }, ...models.map((model) => ({ value: model.ref, label: `${model.name} · ${model.providerId}` }))]}
            />
          </label>
        </div>
        {groupIds.length > 0 && (
          <p className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
            <UsersIcon className="size-3.5" aria-hidden /> {t("permissions.groupsIncluded")}
            {groupIds.map((group) => (
              <span key={group.id} className="bg-muted rounded px-1.5 py-0.5 text-[11px]">
                {group.name}
              </span>
            ))}
          </p>
        )}
        {modelRef && <p className="text-muted-foreground flex items-start gap-1.5 text-xs"><InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {t("permissions.credentialGate")}</p>}
      </header>

      <div>
        <Tabs
          label={t("permissions.modelScope")}
          idPrefix="policy-scope"
          value={modelRef ?? ""}
          onChange={(value) => onQuery({ modelRef: value || null })}
          items={scopeItems}
          className="mb-3"
        />
        <div role="tabpanel" id={`policy-scope-panel-${modelRef ?? ""}`} aria-labelledby={`policy-scope-tab-${modelRef ?? ""}`} tabIndex={0} className="outline-none">
          <Tabs
            label={t("permissions.policyTabs")}
            idPrefix="policy-tab"
            value={tab}
            onChange={(value) => onQuery({ tab: value as PolicyTab })}
            items={[
              { id: "access", label: t("permissions.tabsAccess") },
              { id: "features", label: t("permissions.tabsFeatures") },
              { id: "limits", label: t("permissions.tabsLimits") },
              { id: "prompts", label: t("permissions.tabsPrompts") },
            ]}
          />
          <div id={`policy-tab-panel-${tab}`} role="tabpanel" aria-labelledby={`policy-tab-tab-${tab}`} tabIndex={0} className="bg-card divide-border flex flex-col divide-y rounded-b-xl rounded-tr-xl shadow-[var(--depth-highlight),var(--shadow-raised)] outline-none">
            {tab === "access" && (
              <>
                <ModelAccessField subject={subject} modelRef={modelRef} resolved={resolved} />
                <div className="flex items-start gap-2 px-4 py-3">
                  <SparklesIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                  <p className="text-muted-foreground text-xs">{t("permissions.credentialGateHelp")}</p>
                </div>
              </>
            )}
            {tab === "features" && (
              <>
                {FEATURE_KEYS.map((feature) => (
                  <FeatureField key={feature} subject={subject} modelRef={modelRef} feature={feature} resolved={resolved} filter={filter} />
                ))}
              </>
            )}
            {tab === "limits" && (
              <>
                {modelRef && <p className="text-muted-foreground px-4 py-3 text-xs">{t("permissions.bucketNote")}</p>}
                {LIMIT_KEYS.map((limit) => (
                  <LimitField
                    key={limit}
                    subject={subject}
                    modelRef={modelRef}
                    limit={limit}
                    resolved={resolved}
                    filter={filter}
                    bucketScope={modelRef && isBucketLimit(limit) ? "model" : "default"}
                  />
                ))}
              </>
            )}
            {tab === "prompts" && <PromptWorkspace subject={subject} modelRef={modelRef} filter={filter} />}
          </div>
        </div>
      </div>
    </div>
  );
}

export { subjectName };
