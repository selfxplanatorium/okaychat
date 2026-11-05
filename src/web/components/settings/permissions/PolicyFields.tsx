import { LIMIT_BOUNDS, type FeatureKey, type LimitKey, type ResolvedPolicy, type Subject, type SourceValue } from "@shared/permissions";
import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { formatNumber } from "@/i18n/format";
import { setFeature, setLimit, setModelAllowed } from "@/state/permissions-draft";
import { policyDraftFor, usePermissions, type PermissionsState } from "@/state/permissions";
import type { PolicyFilter } from "@/state/permissions-query";
import { FEATURE_HELP, FEATURE_LABEL, LIMIT_HELP, LIMIT_LABEL, LIMIT_UNIT, REASON_LABEL } from "./labels";
import { ChoiceGroup, FieldFrame } from "./Shared";

// One field of the policy editor. Every row shows what applies now, where it came from, and the local
// decision. Inherit deletes the field; Allow/Deny and Set/No additional limit write explicit values.

type Bootstrap = Pick<PermissionsState, "bootstrap">;

export function sourceDescription(state: Bootstrap, candidate: SourceValue): string {
  const name =
    candidate.kind === "group"
      ? (state.bootstrap?.subjects.groups.find((group) => group.id === candidate.subjectId)?.name ?? candidate.subjectId ?? "")
      : candidate.kind === "user"
        ? (state.bootstrap?.subjects.users.find((user) => user.id === candidate.subjectId)?.name ?? candidate.subjectId ?? "")
        : "";
  switch (candidate.kind) {
    case "default":
      return t("permissions.sourceDefault");
    case "everyone":
      return t("permissions.sourceEveryone");
    case "group":
      return t("permissions.sourceGroup", { name });
    case "user":
      return t("permissions.sourceUser", { name });
    case "resource":
      return t("permissions.sourceResource");
    case "preference":
      return t("permissions.sourcePreference");
    case "hardCap":
      return t("permissions.sourceHardCap");
    case "dependency":
      return t("permissions.sourceDependency");
  }
}

/** "Everyone · a matching group denies this" for the winning candidates of one field. */
export function sourceLine(state: Bootstrap, resolution: { candidates: SourceValue[]; winnerSourceIds: string[]; constrainedBy: string[] } | undefined): ReactNode {
  if (!resolution) return null;
  const applied = resolution.candidates.filter((candidate) => resolution.winnerSourceIds.includes(candidate.id));
  const parts = applied.length
    ? applied.map((candidate) => {
        const source = sourceDescription(state, candidate);
        if (candidate.reasonKey === "default" || candidate.reasonKey === "everyone") return source;
        return `${source} · ${t(REASON_LABEL[candidate.reasonKey] ?? "permissions.sourceDefault")}`;
      })
    : [t("permissions.sourceDefault")];
  return <span className="text-muted-foreground">{parts.join(" · ")}</span>;
}

export function booleanText(value: boolean): string {
  return value ? t("permissions.valueAllow") : t("permissions.valueDeny");
}

export function limitText(value: number | null, key: LimitKey): string {
  if (value === null) return t("permissions.valueUnlimited");
  return `${formatNumber(value)} ${t(LIMIT_UNIT[key])}`;
}

function passesFilter(kind: "feature" | "limit", overridden: boolean, effective: boolean | number | null, filter: PolicyFilter): boolean {
  if (filter === "all") return true;
  if (filter === "overridden") return overridden;
  if (filter === "inherited") return !overridden;
  if (filter === "denied") return kind === "feature" ? effective === false : effective === 0;
  return false;
}

export function FeatureField({
  subject,
  modelRef,
  feature,
  resolved,
  filter = "all",
}: {
  subject: Subject;
  modelRef: string | null;
  feature: FeatureKey;
  resolved: ResolvedPolicy;
  filter?: PolicyFilter;
}) {
  const state = usePermissions();
  const draft = policyDraftFor(state, subject, modelRef);
  const local = draft.draft.features?.[feature];
  const effective = resolved.features[feature];
  if (!passesFilter("feature", local !== undefined, effective, filter)) return null;
  const value = local === undefined ? "inherit" : local ? "allow" : "deny";
  const dependency = (resolved.provenance[`features.${feature}`]?.constrainedBy ?? []).some((id) => id.startsWith("dependency:"));
  return (
    <FieldFrame
      label={t(FEATURE_LABEL[feature])}
      help={t(FEATURE_HELP[feature])}
      effective={booleanText(effective)}
      source={sourceLine(state, resolved.provenance[`features.${feature}`])}
      problem={
        effective === false && local !== false && dependency ? t("permissions.featureBlockedByDependency") : undefined
      }
    >
      <ChoiceGroup
        label={t(FEATURE_LABEL[feature])}
        value={value}
        onChange={(next) =>
          usePermissions.getState().editPolicy(subject, modelRef, (document) =>
            setFeature(document, feature, next === "inherit" ? undefined : next === "allow"),
          )
        }
        options={[
          { value: "inherit", label: t("permissions.valueInherit") },
          { value: "allow", label: t("permissions.valueAllow") },
          { value: "deny", label: t("permissions.valueDeny") },
        ]}
      />
      {local !== undefined && (
        <span className="text-muted-foreground text-[11px]">{t("permissions.localOverride")}</span>
      )}
    </FieldFrame>
  );
}

