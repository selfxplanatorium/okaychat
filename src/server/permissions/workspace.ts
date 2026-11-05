import {
  BUCKET_LIMITS,
  DEFAULT_LIMITS,
  FEATURE_DEPENDENCIES,
  FEATURE_KEYS,
  HARD_CAPS,
  LIMIT_BOUNDS,
  LIMIT_KEYS,
  applyPromptRule,
  canonicalDocument,
  canonicalJson,
  isBucketLimit,
  resolvePolicy,
  sourceId,
  validModelRef,
  type Change,
  type FeatureKey,
  type FieldResolution,
  type InspectionInput,
  type LimitKey,
  type PolicyLayer,
  type PolicyRow,
  type PromptRule,
  type PromptRuleValue,
  type ResolvedPolicy,
  type SelfPermissions,
  type SourceValue,
  type Subject,
} from "../../shared/permissions.js";
import type { AdminPrompt, PromptKey, ShareAudience } from "../../shared/types.js";
import { getOwnConnection, getSharedConnection, listModels, listProviders, listSharedModels } from "../catalog/providers.js";
import { sha256 } from "../crypto.js";
import { db, tx } from "../db.js";
import { getModelAccessPolicy, listModelAccessPolicies, providerAudienceTargets, setModelAccessPolicies, sharedModelAccess } from "../entitlements.js";
import { AppError } from "../errors.js";
import { getAudience, setAudience, type ShareKind } from "../groups.js";
import { getModelInstruction, listModelInstructionRefs, setModelInstruction, type ModelInstruction, type PromptSource } from "../prompt-policy.js";
import { compiledPrompt, fillPrompt, listPrompts, PROMPT_KEYS, setPrompt } from "../prompts.js";
import { resolvePermissions } from "./resolve.js";
import { AUDIT_RETENTION_DAYS, currentRevision, getAuditDetail, listAudit, recordRevision, type AuditEntry, type AuditKind, type AuditRow } from "./audit.js";
import { parseStoredDocument } from "./schema.js";
import {
  getPolicy,
  getPromptRule,
  listPolicies,
  listPromptRules,
  storedModelRefs,
  writePolicy,
  writePromptRule,
} from "./store.js";
import { getThread } from "../threads.js";

// Admin policy workspace services (docs/implementation/granular-permissions.md §7). Preview builds an
// immutable in-memory draft and never writes; commit revalidates revision, normalized draft hash, catalog
// fingerprint, subjects, and the live admin role inside one transaction before applying anything.

export interface CatalogProviderRow {
  id: string;
  name: string;
  connected: boolean;
  enabled: boolean;
  shared: boolean;
  modelCount: number;
}

export interface CatalogStatusRow {
  providerId: string;
  state: "ready" | "stale" | "unavailable";
  checkedAt: number;
}

export interface CatalogModelRow {
  ref: string;
  providerId: string;
  id: string;
  name: string;
  context?: number;
  maxOutput?: number;
  stored: boolean;
  present: boolean;
}

export interface CatalogSnapshot {
  /** Current server-shared catalog refs. Stored selectors are not included here. */
  currentRefs: string[];
  storedRefs: string[];
  /** Union of current and stored refs, for display. */
  refs: string[];
  models: CatalogModelRow[];
  providers: CatalogProviderRow[];
  status: CatalogStatusRow[];
  fingerprint: string;
}

export interface UserCatalog {
  refs: string[];
  unavailable: boolean;
}

export interface CatalogSource {
  snapshot(): Promise<CatalogSnapshot>;
  userRefs(userId: string): Promise<UserCatalog>;
}

export function makeCatalogFingerprint(currentRefs: string[], storedRefs: string[], status: CatalogStatusRow[]): string {
  return sha256(
    canonicalJson({
      current: [...new Set(currentRefs)].sort(),
      stored: [...new Set(storedRefs)].sort(),
      status: [...status].sort((a, b) => a.providerId.localeCompare(b.providerId)),
    }),
  ).slice(0, 32);
}

const providerOf = (ref: string) => ref.slice(0, ref.indexOf("/"));
const modelOf = (ref: string) => ref.slice(ref.indexOf("/") + 1);

async function defaultSnapshot(): Promise<CatalogSnapshot> {
  const checkedAt = Date.now();
  const storedRefs = storedModelRefs().sort();
  const sharedIds = (db.prepare("SELECT provider_id FROM shared_connections ORDER BY provider_id").all() as Array<{ provider_id: string }>).map(
    (row) => row.provider_id,
  );
  let providers: CatalogProviderRow[] = [];
  try {
    providers = (await listProviders(null)).map((provider) => ({
      id: provider.id,
      name: provider.name,
      connected: provider.connected,
      enabled: provider.enabled,
      shared: provider.shared,
      modelCount: provider.modelCount,
    }));
  } catch {
    // The catalog being unreachable is reported per provider below; it is never treated as an empty catalog.
  }
  const current = new Set<string>();
  const models: CatalogModelRow[] = [];
  const status: CatalogStatusRow[] = [];
  for (const providerId of sharedIds) {
    try {
      const list = await listSharedModels(providerId);
      for (const model of list) {
        current.add(model.ref);
        models.push({
          ref: model.ref,
          providerId: model.providerId,
          id: model.id,
          name: model.name,
          context: model.context,
          maxOutput: model.maxOutput,
          stored: storedRefs.includes(model.ref),
          present: true,
        });
      }
      const stale = storedRefs.some((ref) => providerOf(ref) === providerId && !current.has(ref));
      status.push({ providerId, state: stale ? "stale" : "ready", checkedAt });
    } catch {
      status.push({ providerId, state: "unavailable", checkedAt });
    }
  }
  for (const ref of storedRefs) {
    const providerId = providerOf(ref);
    if (!status.some((row) => row.providerId === providerId)) status.push({ providerId, state: "stale", checkedAt });
    if (!current.has(ref)) models.push({ ref, providerId, id: modelOf(ref), name: modelOf(ref), stored: true, present: false });
  }
  const currentRefs = [...current].sort();
  return {
    currentRefs,
    storedRefs,
    refs: [...new Set([...currentRefs, ...storedRefs])].sort(),
    models: models.sort((a, b) => a.ref.localeCompare(b.ref)),
    providers,
    status: status.sort((a, b) => a.providerId.localeCompare(b.providerId)),
    fingerprint: makeCatalogFingerprint(currentRefs, storedRefs, status),
  };
}

async function defaultUserRefs(userId: string): Promise<UserCatalog> {
  try {
    return { refs: (await listModels(userId)).map((model) => model.ref), unavailable: false };
  } catch {
    return { refs: [], unavailable: true };
  }
}

export const defaultCatalogSource: CatalogSource = { snapshot: defaultSnapshot, userRefs: defaultUserRefs };

// ---------------------------------------------------------------------------------------------------
// In-memory draft state

interface PromptStateRow {
  subject: Subject;
  modelRef: string | null;
  key: PromptKey;
  rule: PromptRuleValue;
}

interface WorkspaceState {
  users: Array<{ id: string; name: string; email: string; role: "admin" | "user" }>;
  groups: Array<{ id: string; name: string; promptOrder: number | null }>;
  memberships: Map<string, Set<string>>;
  policies: Map<string, PolicyLayer>;
  invalidPolicies: Array<{ subject: Subject; modelRef: string | null }>;
  prompts: Map<string, PromptStateRow>;
  serverPrompts: Map<PromptKey, string | null>;
  audiences: Map<string, ShareAudience>;
  entitlements: Map<string, Array<{ target: Subject; mode: "all" | "selected"; modelIds: string[] }>>;
  groupOrder: Map<string, number | null>;
}

const policyKey = (subject: Subject, modelRef: string | null) => `${subject.kind}:${subject.id}:${modelRef ?? ""}`;
const promptKey = (subject: Subject, modelRef: string | null, key: PromptKey) => `${subject.kind}:${subject.id}:${modelRef ?? ""}:${key}`;
const audienceKey = (kind: ShareKind, id: string) => `${kind}:${id}`;
const targetKey = (target: Subject) => `${target.kind}:${target.id}`;

