import { CheckCircle2Icon, CopyIcon, XCircleIcon } from "lucide-react";
import { FEATURE_KEYS, LIMIT_KEYS } from "@shared/permissions";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { t } from "@/i18n";
import { formatNumber } from "@/i18n/format";
import { usePermissions } from "@/state/permissions";
import type { PermissionsQuery } from "@/state/permissions-query";
import { permissionsQueryRecord } from "@/state/permissions-query";
import { permissionsHref } from "@/lib/settings-link";
import { FEATURE_HELP, FEATURE_LABEL, LIMIT_HELP, LIMIT_LABEL, LIMIT_UNIT, REASON_LABEL } from "./labels";
import { sourceDescription } from "./PolicyFields";
import { ChoiceGroup, StatusLine, WorkspaceCard } from "./Shared";
import type { InspectionField } from "@/state/permissions";

type Section = "permissions" | "features" | "limits" | "prompts";

// The debugging view: final access, every feature and limit, and the winning layer in plain language.
// It reads the server's resolver, so it matches enforcement rather than the client preview.

export function InspectPage({ query, userId, onNavigate }: { query: PermissionsQuery; userId: string | null; onNavigate: (path: string) => void }) {
  const state = usePermissions();
  const [modelRef, setModelRef] = useState<string>("");
  const [section, setSection] = useState<Section>("permissions");
  const [copied, setCopied] = useState(false);
  const users = state.bootstrap?.subjects.users ?? [];
  const models = state.bootstrap?.modelCatalog ?? [];
  const inspection = state.inspection;

  useEffect(() => {
    if (!userId) return;
    void usePermissions.getState().loadInspection({ userId, ...(modelRef ? { modelRef } : {}) });
  }, [userId, modelRef, state.generation]);

  const selectUser = (next: string) =>
    onNavigate(permissionsHref({ ...permissionsQueryRecord({ ...query, view: "inspect" }), userId: next }));
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const field = (path: string) => inspection?.permissions[path];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <WorkspaceCard title={t("permissions.inspectTitle")} description={t("permissions.inspectDescription")}>
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t("permissions.inspectUser")}</span>
            <Select
              aria-label={t("permissions.inspectUser")}
              value={userId ?? ""}
              onValueChange={selectUser}
              options={[{ value: "", label: t("permissions.inspectChooseUser") }, ...users.map((user) => ({ value: user.id, label: `${user.name} · ${user.email}` }))]}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t("permissions.inspectModel")}</span>
            <Select
              aria-label={t("permissions.inspectModel")}
              value={modelRef}
              onValueChange={setModelRef}
              options={[{ value: "", label: t("permissions.scopeAllModels") }, ...models.map((model) => ({ value: model.ref, label: `${model.name} · ${model.providerId}` }))]}
            />
          </label>
          <div className="text-muted-foreground flex items-end text-xs">{t("permissions.inspectNoThread")}</div>
        </div>
        {!userId && <p className="text-muted-foreground px-4 pb-4 text-sm">{t("permissions.inspectChooseUserHint")}</p>}
        <div className="px-4 pb-4">
          <StatusLine status={state.inspectionStatus} error={state.inspectionError} />
        </div>
      </WorkspaceCard>

      {inspection && (
        <>
          <WorkspaceCard title={t("permissions.inspectAccess")} description={t("permissions.inspectExplanation")}>
            <div className="grid gap-3 p-4 sm:grid-cols-3">
              <Gate label={t("permissions.credentialGate")} allowed={inspection.access.credentialAllowed} />
              <Gate label={t("permissions.accountGate")} allowed={inspection.access.accountAllowed} />
              <Gate label={t("permissions.inspectFinal")} allowed={inspection.access.allowed} />
            </div>
            {inspection.model && (
              <p className="text-muted-foreground px-4 pb-3 text-xs">
                {inspection.model.ref} · {inspection.model.connection === "own" ? t("permissions.inspectConnectionOwn") : inspection.model.connection === "shared" ? t("permissions.inspectConnectionShared") : t("permissions.inspectConnectionNone")} ·{" "}
                {inspection.model.catalogPresent ? t("permissions.modelsPresent") : t("permissions.modelsMissing")}
              </p>
            )}
            {inspection.access.reasons.length > 0 && (
              <p className="text-muted-foreground px-4 pb-3 text-xs">
                {inspection.access.reasons.map((reason) => t(REASON_LABEL[reason] ?? "permissions.sourceDefault")).join(" · ")}
              </p>
            )}
          </WorkspaceCard>

          <ChoiceGroup
            label={t("permissions.inspectSection")}
            value={section}
            onChange={(next) => setSection(next)}
            options={[
              { value: "permissions", label: t("permissions.inspectAll") },
              { value: "features", label: t("permissions.tabsFeatures") },
              { value: "limits", label: t("permissions.tabsLimits") },
              { value: "prompts", label: t("permissions.tabsPrompts") },
            ]}
          />

          {(section === "permissions" || section === "features") && (
            <WorkspaceCard title={t("permissions.tabsFeatures")}>
              <ul className="divide-border flex flex-col divide-y">
                {FEATURE_KEYS.map((feature) => (
                  <InspectRow
                    key={feature}
                    label={t(FEATURE_LABEL[feature])}
                    help={t(FEATURE_HELP[feature])}
                    resolution={field(`features.${feature}`)}
                    format={(value) => (value === true ? t("permissions.valueAllow") : t("permissions.valueDeny"))}
                  />
                ))}
              </ul>
            </WorkspaceCard>
          )}

          {(section === "permissions" || section === "limits") && (
            <WorkspaceCard title={t("permissions.tabsLimits")}>
              <ul className="divide-border flex flex-col divide-y">
                {LIMIT_KEYS.map((limit) => (
                  <InspectRow
                    key={limit}
                    label={t(LIMIT_LABEL[limit])}
                    help={t(LIMIT_HELP[limit])}
                    resolution={field(`limits.${limit}`)}
                    format={(value) => (value === null ? t("permissions.valueUnlimited") : `${formatNumber(Number(value))} ${t(LIMIT_UNIT[limit])}`)}
                  />
                ))}
                {inspection.model &&
                  (["operationsPerMinute", "concurrentOperations", "concurrentTurns"] as const).map((limit) => (
                    <InspectRow
                      key={`bucket-${limit}`}
                      label={`${t(LIMIT_LABEL[limit])} · ${t("permissions.modelBucket")}`}
                      help={t("permissions.aggregateBucket")}
                      resolution={field(`buckets.model.${limit}`)}
                      format={(value) => (value === null ? t("permissions.valueUnlimited") : `${formatNumber(Number(value))} ${t(LIMIT_UNIT[limit])}`)}
                    />
                  ))}
              </ul>
            </WorkspaceCard>
          )}

          {section === "prompts" && (
            <WorkspaceCard title={t("permissions.tabsPrompts")} description={t("permissions.inspectPromptNote")}>
              <div className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {t("permissions.inspectEstimate", { tokens: formatNumber(inspection.assembly.estimatedTokens), method: inspection.assembly.estimateMethod })}
                  </span>
                  <Button type="button" size="sm" variant="outline" onClick={() => void copy(inspection.assembly.system1)}>
                    <CopyIcon /> {copied ? t("permissions.inspectCopied") : t("permissions.inspectCopy")}
                  </Button>
                </div>
                <div>
                  <p className="text-xs font-medium">{t("permissions.promptSystem1")}</p>
                  <pre className="bg-muted/40 mt-1 max-h-64 overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap break-words">{inspection.assembly.system1}</pre>
                </div>
                <div>
                  <p className="text-xs font-medium">{t("permissions.promptSystem2")}</p>
                  <pre className="bg-muted/40 mt-1 max-h-48 overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap break-words">{inspection.assembly.system2 || t("permissions.promptEmptyText")}</pre>
                </div>
                <ul className="text-muted-foreground list-disc pl-5 text-xs">
                  {inspection.assembly.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            </WorkspaceCard>
          )}
        </>
      )}
    </div>
  );
}

