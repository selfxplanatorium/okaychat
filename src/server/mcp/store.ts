import type { McpServerConfig, McpTransport } from "../../shared/types.js";
import { decrypt, encrypt, newId } from "../crypto.js";
import { db } from "../db.js";
import { audienceIncludes, clearAudience } from "../groups.js";

/**
 * A server as one user sees it. Own servers have `ownerId === userId`. A server an admin shares appears
 * in every user's list with `ownerId` set to the admin: the owner's URL, headers, and approval policy,
 * but the viewer's own on/off switch, tool toggles, and OAuth tokens (`mcp_server_users`).
 */
export interface McpServerRecord {
  id: string;
  /** The user this view is for: connections, OAuth tokens, and saved images belong to them. */
  userId: string;
  /** The user who configured it. Network rules and stdio permission follow the owner. */
  ownerId: string;
  name: string;
  transport: McpTransport;
  config: McpServerConfig;
  /** The owner shares it with other users: everyone, or the audience in `groups.ts`. */
  shared: boolean;
  enabled: boolean;
  disabledTools: string[];
}

interface Row {
  id: string;
  user_id: string;
  name: string;
  transport: McpTransport;
  config_enc: string;
  shared: number;
  enabled: number;
  disabled_tools: string;
}

const toRecord = (r: Row, viewer = r.user_id): McpServerRecord => ({
  id: r.id,
  userId: viewer,
  ownerId: r.user_id,
  name: r.name,
  transport: r.transport,
  config: JSON.parse(decrypt(r.config_enc)) as McpServerConfig,
  shared: r.shared === 1,
  enabled: r.enabled === 1,
  disabledTools: JSON.parse(r.disabled_tools) as string[],
});

/** The user's own servers. */
export function listServers(userId: string): McpServerRecord[] {
  const rows = db.prepare("SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY name").all(userId) as unknown as Row[];
  return rows.map((r) => toRecord(r));
}

/**
 * Servers admins share with this user (everyone, or an audience that includes the user), with the user's own
 * preferences. A demoted owner's servers stop being shared.
 */