function readState(): WorkspaceState {
  const users = db.prepare("SELECT id, name, email, role FROM users ORDER BY id").all() as Array<{
    id: string;
    name: string;
    email: string;
    role: "admin" | "user";
  }>;
  const groups = db.prepare("SELECT id, name, prompt_order FROM user_groups ORDER BY id").all() as Array<{
    id: string;
    name: string;
    prompt_order: number | null;
  }>;
  const memberships = new Map<string, Set<string>>();
  for (const group of groups) memberships.set(group.id, new Set());
  for (const row of db.prepare("SELECT group_id, user_id FROM user_group_members").all() as Array<{ group_id: string; user_id: string }>) {
    memberships.get(row.group_id)?.add(row.user_id);
  }

  const policies = new Map<string, PolicyLayer>();
  const invalidPolicies: Array<{ subject: Subject; modelRef: string | null }> = [];
  for (const row of db
    .prepare("SELECT subject_kind, subject_id, model_ref, document FROM permission_policies")
    .all() as Array<{ subject_kind: Subject["kind"]; subject_id: string; model_ref: string; document: string }>) {
    const subject: Subject = { kind: row.subject_kind, id: row.subject_id };
    const modelRef = row.model_ref === "" ? null : row.model_ref;
    try {
      policies.set(policyKey(subject, modelRef), { subject, modelRef, document: parseStoredDocument(row.document) });
    } catch {
      invalidPolicies.push({ subject, modelRef });
    }
  }

  const prompts = new Map<string, PromptStateRow>();
  const known = new Set<string>(PROMPT_KEYS);
  for (const row of db
    .prepare("SELECT subject_kind, subject_id, model_ref, prompt_key, mode, text FROM prompt_rules")
    .all() as Array<{ subject_kind: Subject["kind"]; subject_id: string; model_ref: string; prompt_key: string; mode: "replace" | "append"; text: string }>) {
    if (!known.has(row.prompt_key)) continue;
    const subject: Subject = { kind: row.subject_kind, id: row.subject_id };
    const modelRef = row.model_ref === "" ? null : row.model_ref;
    const key = row.prompt_key as PromptKey;
    prompts.set(promptKey(subject, modelRef, key), { subject, modelRef, key, rule: { mode: row.mode, text: row.text } });
  }

  const serverPrompts = new Map<PromptKey, string | null>(listPrompts().map((prompt) => [prompt.key, prompt.value]));

  const audiences = new Map<string, ShareAudience>();
  for (const row of db.prepare("SELECT kind, resource_id FROM share_audiences").all() as Array<{ kind: ShareKind; resource_id: string }>) {
    const userIds = (db.prepare("SELECT user_id FROM share_users WHERE kind = ? AND resource_id = ? ORDER BY user_id").all(row.kind, row.resource_id) as Array<{ user_id: string }>).map(
      (item) => item.user_id,
    );
    const groupIds = (db.prepare("SELECT group_id FROM share_groups WHERE kind = ? AND resource_id = ? ORDER BY group_id").all(row.kind, row.resource_id) as Array<{ group_id: string }>).map(
      (item) => item.group_id,
    );
    audiences.set(audienceKey(row.kind, row.resource_id), { mode: "selected", userIds, groupIds });
  }

  const entitlements = new Map<string, Array<{ target: Subject; mode: "all" | "selected"; modelIds: string[] }>>();
  for (const row of db.prepare("SELECT provider_id FROM shared_connections").all() as Array<{ provider_id: string }>) {
    entitlements.set(row.provider_id, listModelAccessPolicies(row.provider_id));
  }

  return {
    users,
    groups: groups.map((group) => ({ id: group.id, name: group.name, promptOrder: group.prompt_order })),
    memberships,
    policies,
    invalidPolicies,
    prompts,
    serverPrompts,
    audiences,
    entitlements,
    groupOrder: new Map(groups.map((group) => [group.id, group.prompt_order])),
  };
}

function appliesToUser(state: WorkspaceState, subject: Subject, userId: string): boolean {
  if (subject.kind === "everyone") return true;
  if (subject.kind === "user") return subject.id === userId;
  return !!state.memberships.get(subject.id)?.has(userId);
}

function groupIdsFor(state: WorkspaceState, userId: string): string[] {
  return [...state.memberships.entries()].filter(([, users]) => users.has(userId)).map(([id]) => id).sort();
}

function resolveState(state: WorkspaceState, userId: string, modelRef: string | null): ResolvedPolicy & { invalid: boolean } {
  const layers: PolicyLayer[] = [];
  for (const layer of state.policies.values()) {
    if (layer.modelRef !== null && layer.modelRef !== modelRef) continue;
    if (!appliesToUser(state, layer.subject, userId)) continue;
    layers.push(layer);
  }
  const invalid = state.invalidPolicies.some(
    (row) => (row.modelRef === null || row.modelRef === modelRef) && appliesToUser(state, row.subject, userId),
  );
  const resolved = resolvePolicy(layers, modelRef);
  if (!invalid) return { ...resolved, invalid: false };
  const features = Object.fromEntries(FEATURE_KEYS.map((key) => [key, false])) as Record<FeatureKey, boolean>;
  return { ...resolved, modelAllowed: false, features, invalid: true };
}

function promptStateFor(
  state: WorkspaceState,
  userId: string,
  modelRef: string,
  key: PromptKey,
): { template: string; layers: PromptSource[]; invalid: boolean } {
  let template = compiledPrompt(key);
  const layers: PromptSource[] = [{ kind: "compiled", modelRef: null, mode: "default", text: compiledPrompt(key), order: 0, applied: true }];
  const server = state.serverPrompts.get(key) ?? null;
  if (server !== null) {
    layers.push({ kind: "server", modelRef: null, mode: "replace", text: server, order: 0, applied: true });
    template = server;
  }
  const rows = [...state.prompts.values()].filter(
    (row) => row.key === key && (row.modelRef === null || row.modelRef === modelRef) && appliesToUser(state, row.subject, userId),
  );
  const rank = (kind: Subject["kind"]) => (kind === "everyone" ? 0 : kind === "group" ? 1 : 2);
  const orderOf = (row: PromptStateRow) => (row.subject.kind === "group" ? state.groupOrder.get(row.subject.id) ?? -1 : 0);
  let invalid = false;
  rows.sort(
    (a, b) =>
      rank(a.subject.kind) - rank(b.subject.kind) ||
      orderOf(a) - orderOf(b) ||
      Number(a.modelRef !== null) - Number(b.modelRef !== null),
  );
  for (const row of rows) {
    if (row.subject.kind === "group" && !Number.isSafeInteger(orderOf(row))) invalid = true;
    template = applyPromptRule(template, row.rule);
    layers.push({
      kind: row.subject.kind,
      ...(row.subject.kind === "everyone" ? {} : { subjectId: row.subject.id }),
      modelRef: row.modelRef,
      mode: row.rule.mode,
      text: row.rule.text,
      order: orderOf(row),
      applied: true,
    });
  }
  const lastReplace = layers.findLastIndex((layer) => layer.mode === "replace");
  for (let index = 0; index < lastReplace; index++) layers[index]!.applied = false;
  return { template, layers, invalid };
}

function normalizeAudience(audience: ShareAudience): ShareAudience {
  if (audience.mode === "all") return { mode: "all", userIds: [], groupIds: [] };
  return {
    mode: "selected",
    userIds: [...new Set(audience.userIds)].sort(),
    groupIds: [...new Set(audience.groupIds)].sort(),
  };
}

function normalizeChange(change: Change): Change {
  switch (change.kind) {
    case "policy":
      return { ...change, document: change.document ? canonicalDocument(change.document) : null };
    case "prompt":
      return { ...change, rule: change.rule ? { mode: change.rule.mode, text: change.rule.text.replace(/\r\n?/g, "\n") } : null };
    case "serverPrompt":
      return { ...change, value: change.value === compiledPrompt(change.key) ? null : change.value };
    case "providerAudience":
      return { ...change, audience: normalizeAudience(change.audience) };
    case "providerEntitlements":
      return {
        ...change,
        policies: change.policies
          .map((policy) => ({
            target: policy.target,
            mode: policy.mode,
            modelIds: policy.mode === "all" ? [] : [...new Set(policy.modelIds)].sort(),
          }))
          .sort((a, b) => targetKey(a.target).localeCompare(targetKey(b.target))),
      };
    case "mcpAudience":
      return { ...change, audience: normalizeAudience(change.audience) };
    case "groupOrder":
      return { ...change, groupIds: [...change.groupIds] };
    case "membership":
      return { ...change, userIds: [...new Set(change.userIds)].sort() };
  }
}

function currentGroupOrder(): string[] {
  return (db.prepare("SELECT id FROM user_groups ORDER BY prompt_order, id").all() as Array<{ id: string }>).map((row) => row.id);
}

function currentMembers(groupId: string): string[] {
  return (db.prepare("SELECT user_id FROM user_group_members WHERE group_id = ? ORDER BY user_id").all(groupId) as Array<{ user_id: string }>).map(
    (row) => row.user_id,
  );
}

function serverOverrideValue(key: PromptKey): string | null {
  return listPrompts().find((prompt) => prompt.key === key)?.value ?? null;
}

function isNoOp(change: Change): boolean {
  switch (change.kind) {
    case "policy":
      return canonicalJson(getPolicy(change.subject, change.modelRef)) === canonicalJson(change.document);
    case "prompt":
      return canonicalJson(getPromptRule(change.subject, change.modelRef, change.key)) === canonicalJson(change.rule);
    case "serverPrompt":
      return serverOverrideValue(change.key) === change.value;
    case "providerAudience":
      return canonicalJson(getAudience("provider", change.providerId)) === canonicalJson(change.audience);
    case "providerEntitlements":
      return change.policies.every(
        (policy) => canonicalJson(getModelAccessPolicy(change.providerId, policy.target)) === canonicalJson(policy),
      );
    case "mcpAudience":
      return canonicalJson(getAudience("mcp", change.serverId)) === canonicalJson(change.audience);
    case "groupOrder":
      return currentGroupOrder().join("\u0000") === change.groupIds.join("\u0000");
    case "membership":
      return currentMembers(change.groupId).join("\u0000") === change.userIds.join("\u0000");
  }
}

function normalizeChanges(changes: Change[]): Change[] {
  const normalized = changes.map(normalizeChange);
  const seen = new Set<string>();
  for (const change of normalized) {
    const destination = changeDestination(change);
    if (seen.has(destination)) {
      throw new AppError({
        code: "validation",
        status: 400,
        message: "Two changes write the same destination.",
        details: { field: "changes", destination },
      });
    }
    seen.add(destination);
  }
  return normalized.sort((a, b) => changeDestination(a).localeCompare(changeDestination(b)));
}

