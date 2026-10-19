import type { McpServerConfig, McpTransport } from "../../shared/types.js";
import { decrypt, encrypt, newId } from "../crypto.js";
import { db } from "../db.js";

export interface McpServerRecord {
  id: string;
  userId: string;
  name: string;
  transport: McpTransport;
  config: McpServerConfig;
  enabled: boolean;
  disabledTools: string[];
}

interface Row {
  id: string;
  user_id: string;
  name: string;
  transport: McpTransport;
  config_enc: string;
  enabled: number;
  disabled_tools: string;
}

const toRecord = (r: Row): McpServerRecord => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  transport: r.transport,
  config: JSON.parse(decrypt(r.config_enc)) as McpServerConfig,
  enabled: r.enabled === 1,
  disabledTools: JSON.parse(r.disabled_tools) as string[],
});

export function listServers(userId: string): McpServerRecord[] {
  const rows = db.prepare("SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY name").all(userId) as unknown as Row[];
  return rows.map(toRecord);
}

export function getServer(userId: string, id: string): McpServerRecord | undefined {
  const row = db.prepare("SELECT * FROM mcp_servers WHERE user_id = ? AND id = ?").get(userId, id) as Row | undefined;
  return row ? toRecord(row) : undefined;
}

export function createServer(userId: string, input: Omit<McpServerRecord, "id" | "userId" | "disabledTools">) {
  const id = newId("mcp");
  db.prepare(
    "INSERT INTO mcp_servers (id, user_id, name, transport, config_enc, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, userId, input.name, input.transport, encrypt(JSON.stringify(input.config)), input.enabled ? 1 : 0, Date.now());
  return id;
}

export function updateServer(userId: string, id: string, patch: Partial<Omit<McpServerRecord, "id" | "userId">>) {
  const current = getServer(userId, id);
  if (!current) throw new Error("MCP server not found");
  const next = { ...current, ...patch };
  db.prepare(
    "UPDATE mcp_servers SET name = ?, transport = ?, config_enc = ?, enabled = ?, disabled_tools = ? WHERE user_id = ? AND id = ?",
  ).run(
    next.name,
    next.transport,
    encrypt(JSON.stringify(next.config)),
    next.enabled ? 1 : 0,
    JSON.stringify(next.disabledTools),
    userId,
    id,
  );
}

export function deleteServer(userId: string, id: string) {
  db.prepare("DELETE FROM mcp_servers WHERE user_id = ? AND id = ?").run(userId, id);
}

export function readOAuth<T>(serverId: string): T | undefined {
  const row = db.prepare("SELECT oauth_enc FROM mcp_servers WHERE id = ?").get(serverId) as { oauth_enc: string | null } | undefined;
  return row?.oauth_enc ? (JSON.parse(decrypt(row.oauth_enc)) as T) : undefined;
}

export function writeOAuth(serverId: string, value: unknown) {
  db.prepare("UPDATE mcp_servers SET oauth_enc = ? WHERE id = ?").run(value ? encrypt(JSON.stringify(value)) : null, serverId);
}
