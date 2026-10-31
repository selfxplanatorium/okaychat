import type { ModelAccessPolicy, ModelAccessTarget } from "../shared/types.js";
import { db, tx } from "./db.js";

// Model access on shared provider connections (docs/implementation/entitlements.md). A policy belongs to one
// audience target: everyone, one user, or one group. A target without a policy row may use every model, so
// existing connections and newly added audience entries keep the old behaviour. Visible users get the union
// of every matching target; a user's own connection never consults these tables.

const targetKey = (target: ModelAccessTarget) => `${target.kind}:${target.id}`;

export function modelTargetKey(target: ModelAccessTarget): string {
  return targetKey(target);
}

/** The audience entries of a shared provider connection, in the same shape its policy API uses. */
export function providerAudienceTargets(providerId: string): ModelAccessTarget[] {
  const selected = db.prepare("SELECT 1 FROM share_audiences WHERE kind = 'provider' AND resource_id = ?").get(providerId);
  if (!selected) return [{ kind: "everyone", id: "" }];
  const users = db.prepare("SELECT user_id AS id FROM share_users WHERE kind = 'provider' AND resource_id = ? ORDER BY user_id").all(providerId) as Array<{ id: string }>;
  const groups = db.prepare("SELECT group_id AS id FROM share_groups WHERE kind = 'provider' AND resource_id = ? ORDER BY group_id").all(providerId) as Array<{ id: string }>;
  return [
    ...users.map((row): ModelAccessTarget => ({ kind: "user", id: row.id })),
    ...groups.map((row): ModelAccessTarget => ({ kind: "group", id: row.id })),
  ];
}

/** A target's policy. Missing rows mean every model, matching the defaults for legacy audiences. */
export function getModelAccessPolicy(providerId: string, target: ModelAccessTarget): ModelAccessPolicy {
  const row = db
    .prepare("SELECT mode FROM provider_model_policies WHERE provider_id = ? AND target_kind = ? AND target_id = ?")
    .get(providerId, target.kind, target.id) as { mode: "all" | "selected" } | undefined;
  if (!row || row.mode === "all") return { target, mode: "all", modelIds: [] };
  const modelIds = (db
    .prepare("SELECT model_id FROM provider_model_grants WHERE provider_id = ? AND target_kind = ? AND target_id = ? ORDER BY model_id")
    .all(providerId, target.kind, target.id) as Array<{ model_id: string }>).map((grant) => grant.model_id);
  return { target, mode: "selected", modelIds };
}

/** One policy per current audience target. Targets without a stored row appear as "all". */
export function listModelAccessPolicies(providerId: string): ModelAccessPolicy[] {
  return providerAudienceTargets(providerId).map((target) => getModelAccessPolicy(providerId, target));
}

function writeModelAccessPolicy(providerId: string, policy: ModelAccessPolicy) {
  db.prepare("DELETE FROM provider_model_policies WHERE provider_id = ? AND target_kind = ? AND target_id = ?").run(
    providerId,
    policy.target.kind,
    policy.target.id,
  );
  if (policy.mode === "all") return;
  db.prepare("INSERT INTO provider_model_policies (provider_id, target_kind, target_id, mode) VALUES (?, ?, ?, 'selected')").run(
    providerId,
    policy.target.kind,
    policy.target.id,
  );
  const grant = db.prepare(
    "INSERT OR IGNORE INTO provider_model_grants (provider_id, target_kind, target_id, model_id) VALUES (?, ?, ?, ?)",
  );
  for (const modelId of new Set(policy.modelIds)) grant.run(providerId, policy.target.kind, policy.target.id, modelId);
}

/** Replaces only the given targets. Other audiences keep their policies, so one edit never widens another. */
export function setModelAccessPolicies(providerId: string, policies: ModelAccessPolicy[]) {
  tx(() => {
    for (const policy of policies) writeModelAccessPolicy(providerId, policy);
  });
}

export function clearModelAccessPolicies(providerId: string) {
  db.prepare("DELETE FROM provider_model_policies WHERE provider_id = ?").run(providerId);
}

