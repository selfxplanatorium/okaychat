import type { MiddlewareHandler } from "hono";
import type { FeatureKey } from "../../shared/permissions.js";
import type { AppEnv } from "../auth.js";
import { AppError } from "../errors.js";
import { resolvePermissions, type EffectivePermissions } from "./resolve.js";

// Feature and model checks used by routes, tools, jobs, and the model wrapper. A denial is a 403 that names
// the administrator, so a disabled feature never reads as a broken one.

export const FEATURE_NAMES: Record<FeatureKey, string> = {
  webSearch: "web search",
  webFetch: "web page reading",
  research: "deep research",
  code: "code execution",
  images: "image generation",
  mcp: "MCP servers",
  knowledge: "knowledge",
  memory: "memory",
  schedules: "scheduled prompts",
  sharing: "public sharing",
  temporaryChats: "temporary chats",
  voice: "voice and speech",
  email: "email",
  artifacts: "artifacts and documents",
  generativeUI: "interactive widgets",
  delegation: "delegation",
  skills: "skills",
  evaluations: "evaluations",
  channels: "team channels",
  customTools: "custom tools",
  notes: "notes",
  calendar: "calendar",
  apiAccess: "external API access",
};

export interface Actor {
  userId: string;
  modelRef?: string | null;
  /** A delegate or research worker: the parent's features, which the child can never exceed. */
  parentFeatures?: Readonly<Record<FeatureKey, boolean>>;
}

export function policyInvalidError(): AppError {
  return new AppError({ code: "forbidden", status: 503, message: "An administrator must repair this account's permission policy.", details: { reason: "policy_invalid" } });
}

export function featureDeniedError(feature: FeatureKey): AppError {
  return new AppError({
    code: "forbidden",
    message: `Your administrator has disabled ${FEATURE_NAMES[feature]} for this account.`,
    hint: "Ask an administrator to allow it.",
    details: { feature },
  });
}

export function modelDeniedError(ref: string): AppError {
  return new AppError({
    code: "forbidden",
    message: `Your administrator has not allowed ${ref} for this account.`,
    hint: "Pick another model or ask an administrator.",
    model: ref,
    details: { modelRef: ref },
  });
}

export function featureAllowed(actor: Actor | string, feature: FeatureKey, permissions?: EffectivePermissions): boolean {
  const resolved = typeof actor === "string" ? { userId: actor } : actor;
  const effective = permissions ?? resolvePermissions(resolved.userId, resolved.modelRef);
  if (effective.invalid) return false;
  if (resolved.parentFeatures && !resolved.parentFeatures[feature]) return false;
  return effective.features[feature];
}

/** Throws a 403 (or 503 for a broken stored policy) unless the feature is allowed for this actor. */
export function assertFeature(actor: Actor | string, feature: FeatureKey): void {
  const resolved = typeof actor === "string" ? { userId: actor } : actor;
  const effective = resolvePermissions(resolved.userId, resolved.modelRef);
  if (effective.invalid) throw policyInvalidError();
  if (!featureAllowed(resolved, feature, effective)) throw featureDeniedError(feature);
}

export function modelAllowed(userId: string, ref: string): boolean {
  const effective = resolvePermissions(userId, ref);
  return !effective.invalid && effective.modelAllowed;
}

export function assertModelAllowed(userId: string, ref: string): EffectivePermissions {
  const effective = resolvePermissions(userId, ref);
  if (effective.invalid) throw policyInvalidError();
  if (!effective.modelAllowed) throw modelDeniedError(ref);
  return effective;
}

/** Route guard for management endpoints: all-model account decision, never a client-supplied model. */
export function requireFeature(feature: FeatureKey): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    try {
      assertFeature(c.get("user").id, feature);
    } catch (error) {
      if (error instanceof AppError) return c.json({ error: error.message, code: error.code, details: error.details }, error.status as 403 | 503);
      throw error;
    }
    await next();
  };
}
