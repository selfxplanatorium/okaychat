import { FEATURE_KEYS, LIMIT_KEYS, type FeatureKey, type LimitKey } from "@shared/permissions";

// Impact rows are canonical paths from the server preview. This module turns them into display
// descriptors; the component decides which translated label to use, so no English lives here.

export interface ImpactRow {
  userId: string;
  modelRef: string | null;
  path: string;
  before: boolean | number | string | null;
  after: boolean | number | string | null;
  beforeSources: string[];
  afterSources: string[];
}

export type ImpactKind = "access" | "feature" | "limit" | "bucket" | "prompt" | "resource";
export type ImpactDirection = "granted" | "revoked" | "tightened" | "relaxed" | "changed";

export interface ImpactDescriptor {
  kind: ImpactKind;
  /** Feature/limit/prompt key, or the resource path remainder. */
  name: string | null;
  direction: ImpactDirection;
  before: boolean | number | string | null;
  after: boolean | number | string | null;
}

const featureSet = new Set<string>(FEATURE_KEYS);
const limitSet = new Set<string>(LIMIT_KEYS);

/** Classifies a change by its field, and whether a limit moved tighter (less allowed) or looser. */
export function describeImpact(row: Pick<ImpactRow, "path" | "before" | "after">): ImpactDescriptor {
  const { path, before, after } = row;
  if (path === "modelAllowed") {
    return { kind: "access", name: null, direction: before === false && after === true ? "granted" : before === true && after === false ? "revoked" : "changed", before, after };
  }
  const parts = path.split(".");
  if (parts[0] === "features" && parts[1] && featureSet.has(parts[1])) {
    return {
      kind: "feature",
      name: parts[1] as FeatureKey,
      direction: before === false && after === true ? "granted" : before === true && after === false ? "revoked" : "changed",
      before,
      after,
    };
  }
  if (parts[0] === "limits" && parts[1] && limitSet.has(parts[1])) {
    return { kind: "limit", name: parts[1] as LimitKey, direction: limitDirection(before, after), before, after };
  }
  if (parts[0] === "buckets" && parts[1] === "model" && parts[2] && limitSet.has(parts[2])) {
    return { kind: "bucket", name: parts[2] as LimitKey, direction: limitDirection(before, after), before, after };
  }
  if (parts[0] === "prompts" && parts[1]) {
    return { kind: "prompt", name: parts.slice(1).join("."), direction: "changed", before, after };
  }
  if (parts[0] === "resource") {
    return {
      kind: "resource",
      name: parts.slice(1).join("."),
      direction: before === false && after === true ? "granted" : before === true && after === false ? "revoked" : "changed",
      before,
      after,
    };
  }
  return { kind: "resource", name: path, direction: "changed", before, after };
}

/** `null` is no additional ceiling (infinity), so 10 → null relaxes and null → 10 tightens. */
export function limitDirection(before: ImpactRow["before"], after: ImpactRow["after"]): ImpactDirection {
  const value = (input: ImpactRow["before"]) => (typeof input === "number" ? input : input === null ? Number.POSITIVE_INFINITY : Number.NaN);
  const a = value(before);
  const b = value(after);
  if (Number.isNaN(a) || Number.isNaN(b) || a === b) return "changed";
  return b < a ? "tightened" : "relaxed";
}

/** The server sends hashed prompt values in impact rows; the UI shows short hashes, never invented text. */
export function impactValueText(value: ImpactRow["before"]): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return value;
}

export function impactTotals(rows: readonly ImpactRow[]): { granted: number; revoked: number; tightened: number; relaxed: number; changed: number } {
  const totals = { granted: 0, revoked: 0, tightened: 0, relaxed: 0, changed: 0 };
  for (const row of rows) totals[describeImpact(row).direction]++;
  return totals;
}