export function clearModelAccessPoliciesForGroup(groupId: string) {
  db.prepare("DELETE FROM provider_model_policies WHERE target_kind = 'group' AND target_id = ?").run(groupId);
}

export function clearModelAccessPoliciesForUser(userId: string) {
  db.prepare("DELETE FROM provider_model_policies WHERE target_kind = 'user' AND target_id = ?").run(userId);
}

/** Called after an audience edit: drop policies for users and groups the connection no longer shares with. */
export function pruneModelAccessPolicies(providerId: string) {
  const keep = new Set(providerAudienceTargets(providerId).map(targetKey));
  const rows = db
    .prepare("SELECT target_kind, target_id FROM provider_model_policies WHERE provider_id = ?")
    .all(providerId) as Array<{ target_kind: ModelAccessTarget["kind"]; target_id: string }>;
  const remove = db.prepare("DELETE FROM provider_model_policies WHERE provider_id = ? AND target_kind = ? AND target_id = ?");
  for (const row of rows) {
    if (!keep.has(targetKey({ kind: row.target_kind, id: row.target_id }))) remove.run(providerId, row.target_kind, row.target_id);
  }
}

export interface SharedModelAccess {
  /** The shared connection exists and its audience includes the user. */
  visible: boolean;
  /** Any matching target allows every model (also the legacy default). */
  all: boolean;
  /** The union of matching explicit allowlists. Only meaningful when `all` is false. */
  ids: ReadonlySet<string>;
}

const NONE: SharedModelAccess = { visible: false, all: false, ids: new Set() };

/** Effective access to a shared provider's models for one user. Own connections bypass this entirely. */
export function sharedModelAccess(userId: string, providerId: string): SharedModelAccess {
  const included = db
    .prepare(
      `SELECT 1 FROM shared_connections s WHERE s.provider_id = ? AND (
         NOT EXISTS (SELECT 1 FROM share_audiences a WHERE a.kind = 'provider' AND a.resource_id = s.provider_id)
         OR EXISTS (SELECT 1 FROM share_users su WHERE su.kind = 'provider' AND su.resource_id = s.provider_id AND su.user_id = ?)
         OR EXISTS (SELECT 1 FROM share_groups sg JOIN user_group_members m ON m.group_id = sg.group_id
                    WHERE sg.kind = 'provider' AND sg.resource_id = s.provider_id AND m.user_id = ?)
       )`,
    )
    .get(providerId, userId, userId);
  if (!included) return NONE;

  const selected = db.prepare("SELECT 1 FROM share_audiences WHERE kind = 'provider' AND resource_id = ?").get(providerId);
  const targets: ModelAccessTarget[] = [];
  if (!selected) {
    targets.push({ kind: "everyone", id: "" });
  } else {
    const users = db
      .prepare("SELECT user_id AS id FROM share_users WHERE kind = 'provider' AND resource_id = ? AND user_id = ?")
      .all(providerId, userId) as Array<{ id: string }>;
    const groups = db
      .prepare(
        `SELECT sg.group_id AS id FROM share_groups sg JOIN user_group_members m ON m.group_id = sg.group_id
         WHERE sg.kind = 'provider' AND sg.resource_id = ? AND m.user_id = ?`,
      )
      .all(providerId, userId) as Array<{ id: string }>;
    targets.push(...users.map((row): ModelAccessTarget => ({ kind: "user", id: row.id })));
    targets.push(...groups.map((row): ModelAccessTarget => ({ kind: "group", id: row.id })));
  }

  const ids = new Set<string>();
  for (const target of targets) {
    const policy = getModelAccessPolicy(providerId, target);
    if (policy.mode === "all") return { visible: true, all: true, ids: new Set() };
    for (const modelId of policy.modelIds) ids.add(modelId);
  }
  return { visible: true, all: false, ids };
}

/** Shared audiences are provider-only today; MCP servers keep their existing audience behaviour. */
export function isModelAccessKind(kind: string): kind is "provider" {
  return kind === "provider";
}

/** Names the admin so a revoked model reads as a policy, not as a broken chat. */
export function modelAccessMessage(ref: string): string {
  return `Your administrator has not granted your account access to ${ref}. Ask an administrator to add it under Admin → Providers → Models.`;
}