/** Removes normalized no-ops only after structural validation, so a missing subject is still a 404. */
function dropNoOps(changes: Change[]): Change[] {
  return changes.filter((change) => !isNoOp(change));
}

function changeDestination(change: Change): string {
  const subject = "subject" in change ? `${change.subject.kind}:${change.subject.id}` : "";
  switch (change.kind) {
    case "policy":
      return `policy|${subject}|${change.modelRef ?? ""}`;
    case "prompt":
      return `prompt|${subject}|${change.modelRef ?? ""}|${change.key}`;
    case "serverPrompt":
      return `serverPrompt|${change.key}`;
    case "providerAudience":
      return `providerAudience|${change.providerId}`;
    case "providerEntitlements":
      return `providerEntitlements|${change.providerId}`;
    case "mcpAudience":
      return `mcpAudience|${change.serverId}`;
    case "groupOrder":
      return "groupOrder";
    case "membership":
      return `membership|${change.groupId}`;
  }
}

export function draftHashFor(baseRevision: number, changes: Change[]): string {
  return sha256(canonicalJson({ baseRevision, changes }));
}

// ---------------------------------------------------------------------------------------------------
// Validation

function invalidInput(message: string, field?: string, details: Record<string, unknown> = {}): AppError {
  return new AppError({ code: "validation", status: 400, message, details: { ...(field ? { field } : {}), ...details } });
}

function missing(message: string): AppError {
  return new AppError({ code: "not_found", status: 404, message });
}

function stale(revision: number): AppError {
  return new AppError({
    code: "conflict",
    status: 409,
    message: "Permissions changed while you were editing. Reload and try again.",
    details: { reason: "policy_changed", revision },
  });
}

function catalogUnavailable(): AppError {
  return new AppError({
    code: "service_unavailable",
    status: 503,
    message: "The model catalog could not be validated. Try again.",
    details: { reason: "catalog_unavailable" },
  });
}

function policyInvalid(): AppError {
  return new AppError({
    code: "service_unavailable",
    status: 503,
    message: "An administrator must repair this permission policy.",
    details: { reason: "policy_invalid" },
  });
}

function assertSubjectLive(subject: Subject): void {
  if (subject.kind === "everyone") {
    if (subject.id !== "") throw invalidInput("The everyone subject has no id.", "subject");
    return;
  }
  if (!subject.id) throw invalidInput("Choose a subject.", "subject");
  const table = subject.kind === "group" ? "user_groups" : "users";
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(subject.id)) throw missing("That subject no longer exists.");
}

function assertUsersLive(userIds: string[], field: string): void {
  const exists = db.prepare("SELECT 1 FROM users WHERE id = ?");
  for (const userId of userIds) {
    if (!exists.get(userId)) throw invalidInput("That user no longer exists.", field, { userId });
  }
}

function assertGroupsLive(groupIds: string[], field: string): void {
  const exists = db.prepare("SELECT 1 FROM user_groups WHERE id = ?");
  for (const groupId of groupIds) {
    if (!exists.get(groupId)) throw invalidInput("That group no longer exists.", field, { groupId });
  }
}

function assertAudienceLive(audience: ShareAudience, field: string): void {
  assertUsersLive(audience.userIds, field);
  assertGroupsLive(audience.groupIds, field);
}

function groupMembers(groupId: string): string[] {
  return currentMembers(groupId);
}