export function LimitField({
  subject,
  modelRef,
  limit,
  resolved,
  filter = "all",
  bucketScope = "default",
}: {
  subject: Subject;
  modelRef: string | null;
  limit: LimitKey;
  resolved: ResolvedPolicy;
  filter?: PolicyFilter;
  /** Exact-model bucket rows are additional to the aggregate, so both values are shown. */
  bucketScope?: "default" | "aggregate" | "model";
}) {
  const state = usePermissions();
  const draft = policyDraftFor(state, subject, modelRef);
  const local = draft.draft.limits?.[limit];
  const provenanceKey = bucketScope === "model" ? `buckets.model.${limit}` : `limits.${limit}`;
  const resolution = resolved.provenance[provenanceKey];
  const effective = bucketScope === "model" ? (resolved.buckets.model?.[limit as keyof typeof resolved.buckets.model] ?? null) : resolved.limits[limit];
  if (!passesFilter("limit", local !== undefined, effective, filter)) return null;
  const decision = local === undefined ? "inherit" : local === null ? "unlimited" : "set";
  const bounds = LIMIT_BOUNDS[limit];
  const hardCap = state.bootstrap?.registry.hardCaps[limit];
  const unit = t(LIMIT_UNIT[limit]);
  const numericValue = typeof local === "number" ? local : typeof effective === "number" ? effective : bounds.min;
  return (
    <FieldFrame
      label={t(LIMIT_LABEL[limit])}
      help={t(LIMIT_HELP[limit])}
      effective={bucketScope === "model" ? `${t("permissions.modelBucket")}: ${limitText(effective, limit)}` : limitText(effective, limit)}
      source={sourceLine(state, resolution)}
      problem={hardCap !== undefined ? t("permissions.hardCap", { value: `${formatNumber(hardCap)} ${unit}` }) : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ChoiceGroup
          label={t(LIMIT_LABEL[limit])}
          value={decision}
          onChange={(next) =>
            usePermissions.getState().editPolicy(subject, modelRef, (document) =>
              setLimit(document, limit, next === "inherit" ? undefined : next === "unlimited" ? null : numericValue),
            )
          }
          options={[
            { value: "inherit", label: t("permissions.valueInherit") },
            { value: "set", label: t("permissions.valueSetLimit") },
            { value: "unlimited", label: t("permissions.valueUnlimited") },
          ]}
        />
        {decision === "set" && (
          <label className="inline-flex items-center gap-1 text-xs">
            <span className="sr-only">{t(LIMIT_LABEL[limit])}</span>
            <Input
              type="number"
              className="h-8 w-28"
              min={bounds.min}
              max={bounds.max}
              step={1}
              value={numericValue}
              onChange={(event) => {
                const parsed = Number(event.currentTarget.value);
                if (!Number.isInteger(parsed)) return;
                usePermissions.getState().editPolicy(subject, modelRef, (document) =>
                  setLimit(document, limit, Math.min(bounds.max, Math.max(bounds.min, parsed))),
                );
              }}
            />
            <span className="text-muted-foreground">{unit}</span>
          </label>
        )}
      </div>
    </FieldFrame>
  );
}

export function ModelAccessField({ subject, modelRef, resolved }: { subject: Subject; modelRef: string | null; resolved: ResolvedPolicy }) {
  const state = usePermissions();
  const draft = policyDraftFor(state, subject, modelRef);
  const local = draft.draft.modelAllowed;
  const value = local === undefined ? "inherit" : local ? "allow" : "deny";
  return (
    <FieldFrame
      label={t("permissions.modelAccess")}
      help={modelRef ? t("permissions.modelAccessHelp") : t("permissions.allModelsAccessHelp")}
      effective={booleanText(resolved.modelAllowed)}
      source={sourceLine(state, resolved.provenance.modelAllowed)}
    >
      <ChoiceGroup
        label={t("permissions.modelAccess")}
        value={value}
        onChange={(next) =>
          usePermissions.getState().editPolicy(subject, modelRef, (document) =>
            setModelAllowed(document, next === "inherit" ? undefined : next === "allow"),
          )
        }
        options={[
          { value: "inherit", label: t("permissions.valueInherit") },
          { value: "allow", label: t("permissions.valueAllow") },
          { value: "deny", label: t("permissions.valueDeny") },
        ]}
      />
      {local !== undefined && <span className="text-muted-foreground text-[11px]">{t("permissions.localOverride")}</span>}
    </FieldFrame>
  );
}
