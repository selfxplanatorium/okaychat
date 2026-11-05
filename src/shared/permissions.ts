import type { ModelAccessTarget, PromptKey } from "./types.js";

// Account permissions authored by administrators (docs/implementation/granular-permissions.md). A policy
// document belongs to one subject (everyone, a group, a user) and one selector (all models or one exact
// model ref). Each field resolves on its own: subject specificity first, then selector specificity, with
// deny-wins / minimum across the groups a user belongs to. Pure: no database or web imports, so the
// server resolver, the preview, and the web editor share these rules.

export const FEATURE_KEYS = [
  "webSearch",
  "webFetch",
  "research",
  "code",
  "images",
  "mcp",
  "knowledge",
  "memory",
  "schedules",
  "sharing",
  "temporaryChats",
  "voice",
  "email",
  "artifacts",
  "generativeUI",
  "delegation",
  "skills",
  "evaluations",
  "channels",
  "customTools",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** A feature is usable only when every feature it depends on is too. */
export const FEATURE_DEPENDENCIES: Readonly<Partial<Record<FeatureKey, readonly FeatureKey[]>>> = {
  research: ["webSearch", "webFetch"],
  generativeUI: ["artifacts"],
};

export const LIMIT_KEYS = [
  "maxSteps",
  "maxSearches",
  "contextTokens",
  "outputTokens",
  "operationsPerMinute",
  "concurrentOperations",
  "concurrentTurns",
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

/** Accepted stored values per limit; `null` (no additional policy ceiling) is always accepted too. */
export const LIMIT_BOUNDS: Readonly<Record<LimitKey, { min: number; max: number }>> = {
  maxSteps: { min: 1, max: 50 },
  maxSearches: { min: 0, max: 50 },
  contextTokens: { min: 1024, max: 10_000_000 },
  outputTokens: { min: 1, max: 1_000_000 },
  operationsPerMinute: { min: 1, max: 100_000 },
  concurrentOperations: { min: 1, max: 1000 },
  concurrentTurns: { min: 1, max: 4 },
};

/** Application maxima no policy can relax. */
export const HARD_CAPS: Readonly<Partial<Record<LimitKey, number>>> = {
  maxSteps: 50,
  maxSearches: 50,
  concurrentTurns: 4,
};

/** Rate and concurrency limits are buckets: the all-model value is an aggregate, an exact-model value an extra bucket. */
export const BUCKET_LIMITS = ["operationsPerMinute", "concurrentOperations", "concurrentTurns"] as const satisfies readonly LimitKey[];
export type BucketLimitKey = (typeof BUCKET_LIMITS)[number];
export const isBucketLimit = (key: LimitKey): key is BucketLimitKey => (BUCKET_LIMITS as readonly string[]).includes(key);

export type Subject = ModelAccessTarget;
export type SubjectKind = Subject["kind"];

export interface PolicyDocument {
  version: 1;
  modelAllowed?: boolean;
  features?: Partial<Record<FeatureKey, boolean>>;
  limits?: Partial<Record<LimitKey, number | null>>;
}

export interface PolicyRow {
  subject: Subject;
  /** null is the all-model selector (stored as ''). */
  modelRef: string | null;
  document: PolicyDocument;
  updatedAt: number;
  updatedBy: string | null;
}

export interface PromptRuleValue {
  mode: "replace" | "append";
  text: string;
}

export interface PromptRule {
  subject: Subject;
  modelRef: string | null;
  key: PromptKey;
  rule: PromptRuleValue;
  updatedAt: number;
}

export type Change =
  | { kind: "policy"; subject: Subject; modelRef: string | null; document: PolicyDocument | null }
  | { kind: "prompt"; subject: Subject; modelRef: string | null; key: PromptKey; rule: PromptRuleValue | null }
  | { kind: "serverPrompt"; key: PromptKey; value: string | null }
  | { kind: "providerAudience"; providerId: string; audience: { mode: "all" | "selected"; userIds: string[]; groupIds: string[] } }
  | { kind: "providerEntitlements"; providerId: string; policies: Array<{ target: Subject; mode: "all" | "selected"; modelIds: string[] }> }
  | { kind: "mcpAudience"; serverId: string; audience: { mode: "all" | "selected"; userIds: string[]; groupIds: string[] } }
  | { kind: "groupOrder"; groupIds: string[] }
  | { kind: "membership"; groupId: string; userIds: string[] };

export interface InspectionInput {
  userId: string;
  modelRef?: string;
  threadId?: string;
  temporary?: boolean;
}

export type SourceKind = "default" | "everyone" | "group" | "user" | "resource" | "preference" | "hardCap" | "dependency";

export interface SourceValue {
  id: string;
  kind: SourceKind;
  subjectId?: string;
  modelRef: string | null;
  value: boolean | number | null;
  applied: boolean;
  reasonKey: string;
}

export interface FieldResolution {
  effective: boolean | number | null;
  candidates: SourceValue[];
  winnerSourceIds: string[];
  constrainedBy: string[];
}

/** One stored document as it reaches the resolver: who it belongs to and which selector it uses. */
export interface PolicyLayer {
  subject: Subject;
  modelRef: string | null;
  document: PolicyDocument;
}

export interface BucketLimits {
  operationsPerMinute: number | null;
  concurrentOperations: number | null;
  concurrentTurns: number | null;
}

export interface ResolvedPolicy {
  modelRef: string | null;
  modelAllowed: boolean;
  /** After dependencies: research needs web search, page reading, and a positive search allowance. */
  features: Record<FeatureKey, boolean>;
  /** Policy ceilings for non-bucket limits (null = no additional ceiling); bucket keys hold the aggregate. */
  limits: Record<LimitKey, number | null>;
  buckets: { aggregate: BucketLimits; model: BucketLimits | null };
  provenance: Record<string, FieldResolution>;
}

/** Self-permission response of `GET /api/permissions`: no source names, groups, or prompt text. */
export interface SelfPermissions {
  revision: number;
  modelRef: string | null;
  modelAllowed: boolean;
  features: Record<FeatureKey, boolean>;
  limits: Record<LimitKey, number | null>;
  buckets: { aggregate: BucketLimits; model: BucketLimits | null };
  disabledReasons: Partial<Record<FeatureKey, "admin" | "dependency">>;
}

export const POLICY_VERSION = 1;
export const MAX_MODEL_REF = 300;
export const MAX_PROMPT_RULE_CHARS = 50_000;

const escape = (part: string) => encodeURIComponent(part);
/** Stable, display-independent source ids: `kind:subjectId:selector:path`. */
export const sourceId = (kind: SourceKind, subjectId: string, modelRef: string | null, path: string) =>
  `${kind}:${escape(subjectId)}:${modelRef === null ? "*" : escape(modelRef)}:${path}`;

export type FieldPath = "modelAllowed" | `features.${FeatureKey}` | `limits.${LimitKey}`;

function fieldOf(document: PolicyDocument, path: FieldPath): boolean | number | null | undefined {
  if (path === "modelAllowed") return document.modelAllowed;
  const [group, key] = path.split(".") as ["features" | "limits", string];
  const bag = document[group] as Record<string, boolean | number | null> | undefined;
  return bag && Object.hasOwn(bag, key) ? bag[key] : undefined;
}

type Value = boolean | number | null;
/** Booleans: deny wins. Numbers: the minimum, with null (no ceiling) as infinity. */
function combineGroups(values: Value[]): Value {
  if (typeof values[0] === "boolean") return values.every((value) => value === true);
  let best: number | null = null;
  for (const value of values) {
    if (typeof value === "number" && (best === null || value < best)) best = value;
  }
  return best;
}

const reasonFor = (layer: PolicyLayer, path: FieldPath, value: Value): string => {
  if (layer.subject.kind === "group") return typeof value === "boolean" ? (value ? "groupAllow" : "groupDeny") : "groupMinimum";
  if (layer.subject.kind === "user") return layer.modelRef === null ? "userOverride" : "modelOverride";
  return path === "modelAllowed" || layer.modelRef === null ? "everyone" : "modelOverride";
};

/**
 * Resolves one field over the matching layers (§2.2). `scope` limits which selectors participate:
 * `all` uses every matching row, `aggregate` only all-model rows, `model` only exact-model rows.
 */
export function resolveField(
  path: FieldPath,
  layers: readonly PolicyLayer[],
  fallback: Value | undefined,
  scope: "all" | "aggregate" | "model" = "all",
): FieldResolution & { explicit: boolean } {
  const participates = (layer: PolicyLayer) => scope === "all" || (scope === "aggregate" ? layer.modelRef === null : layer.modelRef !== null);
  const candidates: SourceValue[] = [];
  let effective: Value | undefined = fallback;
  let winners: string[] = [];
  let explicit = false;
  if (fallback !== undefined) {
    const id = sourceId("default", "", null, path);
    candidates.push({ id, kind: "default", modelRef: null, value: fallback, applied: false, reasonKey: "default" });
    winners = [id];
  }
  const add = (layer: PolicyLayer, value: Value) => {
    const id = sourceId(layer.subject.kind, layer.subject.id, layer.modelRef, path);
    candidates.push({
      id,
      kind: layer.subject.kind,
      ...(layer.subject.kind === "everyone" ? {} : { subjectId: layer.subject.id }),
      modelRef: layer.modelRef,
      value,
      applied: false,
      reasonKey: reasonFor(layer, path, value),
    });
    return id;
  };
  const ordered = (kind: SubjectKind) =>
    layers.filter((layer) => layer.subject.kind === kind && participates(layer))
      // All-model before exact-model, so the exact one wins inside one subject.
      .sort((a, b) => Number(a.modelRef !== null) - Number(b.modelRef !== null));

  for (const kind of ["everyone", "user"] as const) {
    if (kind === "user") applyGroups();
    for (const layer of ordered(kind)) {
      const value = fieldOf(layer.document, path);
      if (value === undefined) continue;
      const id = add(layer, value);
      effective = value;
      winners = [id];
      explicit = true;
    }
  }

  function applyGroups() {
    const byGroup = new Map<string, PolicyLayer[]>();
    for (const layer of ordered("group")) byGroup.set(layer.subject.id, [...(byGroup.get(layer.subject.id) ?? []), layer]);
    const picks: Array<{ id: string; value: Value }> = [];
    // Sorted ids so the result never depends on SQL or creation order.
    for (const groupId of [...byGroup.keys()].sort()) {
      const rows = byGroup.get(groupId)!;
      const exact = rows.find((row) => row.modelRef !== null && fieldOf(row.document, path) !== undefined);
      const all = rows.find((row) => row.modelRef === null && fieldOf(row.document, path) !== undefined);
      // The group's exact-model field replaces its all-model field; the losing one is still listed.
      for (const row of [all, exact]) {
        if (!row) continue;
        const id = add(row, fieldOf(row.document, path)!);
        if (row === (exact ?? all)) picks.push({ id, value: fieldOf(row.document, path)! });
      }
    }
    if (!picks.length) return;
    const combined = combineGroups(picks.map((pick) => pick.value));
    effective = combined;
    winners = picks.filter((pick) => pick.value === combined).map((pick) => pick.id);
    explicit = true;
  }

  const winnerSet = new Set(winners);
  for (const candidate of candidates) candidate.applied = winnerSet.has(candidate.id);
  return { effective: effective ?? null, candidates, winnerSourceIds: winners, constrainedBy: [], explicit };
}

/** Raw policy defaults: everything allowed and no ceilings, matching behaviour before policies existed. */
export const DEFAULT_LIMITS: Readonly<Record<LimitKey, number | null>> = {
  maxSteps: null,
  maxSearches: null,
  contextTokens: null,
  outputTokens: null,
  operationsPerMinute: null,
  concurrentOperations: null,
  concurrentTurns: HARD_CAPS.concurrentTurns!,
};

/**
 * Every field of a user's effective policy for one model (or none, for model-less work). `layers` must
 * contain only rows of live subjects that apply to this user: everyone, their current groups, themselves.
 */
export function resolvePolicy(layers: readonly PolicyLayer[], modelRef: string | null): ResolvedPolicy {
  const matching = layers.filter((layer) => layer.modelRef === null || layer.modelRef === modelRef);
  const provenance: Record<string, FieldResolution> = {};
  const record = (path: FieldPath, resolution: FieldResolution & { explicit: boolean }) => {
    const { explicit: _explicit, ...rest } = resolution;
    provenance[path] = rest;
    return resolution;
  };

  const modelAllowed = record("modelAllowed", resolveField("modelAllowed", matching, true)).effective === true;

  const limits = {} as Record<LimitKey, number | null>;
  for (const key of LIMIT_KEYS) {
    const path = `limits.${key}` as const;
    const resolution = record(path, resolveField(path, matching, DEFAULT_LIMITS[key], isBucketLimit(key) ? "aggregate" : "all"));
    let value = resolution.effective as number | null;
    const cap = HARD_CAPS[key];
    if (cap !== undefined && (value === null || value > cap)) {
      value = cap;
      resolution.constrainedBy.push(sourceId("hardCap", "", null, path));
    }
    resolution.effective = value;
    limits[key] = value;
  }

  let model: BucketLimits | null = null;
  if (modelRef !== null) {
    const bucket: BucketLimits = { operationsPerMinute: null, concurrentOperations: null, concurrentTurns: null };
    let any = false;
    for (const key of BUCKET_LIMITS) {
      const path = `limits.${key}` as const;
      const resolution = resolveField(path, matching, undefined, "model");
      if (!resolution.explicit) continue;
      any = true;
      bucket[key] = resolution.effective as number | null;
      provenance[`buckets.model.${key}`] = { ...resolution, constrainedBy: [] };
    }
    if (any) model = bucket;
  }

  const features = {} as Record<FeatureKey, boolean>;
  for (const key of FEATURE_KEYS) {
    features[key] = record(`features.${key}`, resolveField(`features.${key}`, matching, true)).effective === true;
  }
  for (const key of FEATURE_KEYS) {
    const needs = FEATURE_DEPENDENCIES[key] ?? [];
    const missing = needs.filter((need) => !features[need]);
    if (key === "research" && limits.maxSearches === 0) missing.push("webSearch");
    if (missing.length && features[key]) {
      features[key] = false;
      provenance[`features.${key}`]!.effective = false;
      provenance[`features.${key}`]!.constrainedBy.push(...missing.map((need) => sourceId("dependency", "", null, `features.${need}`)));
    }
  }

  return {
    modelRef,
    modelAllowed,
    features,
    limits,
    buckets: {
      aggregate: { operationsPerMinute: limits.operationsPerMinute, concurrentOperations: limits.concurrentOperations, concurrentTurns: limits.concurrentTurns },
      model,
    },
    provenance,
  };
}

/** Effective account-request value: min(request, policy ceiling, hard cap). */
export function clampRequested(key: LimitKey, requested: number, policy: number | null): number {
  const cap = HARD_CAPS[key];
  let value = requested;
  if (policy !== null) value = Math.min(value, policy);
  if (cap !== undefined) value = Math.min(value, cap);
  return value;
}

/** Canonical form: sorted keys, no empty bags. Returns null when nothing but the version remains. */
export function canonicalDocument(document: PolicyDocument): PolicyDocument | null {
  const out: PolicyDocument = { version: 1 };
  if (document.modelAllowed !== undefined) out.modelAllowed = document.modelAllowed;
  const features = Object.fromEntries(FEATURE_KEYS.filter((key) => document.features?.[key] !== undefined).map((key) => [key, document.features![key]!]));
  if (Object.keys(features).length) out.features = features;
  const limits = Object.fromEntries(LIMIT_KEYS.filter((key) => document.limits && Object.hasOwn(document.limits, key) && document.limits[key] !== undefined)
    .map((key) => [key, document.limits![key]!]));
  if (Object.keys(limits).length) out.limits = limits;
  return out.modelAllowed === undefined && !out.features && !out.limits ? null : out;
}

/** Byte-stable JSON with lexicographically sorted object keys at every level. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** Applies ordered prompt rules to an inherited segment: replace swaps it, append joins with one blank line. */
export function applyPromptRule(accumulated: string, rule: PromptRuleValue): string {
  if (rule.mode === "replace") return rule.text;
  return accumulated ? `${accumulated}\n\n${rule.text}` : rule.text;
}

/** Model refs split at the first slash; ids may contain slashes. */
export function validModelRef(ref: string): boolean {
  if (ref.length < 1 || ref.length > MAX_MODEL_REF || /[\u0000-\u001f\u007f]/.test(ref)) return false;
  const slash = ref.indexOf("/");
  return slash > 0 && slash < ref.length - 1;
}