function Gate({ label, allowed }: { label: string; allowed: boolean }) {
  return (
    <div className="bg-muted/40 flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
      {allowed ? <CheckCircle2Icon className="text-success size-4" aria-hidden /> : <XCircleIcon className="text-error size-4" aria-hidden />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-muted-foreground text-xs">{allowed ? t("permissions.valueAllow") : t("permissions.valueDeny")}</span>
    </div>
  );
}

function InspectRow({
  label,
  help,
  resolution,
  format,
}: {
  label: string;
  help: string;
  resolution: InspectionField | undefined;
  format: (value: boolean | number | null) => string;
}) {
  const state = usePermissions();
  const winners = resolution ? resolution.candidates.filter((candidate) => resolution.winnerSourceIds.includes(candidate.id)) : [];
  return (
    <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-muted-foreground text-xs">{help}</p>
        {winners.length > 0 && (
          <p className="text-muted-foreground mt-1 text-xs">
            {winners
              .map((candidate) => {
                const source = sourceDescription(state, candidate);
                if (candidate.reasonKey === "default" || candidate.reasonKey === "everyone") return source;
                return `${source} · ${t(REASON_LABEL[candidate.reasonKey] ?? "permissions.sourceDefault")}`;
              })
              .join(" · ")}
          </p>
        )}
        {resolution && resolution.constrainedBy.length > 0 && (
          <p className="text-warning mt-1 text-xs">{t("permissions.inspectConstrained")}</p>
        )}
      </div>
      <span className="shrink-0 text-sm font-medium tabular-nums">{resolution ? format(resolution.effective) : t("permissions.inspectUnavailable")}</span>
    </li>
  );
}
