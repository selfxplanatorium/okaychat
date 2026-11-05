import { abortRevokedAgentRuns } from "./n8n/store.js";
import { afterCommit } from "./db.js";
import { requestChannelRevocation } from "./channels/revocation.js";
import { HTTPException } from "hono/http-exception";
import type { ShareAudience, UserGroup } from "../shared/types.js";
import { newId } from "./crypto.js";
import { db, tx } from "./db.js";
import {
  clearModelAccessPolicies,
  clearModelAccessPoliciesForGroup,
  isModelAccessKind,
  pruneModelAccessPolicies,
} from "./entitlements.js";

// Admin-defined user groups, and the audience of each shared resource: everyone, or only listed users and
// members of listed groups. Shared provider connections, shared MCP servers, and shared n8n agents use it.

export type ShareKind = "provider" | "mcp" | "n8n";

export function listGroups(): UserGroup[] {
  const groups = db.prepare("SELECT id, name FROM user_groups ORDER BY name").all() as Array<{ id: string; name: string }>;
  const members = db.prepare("SELECT group_id, user_id FROM user_group_members").all() as Array<{ group_id: string; user_id: string }>;
  return groups.map((g) => ({ ...g, userIds: members.filter((m) => m.group_id === g.id).map((m) => m.user_id) }));
}

const nameTaken = (name: string, except?: string) =>
  !!db.prepare("SELECT 1 FROM user_groups WHERE name = ? COLLATE NOCASE AND id <> ?").get(name, except ?? "");

export function createGroup(name: string, userIds: string[] = []): UserGroup {
  if (nameTaken(name)) throw new HTTPException(409, { message: "A group with that name exists." });
  const id = newId("grp");
  tx(() => {
    db.prepare("INSERT INTO user_groups (id, name, created_at, prompt_order) VALUES (?, ?, ?, (SELECT COALESCE(MAX(prompt_order), 0) + 10 FROM user_groups))").run(id, name, Date.now());
    setMembers(id, userIds);
  });
  afterCommit(abortRevokedAgentRuns);
  return listGroups().find((g) => g.id === id)!;
}

export function updateGroup(id: string, patch: { name?: string; userIds?: string[] }): UserGroup {
  if (!db.prepare("SELECT 1 FROM user_groups WHERE id = ?").get(id)) throw new HTTPException(404, { message: "Group not found" });
  if (patch.name !== undefined && nameTaken(patch.name, id)) throw new HTTPException(409, { message: "A group with that name exists." });
  tx(() => {
    if (patch.name !== undefined) db.prepare("UPDATE user_groups SET name = ? WHERE id = ?").run(patch.name, id);
    if (patch.userIds) setMembers(id, patch.userIds);
  });
  afterCommit(abortRevokedAgentRuns);
  afterCommit(requestChannelRevocation);
  return listGroups().find((g) => g.id === id)!;
}

// updateGroup's membership commit and deleteGroup's audience removal both revoke room eligibility.
export function deleteGroup(id: string) {
  tx(() => {
    clearModelAccessPoliciesForGroup(id);
    db.prepare("DELETE FROM user_groups WHERE id = ?").run(id);
    afterCommit(abortRevokedAgentRuns);
    afterCommit(requestChannelRevocation);
  });
}

/** Unknown user ids are dropped rather than rejected: a user may have been deleted while the form was open. */
function setMembers(groupId: string, userIds: string[]) {
  db.prepare("DELETE FROM user_group_members WHERE group_id = ?").run(groupId);
  const add = db.prepare("INSERT OR IGNORE INTO user_group_members (group_id, user_id) SELECT ?, id FROM users WHERE id = ?");
  for (const userId of new Set(userIds)) add.run(groupId, userId);
}

export function getAudience(kind: ShareKind, resourceId: string): ShareAudience {
  if (!db.prepare("SELECT 1 FROM share_audiences WHERE kind = ? AND resource_id = ?").get(kind, resourceId)) return { mode: "all", userIds: [], groupIds: [] };
  const userIds = db.prepare("SELECT user_id FROM share_users WHERE kind = ? AND resource_id = ?").all(kind, resourceId) as Array<{ user_id: string }>;
  const groupIds = db.prepare("SELECT group_id FROM share_groups WHERE kind = ? AND resource_id = ?").all(kind, resourceId) as Array<{ group_id: string }>;
  return { mode: "selected", userIds: userIds.map((r) => r.user_id), groupIds: groupIds.map((r) => r.group_id) };
}

export function setAudience(kind: ShareKind, resourceId: string, audience: ShareAudience) {
  tx(() => {
    // Delete the audience rows directly instead of clearAudience(): that function also drops model policies,
    // while an audience edit must preserve the policies of the targets it keeps.
    db.prepare("DELETE FROM share_audiences WHERE kind = ? AND resource_id = ?").run(kind, resourceId);
    if (audience.mode === "selected") {
      db.prepare("INSERT INTO share_audiences (kind, resource_id) VALUES (?, ?)").run(kind, resourceId);
      const addUser = db.prepare("INSERT OR IGNORE INTO share_users (kind, resource_id, user_id) SELECT ?, ?, id FROM users WHERE id = ?");
      const addGroup = db.prepare("INSERT OR IGNORE INTO share_groups (kind, resource_id, group_id) SELECT ?, ?, id FROM user_groups WHERE id = ?");
      for (const userId of new Set(audience.userIds)) addUser.run(kind, resourceId, userId);
      for (const groupId of new Set(audience.groupIds)) addGroup.run(kind, resourceId, groupId);
    }
    if (isModelAccessKind(kind)) pruneModelAccessPolicies(resourceId);
    if (kind === "n8n") afterCommit(abortRevokedAgentRuns);
  });
}

/** Called when the resource is deleted, so a new one with the same id (provider ids repeat) starts shared with everyone. */
export function clearAudience(kind: ShareKind, resourceId: string) {
  db.prepare("DELETE FROM share_audiences WHERE kind = ? AND resource_id = ?").run(kind, resourceId);
  if (isModelAccessKind(kind)) clearModelAccessPolicies(resourceId);
}

/**
 * SQL condition: the resource whose id is in `idColumn` is shared with the user bound to the two `?`
 * placeholders (pass the user id twice).
 */
export const audienceIncludes = (kind: ShareKind, idColumn: string) => `(
  NOT EXISTS (SELECT 1 FROM share_audiences a WHERE a.kind = '${kind}' AND a.resource_id = ${idColumn})
  OR EXISTS (SELECT 1 FROM share_users su WHERE su.kind = '${kind}' AND su.resource_id = ${idColumn} AND su.user_id = ?)
  OR EXISTS (SELECT 1 FROM share_groups sg JOIN user_group_members m ON m.group_id = sg.group_id
             WHERE sg.kind = '${kind}' AND sg.resource_id = ${idColumn} AND m.user_id = ?)
)`;