function allUserIds(): string[] {
  return (db.prepare("SELECT id FROM users ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
}

function configuredUserIds(): string[] {
  return (
    db.prepare("SELECT DISTINCT user_id FROM provider_connections ORDER BY user_id").all() as Array<{ user_id: string }>
  ).map((row) => row.user_id);
}

function audienceTargets(audience: ShareAudience): Subject[] {
  if (audience.mode === "all") return [{ kind: "everyone", id: "" }];
  return [
    ...audience.userIds.map((id): Subject => ({ kind: "user", id })),
    ...audience.groupIds.map((id): Subject => ({ kind: "group", id })),
  ];
}

function audienceIncludesUser(audience: ShareAudience, userId: string): boolean {
  if (audience.mode === "all") return true;
  if (audience.userIds.includes(userId)) return true;
  return audience.groupIds.some((groupId) => !!db.prepare("SELECT 1 FROM user_group_members WHERE group_id = ? AND user_id = ?").get(groupId, userId));
}

function policyRowExists(subject: Subject, modelRef: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM permission_policies WHERE subject_kind = ? AND subject_id = ? AND model_ref = ?")
    .get(subject.kind, subject.id, modelRef);
}

function promptRowExists(subject: Subject, modelRef: string, key: PromptKey): boolean {
  return !!db
    .prepare("SELECT 1 FROM prompt_rules WHERE subject_kind = ? AND subject_id = ? AND model_ref = ? AND prompt_key = ?")
    .get(subject.kind, subject.id, modelRef, key);
}

async function assertExactRefAllowed(
  subject: Subject,
  modelRef: string,
  existing: boolean,
  snapshot: CatalogSnapshot,
  catalog: CatalogSource,
): Promise<void> {
  if (existing) return;
  if (snapshot.currentRefs.includes(modelRef)) return;
  if (subject.kind === "user") {
    const catalogForUser = await catalog.userRefs(subject.id);
    if (catalogForUser.refs.includes(modelRef)) return;
    if (catalogForUser.unavailable) throw catalogUnavailable();
  } else {
    const userIds = subject.kind === "group" ? groupMembers(subject.id) : configuredUserIds();
    let unavailable = false;
    for (const userId of userIds) {
      const catalogForUser = await catalog.userRefs(userId);
      if (catalogForUser.refs.includes(modelRef)) return;
      if (catalogForUser.unavailable) unavailable = true;
    }
    if (unavailable) throw catalogUnavailable();
  }
  const providerId = providerOf(modelRef);
  if (snapshot.status.find((row) => row.providerId === providerId)?.state === "unavailable") throw catalogUnavailable();
  throw invalidInput("That model is not in the current catalog.", "modelRef", { modelRef });
}

function validateStructural(changes: Change[]): void {
  for (const change of changes) {
    switch (change.kind) {
      case "policy":
        assertSubjectLive(change.subject);
        break;
      case "prompt":
        assertSubjectLive(change.subject);
        if (change.subject.kind === "everyone" && change.modelRef === null) {
          throw invalidInput("Use a server prompt for the everyone/all-model prompt.", "modelRef");
        }
        break;
      case "serverPrompt":
        break;
      case "providerAudience":
        if (!getSharedConnection(change.providerId)) throw missing("That provider connection no longer exists.");
        assertAudienceLive(change.audience, "audience");
        break;
      case "providerEntitlements": {
        if (!getSharedConnection(change.providerId)) throw missing("That provider connection no longer exists.");
        const seen = new Set<string>();
        for (const policy of change.policies) {
          if (policy.target.kind === "everyone" ? policy.target.id !== "" : policy.target.id === "") {
            throw invalidInput("Choose an audience and a model policy.", "policies");
          }
          const key = targetKey(policy.target);
          if (seen.has(key)) throw invalidInput("Each audience can appear only once.", "policies");
          seen.add(key);
          if (policy.target.kind !== "everyone") assertSubjectLive(policy.target);
        }
        break;
      }
      case "mcpAudience":
        if (!db.prepare("SELECT 1 FROM mcp_servers WHERE id = ?").get(change.serverId)) throw missing("That MCP server no longer exists.");
        assertAudienceLive(change.audience, "audience");
        break;
      case "groupOrder": {
        const live = (db.prepare("SELECT id FROM user_groups ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
        if (change.groupIds.length !== live.length || new Set(change.groupIds).size !== live.length) {
          throw invalidInput("Group order must list every group exactly once.", "groupIds");
        }
        const known = new Set(live);
        for (const id of change.groupIds) if (!known.has(id)) throw invalidInput("Group order includes an unknown group.", "groupIds");
        break;
      }
      case "membership":
        if (!db.prepare("SELECT 1 FROM user_groups WHERE id = ?").get(change.groupId)) throw missing("That group no longer exists.");
        assertUsersLive(change.userIds, "userIds");
        break;
    }
  }
}

async function validateCatalog(changes: Change[], snapshot: CatalogSnapshot, catalog: CatalogSource): Promise<void> {
  const audienceChanges = new Map<string, ShareAudience>();
  for (const change of changes) {
    if (change.kind === "providerAudience") audienceChanges.set(change.providerId, change.audience);
  }
  for (const change of changes) {
    switch (change.kind) {
      case "policy":
        if (change.modelRef !== null) {
          await assertExactRefAllowed(change.subject, change.modelRef, policyRowExists(change.subject, change.modelRef), snapshot, catalog);
        }
        break;
      case "prompt":
        if (change.modelRef !== null) {
          await assertExactRefAllowed(
            change.subject,
            change.modelRef,
            promptRowExists(change.subject, change.modelRef, change.key),
            snapshot,
            catalog,
          );
        }
        break;
      case "providerEntitlements": {
        const postAudience = audienceChanges.get(change.providerId) ?? getAudience("provider", change.providerId);
        const targets = new Set(audienceTargets(postAudience).map(targetKey));
        const current = new Map(listModelAccessPolicies(change.providerId).map((policy) => [targetKey(policy.target), policy]));
        const seen = new Set<string>();
        const models = new Set(snapshot.models.filter((model) => model.providerId === change.providerId && model.present).map((model) => model.id));
        const status = snapshot.status.find((row) => row.providerId === change.providerId)?.state;
        for (const policy of change.policies) {
          const key = targetKey(policy.target);
          if (!targets.has(key)) throw invalidInput("That audience is no longer part of this connection.", "policies");
          if (seen.has(key)) throw invalidInput("Each audience can appear only once.", "policies");
          seen.add(key);
          if (policy.mode === "selected") {
            const kept = new Set(current.get(key)?.modelIds ?? []);
            for (const modelId of policy.modelIds) {
              if (kept.has(modelId) || models.has(modelId)) continue;
              if (status === "unavailable") throw catalogUnavailable();
              throw invalidInput(`Model ${modelId} is not available from ${change.providerId}.`, "policies", {
                modelRef: `${change.providerId}/${modelId}`,
              });
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Impact

export interface PreviewFilter {
  userIds?: string[];
  groupIds?: string[];
  modelRefs?: string[];
}

export interface ImpactRow {
  userId: string;
  modelRef: string | null;
  path: string;
  before: boolean | number | string | null;
  after: boolean | number | string | null;
  beforeSources: string[];
  afterSources: string[];
}

export interface ImpactCounts {
  usersAffected: number;
  modelsAffected: number;
  grantsAdded: number;
  grantsRemoved: number;
  featuresChanged: number;
  limitsTightened: number;
  limitsRelaxed: number;
  promptsChanged: number;
}

interface ImpactResult {
  counts: ImpactCounts;
  rows: ImpactRow[];
  affectedUserIds: string[];
}

const sourceIdsFor = (resolution: FieldResolution | undefined): string[] => resolution?.winnerSourceIds ?? [];
const promptSourceIds = (layers: PromptSource[]): string[] =>
  layers
    .filter((layer) => layer.applied && layer.kind !== "compiled" && layer.kind !== "server")
    .map((layer) => sourceId(layer.kind as "everyone" | "group" | "user", layer.subjectId ?? "", layer.modelRef, "prompt"));

function addSubjectUsers(state: WorkspaceState, subject: Subject, into: Set<string>) {
  if (subject.kind === "everyone") {
    for (const user of state.users) into.add(user.id);
  } else if (subject.kind === "user") {
    into.add(subject.id);
  } else {
    for (const userId of state.memberships.get(subject.id) ?? []) into.add(userId);
  }
}

function addAudienceUsers(state: WorkspaceState, kind: ShareKind, id: string, into: Set<string>) {
  const audience = state.audiences.get(audienceKey(kind, id)) ?? { mode: "all", userIds: [], groupIds: [] };
  if (audience.mode === "all") {
    for (const user of state.users) into.add(user.id);
    return;
  }
  for (const userId of audience.userIds) into.add(userId);
  for (const groupId of audience.groupIds) {
    for (const userId of state.memberships.get(groupId) ?? []) into.add(userId);
  }
}

function entitlementAllowed(
  state: WorkspaceState,
  userId: string,
  providerId: string,
  modelId: string,
): boolean {
  const policies = state.entitlements.get(providerId) ?? [];
  const matching = policies.filter((policy) => appliesToUser(state, policy.target, userId));
  if (!matching.length) return true;
  if (matching.some((policy) => policy.mode === "all")) return true;
  return matching.some((policy) => policy.modelIds.includes(modelId));
}

function compareImpact(before: WorkspaceState, after: WorkspaceState, changes: Change[]): ImpactResult {
  const affected = new Set<string>();
  const allUsers = before.users.map((user) => user.id);
  const selectors = new Set<string | null>([null]);
  const promptKeys = new Set<PromptKey>();
  for (const change of changes) {
    switch (change.kind) {
      case "policy":
      case "prompt":
        addSubjectUsers(before, change.subject, affected);
        addSubjectUsers(after, change.subject, affected);
        if (change.modelRef !== null) selectors.add(change.modelRef);
        if (change.kind === "prompt") promptKeys.add(change.key);
        break;
      case "serverPrompt":
        for (const id of allUsers) affected.add(id);
        promptKeys.add(change.key);
        break;
      case "providerAudience":
        addAudienceUsers(before, "provider", change.providerId, affected);
        addAudienceUsers(after, "provider", change.providerId, affected);
        break;
      case "providerEntitlements":
        for (const policy of change.policies) {
          addSubjectUsers(before, policy.target, affected);
          addSubjectUsers(after, policy.target, affected);
          for (const modelId of policy.modelIds) selectors.add(`${change.providerId}/${modelId}`);
        }
        break;
      case "mcpAudience":
        addAudienceUsers(before, "mcp", change.serverId, affected);
        addAudienceUsers(after, "mcp", change.serverId, affected);
        break;
      case "groupOrder":
        for (const id of allUsers) affected.add(id);
        break;
      case "membership": {
        for (const userId of before.memberships.get(change.groupId) ?? []) affected.add(userId);
        for (const userId of after.memberships.get(change.groupId) ?? []) affected.add(userId);
        break;
      }
    }
  }
  for (const layer of before.policies.values()) if (layer.modelRef !== null) selectors.add(layer.modelRef);
  for (const layer of after.policies.values()) if (layer.modelRef !== null) selectors.add(layer.modelRef);
  for (const row of before.prompts.values()) {
    promptKeys.add(row.key);
    if (row.modelRef !== null) selectors.add(row.modelRef);
  }
  for (const row of after.prompts.values()) {
    promptKeys.add(row.key);
    if (row.modelRef !== null) selectors.add(row.modelRef);
  }
  for (const change of changes) if (change.kind === "policy" || change.kind === "prompt") if (change.modelRef) selectors.add(change.modelRef);

  const rows = new Map<string, ImpactRow>();
  const addRow = (row: ImpactRow) => {
    const key = `${row.userId}|${row.modelRef ?? "*"}|${row.path}`;
    rows.set(key, row);
  };
  const selectorsSorted = [...selectors].sort((a, b) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)));

  for (const userId of [...affected].sort()) {
    for (const selector of selectorsSorted) {
      const beforeRes = resolveState(before, userId, selector);
      const afterRes = resolveState(after, userId, selector);
      // A stored document that is already broken fails closed in `before`; a broken draft is rejected.
      if (afterRes.invalid) throw policyInvalid();
      if (beforeRes.modelAllowed !== afterRes.modelAllowed) {
        addRow({
          userId,
          modelRef: selector,
          path: "modelAllowed",
          before: beforeRes.modelAllowed,
          after: afterRes.modelAllowed,
          beforeSources: sourceIdsFor(beforeRes.provenance.modelAllowed),
          afterSources: sourceIdsFor(afterRes.provenance.modelAllowed),
        });
      }
      for (const feature of FEATURE_KEYS) {
        if (beforeRes.features[feature] === afterRes.features[feature]) continue;
        addRow({
          userId,
          modelRef: selector,
          path: `features.${feature}`,
          before: beforeRes.features[feature],
          after: afterRes.features[feature],
          beforeSources: sourceIdsFor(beforeRes.provenance[`features.${feature}`]),
          afterSources: sourceIdsFor(afterRes.provenance[`features.${feature}`]),
        });
      }
      for (const limit of LIMIT_KEYS) {
        const beforeValue = beforeRes.limits[limit];
        const afterValue = afterRes.limits[limit];
        if (Object.is(beforeValue, afterValue)) continue;
        addRow({
          userId,
          modelRef: selector,
          path: `limits.${limit}`,
          before: beforeValue,
          after: afterValue,
          beforeSources: sourceIdsFor(beforeRes.provenance[`limits.${limit}`]),
          afterSources: sourceIdsFor(afterRes.provenance[`limits.${limit}`]),
        });
      }
      if (selector !== null) {
        for (const limit of BUCKET_LIMITS) {
          const beforeValue = beforeRes.buckets.model?.[limit] ?? null;
          const afterValue = afterRes.buckets.model?.[limit] ?? null;
          if (Object.is(beforeValue, afterValue)) continue;
          addRow({
            userId,
            modelRef: selector,
            path: `buckets.model.${limit}`,
            before: beforeValue,
            after: afterValue,
            beforeSources: sourceIdsFor(beforeRes.provenance[`buckets.model.${limit}`]),
            afterSources: sourceIdsFor(afterRes.provenance[`buckets.model.${limit}`]),
          });
        }
      }
    }
    for (const key of [...promptKeys].sort()) {
      for (const selector of selectorsSorted) {
        const beforePrompt = promptStateFor(before, userId, selector ?? "", key);
        const afterPrompt = promptStateFor(after, userId, selector ?? "", key);
        if (afterPrompt.invalid) throw policyInvalid();
        if (beforePrompt.template === afterPrompt.template) continue;
        addRow({
          userId,
          modelRef: selector,
          path: `prompts.${key}`,
          before: sha256(beforePrompt.template).slice(0, 16),
          after: sha256(afterPrompt.template).slice(0, 16),
          beforeSources: promptSourceIds(beforePrompt.layers),
          afterSources: promptSourceIds(afterPrompt.layers),
        });
      }
    }
    for (const change of changes) {
      if (change.kind === "providerAudience") {
        const beforeAudience = before.audiences.get(audienceKey("provider", change.providerId)) ?? { mode: "all", userIds: [], groupIds: [] };
        const afterAudience = after.audiences.get(audienceKey("provider", change.providerId)) ?? { mode: "all", userIds: [], groupIds: [] };
        const beforeAllowed = audienceIncludesState(before, beforeAudience, userId);
        const afterAllowed = audienceIncludesState(after, afterAudience, userId);
        if (beforeAllowed !== afterAllowed) {
          addRow({
            userId,
            modelRef: null,
            path: `resource.provider.${change.providerId}.access`,
            before: beforeAllowed,
            after: afterAllowed,
            beforeSources: [sourceId("resource", change.providerId, null, "access")],
            afterSources: [sourceId("resource", change.providerId, null, "access")],
          });
        }
      }
      if (change.kind === "mcpAudience") {
        const beforeAudience = before.audiences.get(audienceKey("mcp", change.serverId)) ?? { mode: "all", userIds: [], groupIds: [] };
        const afterAudience = after.audiences.get(audienceKey("mcp", change.serverId)) ?? { mode: "all", userIds: [], groupIds: [] };
        const beforeAllowed = audienceIncludesState(before, beforeAudience, userId);
        const afterAllowed = audienceIncludesState(after, afterAudience, userId);
        if (beforeAllowed !== afterAllowed) {
          addRow({
            userId,
            modelRef: null,
            path: `resource.mcp.${change.serverId}.access`,
            before: beforeAllowed,
            after: afterAllowed,
            beforeSources: [sourceId("resource", change.serverId, null, "access")],
            afterSources: [sourceId("resource", change.serverId, null, "access")],
          });
        }
      }
      if (change.kind === "providerEntitlements") {
        const modelIds = new Set<string>();
        for (const policy of change.policies) for (const modelId of policy.modelIds) modelIds.add(modelId);
        for (const policy of before.entitlements.get(change.providerId) ?? []) for (const modelId of policy.modelIds) modelIds.add(modelId);
        for (const modelId of modelIds) {
          const beforeAllowed = entitlementAllowed(before, userId, change.providerId, modelId);
          const afterAllowed = entitlementAllowed(after, userId, change.providerId, modelId);
          if (beforeAllowed === afterAllowed) continue;
          addRow({
            userId,
            modelRef: `${change.providerId}/${modelId}`,
            path: `resource.provider.${change.providerId}.models.${modelId}`,
            before: beforeAllowed,
            after: afterAllowed,
            beforeSources: [sourceId("resource", change.providerId, `${change.providerId}/${modelId}`, "model")],
            afterSources: [sourceId("resource", change.providerId, `${change.providerId}/${modelId}`, "model")],
          });
        }
      }
    }
  }

  const sorted = [...rows.values()].sort(
    (a, b) =>
      a.userId.localeCompare(b.userId) ||
      (a.modelRef === null ? -1 : b.modelRef === null ? 1 : a.modelRef.localeCompare(b.modelRef)) ||
      a.path.localeCompare(b.path),
  );
  const counts: ImpactCounts = {
    usersAffected: affected.size,
    modelsAffected: new Set(sorted.map((row) => row.modelRef ?? "*")).size,
    grantsAdded: 0,
    grantsRemoved: 0,
    featuresChanged: 0,
    limitsTightened: 0,
    limitsRelaxed: 0,
    promptsChanged: 0,
  };
  const infinity = (value: boolean | number | string | null) => (typeof value === "number" ? value : value === null ? Number.POSITIVE_INFINITY : NaN);
  for (const row of sorted) {
    if (row.path === "modelAllowed" || row.path.startsWith("resource.")) {
      if (row.before === false && row.after === true) counts.grantsAdded++;
      if (row.before === true && row.after === false) counts.grantsRemoved++;
    }
    if (row.path.startsWith("features.")) counts.featuresChanged++;
    if (row.path.startsWith("limits.") || row.path.startsWith("buckets.model.")) {
      const beforeValue = infinity(row.before);
      const afterValue = infinity(row.after);
      if (afterValue < beforeValue) counts.limitsTightened++;
      if (afterValue > beforeValue) counts.limitsRelaxed++;
    }
    if (row.path.startsWith("prompts.")) counts.promptsChanged++;
  }
  return { counts, rows: sorted, affectedUserIds: [...affected].sort() };
}

function audienceIncludesState(state: WorkspaceState, audience: ShareAudience, userId: string): boolean {
  if (audience.mode === "all") return true;
  if (audience.userIds.includes(userId)) return true;
  return audience.groupIds.some((groupId) => !!state.memberships.get(groupId)?.has(userId));
}

// ---------------------------------------------------------------------------------------------------
// Inspection

export interface InspectionModel {
  ref: string;
  catalogPresent: boolean;
  connection: "own" | "shared" | "none";
}

export interface InspectionPermission {
  effective: boolean | number | null;
  candidates: SourceValue[];
  winnerSourceIds: string[];
  constrainedBy: string[];
}

export interface InspectionPrompt {
  key: PromptKey;
  layers: PromptSource[];
  effectiveTemplate: string;
  filledText: string;
}

export interface Inspection {
  revision: number;
  actor: { id: string; name: string; groupIds: string[] };
  model: InspectionModel | null;
  access: { credentialAllowed: boolean; accountAllowed: boolean; allowed: boolean; reasons: string[] };
  permissions: Record<string, InspectionPermission>;
  prompts: InspectionPrompt[];
  assembly: {
    system1: string;
    system2: string;
    turnContextPreview: string;
    system1Hash: string;
    system2Hash: string;
    estimatedTokens: number;
    estimateMethod: "characters/4";
    dynamicSections: string[];
    warnings: string[];
  };
}

function credentialAllowedFor(state: WorkspaceState, userId: string, modelRef: string): boolean {
  const providerId = providerOf(modelRef);
  const modelId = modelOf(modelRef);
  if (getOwnConnection(userId, providerId)?.enabled) return true;
  if (!getSharedConnection(providerId)) return false;
  const audience = state.audiences.get(audienceKey("provider", providerId)) ?? { mode: "all", userIds: [], groupIds: [] };
  if (!audienceIncludesState(state, audience, userId)) return false;
  return entitlementAllowed(state, userId, providerId, modelId);
}

function inspectionFromState(state: WorkspaceState, snapshot: CatalogSnapshot, input: InspectionInput, revision: number): Inspection {
  const user = state.users.find((row) => row.id === input.userId);
  if (!user) throw missing("That user no longer exists.");
  if (input.threadId && input.temporary) throw invalidInput("Choose a chat or a temporary chat, not both.", "threadId");
  if (input.threadId) {
    const thread = getThread(user.id, input.threadId);
    if (!thread) throw missing("That chat no longer exists.");
  }
  if (input.modelRef !== undefined && !validModelRef(input.modelRef)) throw invalidInput("Use a provider-qualified model id.", "modelRef");
  const modelRef = input.modelRef ?? null;
  const resolved = resolveState(state, user.id, modelRef);
  if (resolved.invalid) throw policyInvalid();

  const sharedVisible = modelRef
    ? audienceIncludesState(
        state,
        state.audiences.get(audienceKey("provider", providerOf(modelRef))) ?? { mode: "all", userIds: [], groupIds: [] },
        user.id,
      )
    : false;
  const model: InspectionModel | null = modelRef
    ? {
        ref: modelRef,
        catalogPresent: snapshot.currentRefs.includes(modelRef),
        connection: getOwnConnection(user.id, providerOf(modelRef))
          ? "own"
          : getSharedConnection(providerOf(modelRef)) && sharedVisible
            ? "shared"
            : "none",
      }
    : null;
  const credentialAllowed = modelRef ? credentialAllowedFor(state, user.id, modelRef) : true;
  const accountAllowed = resolved.modelAllowed;
  const reasons: string[] = [];
  if (!credentialAllowed) reasons.push("resourceDenied");
  if (!accountAllowed) reasons.push("modelOverride");
  if (modelRef && !model?.catalogPresent && !snapshot.storedRefs.includes(modelRef)) reasons.push("missingModel");

  const permissions: Record<string, InspectionPermission> = {};
  for (const [path, resolution] of Object.entries(resolved.provenance)) {
    permissions[path] = {
      effective: resolution.effective,
      candidates: resolution.candidates,
      winnerSourceIds: resolution.winnerSourceIds,
      constrainedBy: resolution.constrainedBy,
    };
  }

  const prompts: InspectionPrompt[] = PROMPT_KEYS.map((key) => {
    const prompt = promptStateFor(state, user.id, modelRef ?? "", key);
    if (prompt.invalid) throw policyInvalid();
    return { key, layers: prompt.layers, effectiveTemplate: prompt.template, filledText: fillPrompt(key, prompt.template) };
  });

  const segment = (key: PromptKey) => promptStateFor(state, user.id, modelRef ?? "", key).template;
  const system1 = [segment("chat"), segment("dataSafety"), fillPrompt("modelIdentity", segment("modelIdentity"), { model: modelRef ?? "the selected model" })]
    .filter(Boolean)
    .join("\n\n");
  let system2 = "";
  if (input.threadId) {
    const row = db.prepare("SELECT custom_instructions FROM threads WHERE user_id = ? AND id = ?").get(user.id, input.threadId) as
      | { custom_instructions: string }
      | undefined;
    system2 = row?.custom_instructions ?? "";
  }
  const warnings = [
    "Token estimates are approximate.",
    "Dynamic per-turn context is not included.",
    "Inspection shows resolved templates, not the full assembled request.",
  ];
  if (!input.threadId) warnings.push("Select a chat to include project instructions and pinned context.");

  return {
    revision,
    actor: { id: user.id, name: user.name, groupIds: groupIdsFor(state, user.id) },
    model,
    access: { credentialAllowed, accountAllowed, allowed: credentialAllowed && accountAllowed, reasons },
    permissions,
    prompts,
    assembly: {
      system1,
      system2,
      turnContextPreview: "",
      system1Hash: sha256(system1),
      system2Hash: sha256(system2),
      estimatedTokens: Math.ceil((system1.length + system2.length) / 4),
      estimateMethod: "characters/4",
      dynamicSections: ["date", "memory", "knowledge", "skills", "voice note"],
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Cursors

function encodeCursor(scope: string, offset: number): string {
  return Buffer.from(JSON.stringify({ s: scope, o: offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined, scope: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { s?: unknown; o?: unknown };
    if (parsed.s !== scope || typeof parsed.o !== "number" || !Number.isSafeInteger(parsed.o) || parsed.o < 0) throw new Error("bad cursor");
    return parsed.o;
  } catch {
    throw invalidInput("The page cursor is no longer valid.", "cursor");
  }
}

// ---------------------------------------------------------------------------------------------------
// Public workspace

export interface BootstrapResponse {
  revision: number;
  registry: {
    features: Array<{ key: FeatureKey; dependencies: FeatureKey[] }>;
    limits: Array<{ key: LimitKey; min: number; max: number; bucket: boolean }>;
    defaults: Record<LimitKey, number | null>;
    hardCaps: Partial<Record<LimitKey, number>>;
  };
  subjects: {
    users: Array<{ id: string; name: string; email: string; role: "admin" | "user" }>;
    groups: Array<{ id: string; name: string; userIds: string[]; promptOrder: number | null }>;
  };
  providers: CatalogProviderRow[];
  modelCatalog: CatalogModelRow[];
  catalogStatus: CatalogStatusRow[];
}

export interface PoliciesResponse {
  revision: number;
  policies: PolicyRow[];
  promptRules: PromptRule[];
  serverPrompts?: AdminPrompt[];
}

export interface PreviewInput {
  baseRevision: number;
  changes: Change[];
  inspect?: InspectionInput;
  filter?: PreviewFilter;
  cursor?: string;
  limit?: number;
}

export interface PreviewResponse {
  baseRevision: number;
  draftHash: string;
  catalogFingerprint: string;
  counts: ImpactCounts;
  rows: ImpactRow[];
  nextCursor: string | null;
  inspection?: Inspection;
}

export interface CommitInput {
  baseRevision: number;
  draftHash: string;
  catalogFingerprint: string;
  changes: Change[];
  reason: string;
}

export interface CommitResponse {
  revision: number;
  summary: ImpactCounts & { changes: number };
  affectedUserIds: string[];
}

export interface WhoCanUseInput {
  resourceKind: "provider" | "mcp" | "model" | "feature";
  resourceId: string;
  modelRef?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface WhoCanUseRow {
  userId: string;
  name: string;
  email: string;
  allowed: boolean;
  reasonKeys: string[];
  sourceRefs: string[];
  availability: "ready" | "unknown" | "unconfigured";
}

export interface WhoCanUseResponse {
  revision: number;
  rows: WhoCanUseRow[];
  counts: { allowed: number; denied: number; unknown: number };
  nextCursor: string | null;
}

export interface AuditListResponse {
  rows: AuditRow[];
  nextCursor: string | null;
  retentionDays: number;
}

export interface AuditDetailResponse extends AuditRow {
  changes: AuditEntry[];
}

export class PermissionWorkspace {
  private readonly catalog: CatalogSource;

  constructor(options: { catalog?: CatalogSource } = {}) {
    this.catalog = options.catalog ?? defaultCatalogSource;
  }

  async bootstrap(): Promise<BootstrapResponse> {
    const snapshot = await this.catalog.snapshot();
    const users = db.prepare("SELECT id, name, email, role FROM users ORDER BY name, id").all() as Array<{
      id: string;
      name: string;
      email: string;
      role: "admin" | "user";
    }>;
    const groups = db.prepare("SELECT id, name, prompt_order FROM user_groups ORDER BY prompt_order, id").all() as Array<{
      id: string;
      name: string;
      prompt_order: number | null;
    }>;
    const members = db.prepare("SELECT group_id, user_id FROM user_group_members").all() as Array<{ group_id: string; user_id: string }>;
    return {
      revision: currentRevision(),
      registry: {
        features: FEATURE_KEYS.map((key) => ({ key, dependencies: [...(FEATURE_DEPENDENCIES[key] ?? [])] })),
        limits: LIMIT_KEYS.map((key) => ({ key, min: LIMIT_BOUNDS[key].min, max: LIMIT_BOUNDS[key].max, bucket: isBucketLimit(key) })),
        defaults: { ...DEFAULT_LIMITS },
        hardCaps: { ...HARD_CAPS },
      },
      subjects: {
        users,
        groups: groups.map((group) => ({
          id: group.id,
          name: group.name,
          userIds: members.filter((member) => member.group_id === group.id).map((member) => member.user_id),
          promptOrder: group.prompt_order,
        })),
      },
      providers: snapshot.providers,
      modelCatalog: snapshot.models,
      catalogStatus: snapshot.status,
    };
  }

  policies(subject: Subject): PoliciesResponse {
    assertSubjectLive(subject);
    return {
      revision: currentRevision(),
      policies: listPolicies(subject),
      promptRules: listPromptRules(subject),
      ...(subject.kind === "everyone" ? { serverPrompts: listPrompts() } : {}),
    };
  }

  async preview(input: PreviewInput): Promise<PreviewResponse> {
    if (input.baseRevision !== currentRevision()) throw stale(currentRevision());
    const snapshot = await this.catalog.snapshot();
    const normalized = normalizeChanges(input.changes);
    validateStructural(normalized);
    const changes = dropNoOps(normalized);
    await validateCatalog(changes, snapshot, this.catalog);
    const draftHash = draftHashFor(input.baseRevision, changes);
    const before = readState();
    const after = readState();
    for (const change of changes) applyChangeToState(after, change);
    const impact = compareImpact(before, after, changes);

    const filter = input.filter;
    const allowedUsers = new Set<string>(filter?.userIds ?? []);
    if (filter?.groupIds?.length) {
      for (const groupId of filter.groupIds) for (const userId of after.memberships.get(groupId) ?? []) allowedUsers.add(userId);
    }
    const modelRefs = filter?.modelRefs ? new Set(filter.modelRefs) : null;
    const filtered = impact.rows.filter((row) => {
      if (allowedUsers.size && !allowedUsers.has(row.userId)) return false;
      if (modelRefs && !modelRefs.has(row.modelRef ?? "")) return false;
      return true;
    });
    const limit = input.limit ?? 50;
    const offset = decodeCursor(input.cursor, draftHash);
    const page = filtered.slice(offset, offset + limit);
    const inspection = input.inspect ? inspectionFromState(after, snapshot, input.inspect, input.baseRevision) : undefined;
    return {
      baseRevision: input.baseRevision,
      draftHash,
      catalogFingerprint: snapshot.fingerprint,
      counts: impact.counts,
      rows: page,
      nextCursor: offset + limit < filtered.length ? encodeCursor(draftHash, offset + limit) : null,
      ...(inspection ? { inspection } : {}),
    };
  }

  async commit(input: CommitInput, adminId: string): Promise<CommitResponse> {
    const reason = input.reason.trim();
    if (!reason || reason.length > 500) throw invalidInput("Enter a reason between 1 and 500 characters.", "reason");
    if (input.baseRevision !== currentRevision()) throw stale(currentRevision());
    const snapshot = await this.catalog.snapshot();
    if (input.catalogFingerprint !== snapshot.fingerprint) throw stale(currentRevision());
    const normalized = normalizeChanges(input.changes);
    validateStructural(normalized);
    const changes = dropNoOps(normalized);
    if (draftHashFor(input.baseRevision, changes) !== input.draftHash) throw stale(currentRevision());
    await validateCatalog(changes, snapshot, this.catalog);
    const before = readState();
    const after = readState();
    for (const change of changes) applyChangeToState(after, change);
    const impact = compareImpact(before, after, changes);

    let revision = currentRevision();
    let applied = 0;
    tx(() => {
      // The role was checked before the body was read; recheck it inside the write transaction so a demotion
      // during awaited validation cannot commit policy.
      const requester = db.prepare("SELECT role FROM users WHERE id = ?").get(adminId) as { role: string } | undefined;
      if (requester?.role !== "admin") {
        throw new AppError({ code: "forbidden", status: 403, message: "Admins only" });
      }
      // Subjects and audience memberships can disappear while validation awaits the catalog.
      for (const change of changes) revalidateLive(change);
      const entries: AuditEntry[] = [];
      for (const change of changes) {
        const entry = applyChange(change, adminId);
        if (entry) entries.push(entry);
      }
      applied = entries.length;
      if (entries.length) {
        revision = recordRevision(auditKindFor(changes), adminId, entries, {
          reason,
          subjects: uniqueSubjects(changes),
        });
      }
    });
    return {
      revision,
      summary: { ...impact.counts, changes: applied },
      affectedUserIds: impact.affectedUserIds,
    };
  }

  async effective(input: InspectionInput): Promise<Inspection> {
    if (!input.userId) throw invalidInput("Choose a user.", "userId");
    const snapshot = await this.catalog.snapshot();
    const state = readState();
    return inspectionFromState(state, snapshot, input, currentRevision());
  }

  async whoCanUse(input: WhoCanUseInput): Promise<WhoCanUseResponse> {
    const snapshot = await this.catalog.snapshot();
    const state = readState();
    const modelRef = input.modelRef ?? null;
    if (modelRef !== null && !validModelRef(modelRef)) throw invalidInput("Use a provider-qualified model id.", "modelRef");
    if (input.resourceKind === "provider" && !getSharedConnection(input.resourceId)) throw missing("That provider connection no longer exists.");
    if (input.resourceKind === "provider" && modelRef !== null && providerOf(modelRef) !== input.resourceId) {
      throw invalidInput("That model does not belong to this provider.", "modelRef");
    }
    if (input.resourceKind === "mcp" && !db.prepare("SELECT 1 FROM mcp_servers WHERE id = ?").get(input.resourceId)) throw missing("That MCP server no longer exists.");
    if (input.resourceKind === "model" && modelRef === null) throw invalidInput("Choose a model.", "modelRef");
    if (input.resourceKind === "feature" && !(FEATURE_KEYS as readonly string[]).includes(input.resourceId)) {
      throw invalidInput("Choose a known feature.", "resourceId");
    }
    if (input.resourceKind === "feature" && modelRef === null && input.resourceId === "") throw invalidInput("Choose a feature.", "resourceId");

    const q = input.q?.trim().toLowerCase() ?? "";
    const users = state.users
      .filter((user) => !q || user.name.toLowerCase().includes(q) || user.email.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const rows: WhoCanUseRow[] = users.map((user) => {
      const resolved = resolveState(state, user.id, modelRef);
      const reasonKeys = new Set<string>();
      const sourceRefs = new Set<string>();
      let allowed = false;
      let availability: WhoCanUseRow["availability"] = "ready";
      if (resolved.invalid) {
        reasonKeys.add("policyInvalid");
        availability = "unknown";
      } else if (input.resourceKind === "feature") {
        const feature = input.resourceId as FeatureKey;
        allowed = resolved.features[feature];
        const resolution = resolved.provenance[`features.${feature}`];
        for (const id of resolution?.winnerSourceIds ?? []) sourceRefs.add(id);
        if (resolution?.constrainedBy.length) reasonKeys.add("dependencyDenied");
        if (!allowed) {
          for (const candidate of resolution?.candidates ?? []) if (candidate.applied) reasonKeys.add(candidate.reasonKey);
          if (!reasonKeys.size) reasonKeys.add("userOverride");
        }
      } else if (input.resourceKind === "mcp") {
        const mcpState = mcpAvailability(state, user.id, input.resourceId);
        const feature = resolved.features.mcp;
        allowed = mcpState.visible && feature;
        sourceRefs.add(sourceId("resource", input.resourceId, modelRef, "access"));
        if (!mcpState.visible) {
          reasonKeys.add("resourceDenied");
          availability = "unconfigured";
        } else if (!mcpState.ready) {
          availability = "unconfigured";
        }
        if (mcpState.visible && !feature) {
          const resolution = resolved.provenance["features.mcp"];
          for (const candidate of resolution?.candidates ?? []) if (candidate.applied) reasonKeys.add(candidate.reasonKey);
          if (!reasonKeys.size) reasonKeys.add("dependencyDenied");
        }
        if (!allowed && !reasonKeys.size) reasonKeys.add("userOverride");
      } else if (input.resourceKind === "provider") {
        const access = sharedModelAccess(user.id, input.resourceId);
        const audience = state.audiences.get(audienceKey("provider", input.resourceId)) ?? { mode: "all", userIds: [], groupIds: [] };
        const visible = audienceIncludesState(state, audience, user.id);
        const modelAllowed = modelRef ? (access.all || access.ids.has(modelOf(modelRef))) : true;
        allowed = visible && modelAllowed && resolved.modelAllowed;
        sourceRefs.add(sourceId("resource", input.resourceId, modelRef, "access"));
        if (!visible) {
          reasonKeys.add("resourceDenied");
          availability = "unconfigured";
        } else if (modelRef && !modelAllowed) {
          reasonKeys.add("resourceDenied");
        }
        if (!getSharedConnection(input.resourceId)?.enabled) availability = "unconfigured";
        if (!resolved.modelAllowed) reasonKeys.add("modelOverride");
        if (modelRef && !snapshot.currentRefs.includes(modelRef)) availability = availability === "ready" ? "unknown" : availability;
      } else {
        // model
        const credential = credentialAllowedFor(state, user.id, modelRef!);
        allowed = credential && resolved.modelAllowed;
        sourceRefs.add(sourceId("resource", providerOf(modelRef!), modelRef, "access"));
        if (!resolved.modelAllowed) {
          reasonKeys.add("modelOverride");
          for (const id of resolved.provenance.modelAllowed?.winnerSourceIds ?? []) sourceRefs.add(id);
        }
        if (!credential) reasonKeys.add("resourceDenied");
        if (!snapshot.currentRefs.includes(modelRef!)) {
          reasonKeys.add("missingModel");
          availability = "unknown";
        }
        if (!allowed && !reasonKeys.size) reasonKeys.add("userOverride");
      }
      return {
        userId: user.id,
        name: user.name,
        email: user.email,
        allowed,
        reasonKeys: [...reasonKeys],
        sourceRefs: [...sourceRefs],
        availability,
      };
    });
    const scope = sha256(canonicalJson({ kind: input.resourceKind, id: input.resourceId, modelRef, q }));
    const limit = input.limit ?? 50;
    const offset = decodeCursor(input.cursor, scope);
    const page = rows.slice(offset, offset + limit);
    return {
      revision: currentRevision(),
      rows: page,
      counts: {
        allowed: rows.filter((row) => row.allowed).length,
        denied: rows.filter((row) => !row.allowed && row.availability !== "unknown").length,
        unknown: rows.filter((row) => row.availability === "unknown").length,
      },
      nextCursor: offset + limit < rows.length ? encodeCursor(scope, offset + limit) : null,
    };
  }

  auditList(input: { cursor?: string; limit?: number; subjectKind?: Subject["kind"]; subjectId?: string }): AuditListResponse {
    const limit = input.limit ?? 50;
    const before = input.cursor ? Number(input.cursor) : undefined;
    if (input.cursor && (!Number.isSafeInteger(before) || before! <= 0)) throw invalidInput("The page cursor is no longer valid.", "cursor");
    if ((input.subjectKind === undefined) !== (input.subjectId === undefined)) throw invalidInput("Choose both a subject kind and id.", "subjectKind");
    const result = listAudit({ before, limit, subjectId: input.subjectId });
    const rows = input.subjectKind
      ? result.rows.filter((row) => {
          const subjects = Array.isArray(row.summary.subjects) ? (row.summary.subjects as Array<{ kind?: unknown }>) : [];
          return subjects.some((subject) => subject.kind === input.subjectKind);
        })
      : result.rows;
    return { rows, nextCursor: result.nextCursor, retentionDays: AUDIT_RETENTION_DAYS };
  }

  auditDetail(revision: number): AuditDetailResponse {
    if (!Number.isSafeInteger(revision) || revision < 1) throw invalidInput("Choose a permission revision.", "revision");
    const detail = getAuditDetail(revision);
    if (!detail) throw missing("That permission revision no longer exists.");
    return detail;
  }

  self(userId: string, modelRef: string | null): SelfPermissions {
    const resolved = resolvePermissions(userId, modelRef);
    const disabledReasons: SelfPermissions["disabledReasons"] = {};
    for (const feature of FEATURE_KEYS) {
      if (resolved.features[feature]) continue;
      const constrained = resolved.provenance[`features.${feature}`]?.constrainedBy ?? [];
      disabledReasons[feature] = constrained.some((id) => id.startsWith("dependency:")) ? "dependency" : "admin";
    }
    return {
      revision: resolved.revision,
      modelRef,
      modelAllowed: resolved.modelAllowed,
      features: resolved.features,
      limits: resolved.limits,
      buckets: resolved.buckets,
      disabledReasons,
    };
  }

  async getInstruction(userId: string, modelRef: string): Promise<ModelInstruction> {
    if (!validModelRef(modelRef)) throw invalidInput("Use a provider-qualified model id.", "modelRef");
    await this.assertKnownInstructionRef(userId, modelRef);
    return getModelInstruction(userId, modelRef);
  }

  async putInstruction(
    userId: string,
    input: { modelRef: string; baseRevision: number; rule: PromptRuleValue | null },
  ): Promise<ModelInstruction> {
    if (!validModelRef(input.modelRef)) throw invalidInput("Use a provider-qualified model id.", "modelRef");
    await this.assertKnownInstructionRef(userId, input.modelRef);
    return setModelInstruction(userId, input.modelRef, input.baseRevision, input.rule);
  }

  private async assertKnownInstructionRef(userId: string, modelRef: string): Promise<void> {
    if (listModelInstructionRefs(userId).includes(modelRef)) return;
    const snapshot = await this.catalog.snapshot();
    if (snapshot.currentRefs.includes(modelRef)) return;
    const catalogForUser = await this.catalog.userRefs(userId);
    if (catalogForUser.refs.includes(modelRef)) return;
    // An own connection may hold a model the shared catalog does not list; without a reachable catalog we
    // cannot prove it either way, so keep the old optimistic behaviour for that account only.
    if (catalogForUser.unavailable && getOwnConnection(userId, providerOf(modelRef))) return;
    if (catalogForUser.unavailable) throw catalogUnavailable();
    throw invalidInput("That model is not in the current catalog.", "modelRef", { modelRef });
  }
}

// ---------------------------------------------------------------------------------------------------
// Applying a change

function applyChangeToState(state: WorkspaceState, change: Change): void {
  switch (change.kind) {
    case "policy": {
      const key = policyKey(change.subject, change.modelRef);
      state.invalidPolicies = state.invalidPolicies.filter((row) => policyKey(row.subject, row.modelRef) !== key);
      if (change.document) state.policies.set(key, { subject: change.subject, modelRef: change.modelRef, document: change.document });
      else state.policies.delete(key);
      break;
    }
    case "prompt": {
      const key = promptKey(change.subject, change.modelRef, change.key);
      if (change.rule) state.prompts.set(key, { subject: change.subject, modelRef: change.modelRef, key: change.key, rule: change.rule });
      else state.prompts.delete(key);
      break;
    }
    case "serverPrompt":
      state.serverPrompts.set(change.key, change.value);
      break;
    case "providerAudience": {
      state.audiences.set(audienceKey("provider", change.providerId), change.audience);
      // An audience edit prunes grant rows for targets that are no longer in the audience.
      const targets = new Set(audienceTargets(change.audience).map(targetKey));
      const current = state.entitlements.get(change.providerId) ?? [];
      state.entitlements.set(
        change.providerId,
        current.filter((policy) => targets.has(targetKey(policy.target))),
      );
      break;
    }
    case "mcpAudience":
      state.audiences.set(audienceKey("mcp", change.serverId), change.audience);
      break;
    case "providerEntitlements": {
      const current = state.entitlements.get(change.providerId) ?? [];
      const byTarget = new Map(current.map((policy) => [targetKey(policy.target), policy]));
      for (const policy of change.policies) byTarget.set(targetKey(policy.target), policy);
      state.entitlements.set(change.providerId, [...byTarget.values()].sort((a, b) => targetKey(a.target).localeCompare(targetKey(b.target))));
      break;
    }
    case "groupOrder":
      change.groupIds.forEach((id, index) => state.groupOrder.set(id, (index + 1) * 10));
      break;
    case "membership":
      state.memberships.set(change.groupId, new Set(change.userIds));
      break;
  }
}

function revalidateLive(change: Change): void {
  switch (change.kind) {
    case "policy":
    case "prompt":
      assertSubjectLive(change.subject);
      break;
    case "providerAudience":
      if (!getSharedConnection(change.providerId)) throw missing("That provider connection no longer exists.");
      assertAudienceLive(change.audience, "audience");
      break;
    case "providerEntitlements":
      if (!getSharedConnection(change.providerId)) throw missing("That provider connection no longer exists.");
      for (const policy of change.policies) {
        if (policy.target.kind !== "everyone") assertSubjectLive(policy.target);
      }
      break;
    case "mcpAudience":
      if (!db.prepare("SELECT 1 FROM mcp_servers WHERE id = ?").get(change.serverId)) throw missing("That MCP server no longer exists.");
      assertAudienceLive(change.audience, "audience");
      break;
    case "groupOrder": {
      const live = (db.prepare("SELECT id FROM user_groups ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
      if (change.groupIds.length !== live.length || new Set(change.groupIds).size !== live.length) {
        throw invalidInput("Group order must list every group exactly once.", "groupIds");
      }
      const known = new Set(live);
      for (const id of change.groupIds) if (!known.has(id)) throw invalidInput("Group order includes an unknown group.", "groupIds");
      break;
    }
    case "membership":
      if (!db.prepare("SELECT 1 FROM user_groups WHERE id = ?").get(change.groupId)) throw missing("That group no longer exists.");
      assertUsersLive(change.userIds, "userIds");
      break;
    case "serverPrompt":
      break;
  }
}

function applyChange(change: Change, adminId: string): AuditEntry | null {
  const destination = changeDestination(change);
  switch (change.kind) {
    case "policy": {
      const before = getPolicy(change.subject, change.modelRef);
      if (!writePolicy(change.subject, change.modelRef, change.document, adminId)) return null;
      return { destination, before, after: change.document };
    }
    case "prompt": {
      const before = getPromptRule(change.subject, change.modelRef, change.key);
      if (!writePromptRule(change.subject, change.modelRef, change.key, change.rule, adminId)) return null;
      return { destination, before, after: change.rule };
    }
    case "serverPrompt": {
      const before = serverOverrideValue(change.key);
      if (before === change.value) return null;
      if (!setPrompt(change.key, change.value)) throw invalidInput("Unknown prompt.", "key");
      return { destination, before, after: change.value };
    }
    case "providerAudience": {
      const before = getAudience("provider", change.providerId);
      if (canonicalJson(before) === canonicalJson(change.audience)) return null;
      setAudience("provider", change.providerId, change.audience);
      return { destination, before, after: change.audience };
    }
    case "providerEntitlements": {
      const before = change.policies.map((policy) => getModelAccessPolicy(change.providerId, policy.target));
      if (before.every((policy, index) => canonicalJson(policy) === canonicalJson(change.policies[index]))) return null;
      // Audience changes in the same transaction are applied first; a target removed by one cannot keep a grant.
      const targets = new Set(providerAudienceTargets(change.providerId).map(targetKey));
      for (const policy of change.policies) {
        if (!targets.has(targetKey(policy.target))) throw invalidInput("That audience is no longer part of this connection.", "policies");
      }
      setModelAccessPolicies(change.providerId, change.policies);
      return { destination, before, after: change.policies };
    }
    case "mcpAudience": {
      const before = getAudience("mcp", change.serverId);
      if (canonicalJson(before) === canonicalJson(change.audience)) return null;
      setAudience("mcp", change.serverId, change.audience);
      return { destination, before, after: change.audience };
    }
    case "groupOrder": {
      const before = currentGroupOrder();
      if (before.join("\u0000") === change.groupIds.join("\u0000")) return null;
      db.prepare("UPDATE user_groups SET prompt_order = NULL").run();
      const update = db.prepare("UPDATE user_groups SET prompt_order = ? WHERE id = ?");
      change.groupIds.forEach((id, index) => update.run((index + 1) * 10, id));
      return { destination, before, after: change.groupIds };
    }
    case "membership": {
      const before = currentMembers(change.groupId);
      if (before.join("\u0000") === change.userIds.join("\u0000")) return null;
      db.prepare("DELETE FROM user_group_members WHERE group_id = ?").run(change.groupId);
      const add = db.prepare("INSERT OR IGNORE INTO user_group_members (group_id, user_id) SELECT ?, id FROM users WHERE id = ?");
      for (const userId of change.userIds) {
        const result = add.run(change.groupId, userId);
        if (!Number(result.changes)) throw invalidInput("That user no longer exists.", "userIds", { userId });
      }
      return { destination, before, after: change.userIds };
    }
  }
}

function auditKindFor(changes: Change[]): AuditKind {
  if (changes.some((change) => change.kind === "policy")) return "policy";
  if (changes.some((change) => change.kind === "prompt" || change.kind === "serverPrompt")) return "prompt";
  if (changes.some((change) => change.kind === "providerAudience" || change.kind === "mcpAudience")) return "audience";
  if (changes.some((change) => change.kind === "providerEntitlements")) return "entitlement";
  if (changes.some((change) => change.kind === "membership")) return "membership";
  return "group_order";
}

function uniqueSubjects(changes: Change[]): Array<{ kind: Subject["kind"]; id: string }> {
  const subjects = new Map<string, { kind: Subject["kind"]; id: string }>();
  for (const change of changes) {
    if ("subject" in change) subjects.set(targetKey(change.subject), { kind: change.subject.kind, id: change.subject.id });
    if (change.kind === "membership") subjects.set(`group:${change.groupId}`, { kind: "group", id: change.groupId });
    if (change.kind === "providerEntitlements") for (const policy of change.policies) subjects.set(targetKey(policy.target), { kind: policy.target.kind, id: policy.target.id });
  }
  return [...subjects.values()].sort((a, b) => targetKey(a).localeCompare(targetKey(b)));
}

function mcpAvailability(state: WorkspaceState, userId: string, serverId: string): { visible: boolean; ready: boolean } {
  const row = db.prepare("SELECT user_id, shared, enabled FROM mcp_servers WHERE id = ?").get(serverId) as
    | { user_id: string; shared: number; enabled: number }
    | undefined;
  if (!row) return { visible: false, ready: false };
  if (row.user_id === userId) return { visible: true, ready: !!row.enabled };
  const owner = db.prepare("SELECT role FROM users WHERE id = ?").get(row.user_id) as { role: string } | undefined;
  if (!row.shared || owner?.role !== "admin") return { visible: false, ready: false };
  const audience = state.audiences.get(audienceKey("mcp", serverId)) ?? { mode: "all", userIds: [], groupIds: [] };
  return { visible: audienceIncludesState(state, audience, userId), ready: !!row.enabled };
}