export function listSharedServers(userId: string): McpServerRecord[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.user_id, s.name, s.transport, s.config_enc, s.shared,
              COALESCE(p.enabled, 1) AS enabled, COALESCE(p.disabled_tools, '[]') AS disabled_tools
       FROM mcp_servers s
       JOIN users o ON o.id = s.user_id AND o.role = 'admin'
       LEFT JOIN mcp_server_users p ON p.server_id = s.id AND p.user_id = ?
       WHERE s.shared = 1 AND s.user_id <> ? AND ${audienceIncludes("mcp", "s.id")}
       ORDER BY s.name`,
    )
    .all(userId, userId, userId, userId) as unknown as Row[];
  return rows.map((r) => toRecord(r, userId));
}

/** Own servers first. A shared server whose name the user already uses is left out, so tool names stay unique. */
export function visibleServers(userId: string): McpServerRecord[] {
  const own = listServers(userId);
  const names = new Set(own.map((s) => s.name.toLowerCase()));
  return [...own, ...listSharedServers(userId).filter((s) => !names.has(s.name.toLowerCase()))];
}

/** The user's own server. */
export function getServer(userId: string, id: string): McpServerRecord | undefined {
  const row = db.prepare("SELECT * FROM mcp_servers WHERE user_id = ? AND id = ?").get(userId, id) as Row | undefined;
  return row ? toRecord(row) : undefined;
}

/** An own server or one shared with the user. */
export function getVisibleServer(userId: string, id: string): McpServerRecord | undefined {
  return visibleServers(userId).find((s) => s.id === id);
}

export function createServer(userId: string, input: Pick<McpServerRecord, "name" | "transport" | "config" | "enabled"> & { shared?: boolean }) {
  const id = newId("mcp");
  db.prepare(
    "INSERT INTO mcp_servers (id, user_id, name, transport, config_enc, enabled, shared, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, userId, input.name, input.transport, encrypt(JSON.stringify(input.config)), input.enabled ? 1 : 0, input.shared ? 1 : 0, Date.now());
  return id;
}

export function updateServer(userId: string, id: string, patch: Partial<Pick<McpServerRecord, "name" | "transport" | "config" | "shared" | "enabled" | "disabledTools">>) {
  const current = getServer(userId, id);
  if (!current) throw new Error("MCP server not found");
  const next = { ...current, ...patch };
  db.prepare(
    "UPDATE mcp_servers SET name = ?, transport = ?, config_enc = ?, enabled = ?, shared = ?, disabled_tools = ? WHERE user_id = ? AND id = ?",
  ).run(
    next.name,
    next.transport,
    encrypt(JSON.stringify(next.config)),
    next.enabled ? 1 : 0,
    next.shared ? 1 : 0,
    JSON.stringify(next.disabledTools),
    userId,
    id,
  );
}

/** A viewer's switch and tool toggles for a shared server. */
export function updateSharedPrefs(userId: string, id: string, patch: { enabled?: boolean; disabledTools?: string[] }) {
  const current = getVisibleServer(userId, id);
  if (!current || current.ownerId === userId) throw new Error("MCP server not found");
  db.prepare(
    `INSERT INTO mcp_server_users (server_id, user_id, enabled, disabled_tools) VALUES (?, ?, ?, ?)
     ON CONFLICT (server_id, user_id) DO UPDATE SET enabled = excluded.enabled, disabled_tools = excluded.disabled_tools`,
  ).run(id, userId, (patch.enabled ?? current.enabled) ? 1 : 0, JSON.stringify(patch.disabledTools ?? current.disabledTools));
}

export function deleteServer(userId: string, id: string) {
  db.prepare("DELETE FROM mcp_servers WHERE user_id = ? AND id = ?").run(userId, id);
  clearAudience("mcp", id);
}

/** Users other than the owner with tokens or preferences for this server. */
export function sharedViewers(id: string): string[] {
  return (db.prepare("SELECT user_id FROM mcp_server_users WHERE server_id = ?").all(id) as Array<{ user_id: string }>).map((r) => r.user_id);
}

/** Tokens other users obtained for a shared server. Cleared when its origin changes. */
export function clearSharedOAuth(id: string) {
  db.prepare("UPDATE mcp_server_users SET oauth_enc = NULL WHERE server_id = ?").run(id);
}

const isOwner = (userId: string, serverId: string) => !!db.prepare("SELECT 1 FROM mcp_servers WHERE id = ? AND user_id = ?").get(serverId, userId);

/** OAuth state per (user, server): the owner's in mcp_servers, everyone else's in mcp_server_users. */
export function readOAuth<T>(userId: string, serverId: string): T | undefined {
  const row = (
    isOwner(userId, serverId)
      ? db.prepare("SELECT oauth_enc FROM mcp_servers WHERE id = ?").get(serverId)
      : db.prepare("SELECT oauth_enc FROM mcp_server_users WHERE server_id = ? AND user_id = ?").get(serverId, userId)
  ) as { oauth_enc: string | null } | undefined;
  return row?.oauth_enc ? (JSON.parse(decrypt(row.oauth_enc)) as T) : undefined;
}

export function writeOAuth(userId: string, serverId: string, value: unknown) {
  const enc = value ? encrypt(JSON.stringify(value)) : null;
  if (isOwner(userId, serverId)) {
    db.prepare("UPDATE mcp_servers SET oauth_enc = ? WHERE id = ?").run(enc, serverId);
    return;
  }
  db.prepare(
    `INSERT INTO mcp_server_users (server_id, user_id, oauth_enc) VALUES (?, ?, ?)
     ON CONFLICT (server_id, user_id) DO UPDATE SET oauth_enc = excluded.oauth_enc`,
  ).run(serverId, userId, enc);
}
