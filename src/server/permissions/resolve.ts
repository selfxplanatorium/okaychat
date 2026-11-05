import { FEATURE_KEYS, resolvePolicy, type FeatureKey, type ResolvedPolicy } from "../../shared/permissions.js";
import { currentRevision } from "./audit.js";
import { layersFor } from "./store.js";

// The live account policy of one user for one model. No cache across requests: a resolution is a handful of
// indexed reads, and every dispatch must see the latest revision.

export interface EffectivePermissions extends ResolvedPolicy {
  revision: number;
  groupIds: string[];
  /** A stored document that applies here failed validation; everything is denied until an admin repairs it. */
  invalid: boolean;
}

export function resolvePermissions(userId: string, modelRef?: string | null): EffectivePermissions {
  const ref = modelRef ?? null;
  const { layers, groupIds, invalid } = layersFor(userId, ref);
  const resolved = resolvePolicy(layers, ref);
  const revision = currentRevision();
  if (!invalid.length) return { ...resolved, revision, groupIds, invalid: false };
  const features = Object.fromEntries(FEATURE_KEYS.map((key) => [key, false])) as Record<FeatureKey, boolean>;
  return { ...resolved, modelAllowed: false, features, revision, groupIds, invalid: true };
}
