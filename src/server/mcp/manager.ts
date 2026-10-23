import { createHash } from "node:crypto";
import { createMCPClient, MCPClientError, UnauthorizedError, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import type { McpServerInfo, McpStatus, McpToolInfo } from "../../shared/types.js";
import { mayUsePrivateHosts } from "../catalog/providers.js";
import { env } from "../env.js";
import { publicFetch } from "../public-fetch.js";
import { StoredOAuthProvider } from "./oauth.js";
import { getServer, listServers, type McpServerRecord } from "./store.js";

// Rules from docs/research/mcp.md: @ai-sdk/mcp has no timeouts, no reconnect, and ignores
// list_changed, so this module supplies all three. One client per (user, server), never shared.

const STARTUP_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const TOOL_LIST_TTL_MS = 5 * 60_000;
const IDLE_CLOSE_MS = 10 * 60_000;

interface RawTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/**
 * MCP's own defaults treat an unannotated tool as possibly destructive, which would prompt for nearly every
 * tool. We ask only when the server says so: `destructiveHint: true`, or `readOnlyHint: false` without
 * `destructiveHint: false`.
 */
function needsApproval(server: McpServerRecord, tool: RawTool): boolean {
  const policy = server.config.approval ?? "destructive";
  if (policy !== "destructive") return policy === "always";
  const a = tool.annotations;
  return a?.destructiveHint === true || (a?.readOnlyHint === false && a.destructiveHint !== false);
}

interface Entry {
  key: string;
  serverId: string;
  userId: string;
  fingerprint: string;
  client?: MCPClient;
  status: McpStatus;
  error?: string;
  authorizationUrl?: string;
  tools: RawTool[];
  listedAt: number;
  lastUsed: number;
  instructions?: string;
  connecting?: Promise<void>;
}

const entries = new Map<string, Entry>();

const publicUrl = process.env.OKAYCHAT_PUBLIC_URL?.replace(/\/$/, "");
// Without OKAYCHAT_PUBLIC_URL, each user's first request teaches us the origin they reach us on. Kept per
// user, so a forged Host header can only misdirect the sender's own authorization codes.
const userOrigins = new Map<string, string>();
export function notePublicOrigin(userId: string, origin: string) {
  if (!userOrigins.has(userId)) userOrigins.set(userId, origin);
}
export const callbackUrl = (userId: string) => `${publicUrl ?? userOrigins.get(userId) ?? `http://localhost:${env.port}`}/api/mcp/oauth/callback`;

/** Admins may reach MCP servers on the local network. Other users' servers must be on the public internet. */
export const mcpFetch = (userId: string) => (mayUsePrivateHosts(userId) ? undefined : publicFetch);

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

/** Provider tool names must match ^[a-zA-Z0-9_-]{1,64}$. Long names keep a hash so they stay unique. */
export function exposedToolName(server: string, tool: string): string {
  const name = `${sanitize(server)}__${sanitize(tool)}`;
  if (name.length <= 64) return name;
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return `${sanitize(server).slice(0, 20)}__${sanitize(tool).slice(0, 33)}_${hash}`;
}

const fingerprintOf = (s: McpServerRecord) => JSON.stringify([s.transport, s.config]);

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause as { code?: string; message?: string; errors?: Array<{ code?: string }> } | undefined;
    const code = cause?.code ?? cause?.errors?.[0]?.code ?? (error as { code?: string }).code;
    if (error instanceof TypeError && error.message === "fetch failed") return `Cannot reach server (${code ?? cause?.message ?? "network error"})`;
    if (code === "ENOENT") return "Command not found";
    return error.message;
  }
  return String(error);
}

function isConnectionLost(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return error instanceof TypeError || /closed client|Connection closed|ECONNRESET|session/i.test(message);
}

/** Python MCP servers on the 2026-07-28 protocol reject the client's legacy fallback after discovery. */
const isDiscoveryMismatch = (error: unknown) =>
  (error as { code?: number })?.code === -32022 || /initialize handshake is not accepted/i.test(String((error as Error)?.message));

async function openClient(server: McpServerRecord, entry: Entry): Promise<MCPClient> {
  try {
    return await openClientWith(server, entry, true);
  } catch (error) {
    if (!isDiscoveryMismatch(error)) throw error;
    return openClientWith(server, entry, false);
  }
}

async function openClientWith(server: McpServerRecord, entry: Entry, protocolVersionDiscovery: boolean): Promise<MCPClient> {
  const common = {
    protocolVersionDiscovery,
    clientName: "okaychat",
    version: env.version,
    initializationOptions: { timeout: STARTUP_TIMEOUT_MS },
    onUncaughtError: (error: unknown) => {
      // list_changed arrives here as "Unsupported message type". Expire the cache so the next turn re-lists.
      if (String(error).includes("Unsupported message type")) entry.listedAt = 0;
    },
  };
  if (server.transport === "stdio") {
    if (!server.config.command) throw new Error("stdio server needs a command");
    // stdio runs as the server process. A demoted admin's servers must stop running.
    if (!mayUsePrivateHosts(server.userId)) throw new Error("Only admins can run stdio servers.");
    return createMCPClient({
      ...common,
      transport: new Experimental_StdioMCPTransport({
        command: server.config.command,
        args: server.config.args ?? [],
        env: server.config.env,
        stderr: "ignore",
      }),
    });
  }
  if (!server.config.url) throw new Error("Remote server needs a URL");
  const authProvider = new StoredOAuthProvider(server.userId, server.id, callbackUrl(server.userId));
  try {
    return await createMCPClient({
      ...common,
      transport: { type: server.transport, url: server.config.url, headers: server.config.headers, authProvider, fetch: mcpFetch(server.userId) },
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || authProvider.authorizationUrl) {
      entry.authorizationUrl = authProvider.authorizationUrl;
      throw new NeedsAuth();
    }
    throw error;
  }
}

class NeedsAuth extends Error {
  constructor() {
    super("Authorization required");
  }
}

async function listAll(client: MCPClient): Promise<RawTool[]> {
  const tools: RawTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools({ params: cursor ? { cursor } : undefined, options: { timeout: LIST_TIMEOUT_MS } });
    tools.push(...(page.tools as RawTool[]));
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

async function connect(server: McpServerRecord, entry: Entry) {
  entry.status = "connecting";
  entry.error = undefined;
  entry.authorizationUrl = undefined;
  await closeClient(entry);
  // One quick retry covers servers that are still booting.
  for (let attempt = 0; ; attempt++) {
    try {
      entry.client = await openClient(server, entry);
      entry.tools = await listAll(entry.client);
      entry.instructions = entry.client.instructions;
      entry.listedAt = Date.now();
      entry.status = "connected";
      return;
    } catch (error) {
      await closeClient(entry);
      if (error instanceof NeedsAuth) {
        entry.status = "needs-auth";
        entry.error = "Authorization required";
        return;
      }
      if (attempt === 0 && isConnectionLost(error)) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      entry.status = "error";
      entry.error = describeError(error);
      return;
    }
  }
}

async function closeClient(entry: Entry) {
  const client = entry.client;
  entry.client = undefined;
  if (client) await client.close().catch(() => {});
}

function entryFor(server: McpServerRecord): Entry {
  const key = `${server.userId}:${server.id}`;
  let entry = entries.get(key);
  const fingerprint = fingerprintOf(server);
  if (entry && entry.fingerprint !== fingerprint) {
    void closeClient(entry);
    entry = undefined;
  }
  if (!entry) {
    entry = {
      key,
      serverId: server.id,
      userId: server.userId,
      fingerprint,
      status: "idle",
      tools: [],
      listedAt: 0,
      lastUsed: Date.now(),
    };
    entries.set(key, entry);
  }
  return entry;
}

/** Connect if needed and refresh a stale tool list. Never throws; failures land in entry.status. */
async function ensure(server: McpServerRecord, force = false): Promise<Entry> {
  const entry = entryFor(server);
  entry.lastUsed = Date.now();
  if (entry.connecting) {
    await entry.connecting;
    return entry;
  }
  const stale = Date.now() - entry.listedAt > TOOL_LIST_TTL_MS;
  if (force || !entry.client || entry.status !== "connected") {
    entry.connecting = connect(server, entry).finally(() => (entry.connecting = undefined));
    await entry.connecting;
  } else if (stale) {
    entry.connecting = listAll(entry.client)
      .then((tools) => {
        entry.tools = tools;
        entry.listedAt = Date.now();
      })
      .catch(() => connect(server, entry))
      .finally(() => (entry.connecting = undefined));
    await entry.connecting;
  }
  return entry;
}

function toolInfos(server: McpServerRecord, entry: Entry): McpToolInfo[] {
  return entry.tools.map((t) => ({
    name: t.name,
    exposedName: exposedToolName(server.name, t.name),
    description: t.description,
    enabled: !server.disabledTools.includes(t.name),
    needsApproval: needsApproval(server, t),
  }));
}

function maskConfig(server: McpServerRecord) {
  const mask = (rec?: Record<string, string>) =>
    rec ? Object.fromEntries(Object.keys(rec).map((k) => [k, "••••••"])) : undefined;
  return { ...server.config, headers: mask(server.config.headers), env: mask(server.config.env) };
}

export function serverInfo(server: McpServerRecord): McpServerInfo & { authorizationUrl?: string } {
  const entry = entries.get(`${server.userId}:${server.id}`);
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    status: server.enabled ? (entry?.status ?? "idle") : "disabled",
    error: entry?.error,
    authorizationUrl: entry?.authorizationUrl,
    tools: entry ? toolInfos(server, entry) : [],
    config: maskConfig(server),
  };
}

export async function testServer(userId: string, serverId: string) {
  const server = getServer(userId, serverId);
  if (!server) throw new Error("MCP server not found");
  await ensure(server, true);
  return serverInfo(server);
}

export async function disconnectServer(userId: string, serverId: string) {
  const entry = entries.get(`${userId}:${serverId}`);
  if (entry) {
    await closeClient(entry);
    entries.delete(entry.key);
  }
}

type ToolOutput = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean; structuredContent?: unknown };

function toModelText(result: ToolOutput): string {
  const parts = (result.content ?? []).map((p) => {
    if (p.type === "text") return p.text ?? "";
    if (p.type === "image") return `[image ${p.mimeType ?? ""}]`;
    return JSON.stringify(p);
  });
  if (parts.length === 0 && result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return parts.join("\n");
}

export interface McpToolBundle {
  tools: ToolSet;
  instructions: string[];
  servers: Array<{ name: string; status: McpStatus; error?: string }>;
}

/** Tools from every enabled server for this user, ready for streamText. Sorted so the prompt prefix stays cacheable. */
export async function toolsForUser(userId: string): Promise<McpToolBundle> {
  const servers = listServers(userId).filter((s) => s.enabled);
  const ready = await Promise.all(servers.map(async (s) => ({ server: s, entry: await ensure(s) })));
  const tools: ToolSet = {};
  const instructions: string[] = [];
  for (const { server, entry } of ready) {
    if (entry.status !== "connected") continue;
    if (entry.instructions) instructions.push(`## ${server.name}\n${entry.instructions}`);
    const sorted = [...entry.tools].sort((a, b) => a.name.localeCompare(b.name));
    for (const raw of sorted) {
      if (server.disabledTools.includes(raw.name)) continue;
      tools[exposedToolName(server.name, raw.name)] = dynamicTool({
        description: raw.description ?? `${raw.name} (${server.name})`,
        inputSchema: jsonSchema(raw.inputSchema ?? { type: "object", properties: {} }),
        needsApproval: needsApproval(server, raw),
        execute: (args, { abortSignal }) => callTool(server, raw.name, args as Record<string, unknown>, abortSignal),
      });
    }
  }
  return {
    tools,
    instructions,
    servers: ready.map(({ server, entry }) => ({ name: server.name, status: entry.status, error: entry.error })),
  };
}

async function callTool(server: McpServerRecord, name: string, args: Record<string, unknown>, abortSignal?: AbortSignal) {
  const timeout = server.config.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const run = async () => {
    const entry = await ensure(server);
    if (!entry.client) throw new Error(`MCP server "${server.name}" is ${entry.status}: ${entry.error ?? ""}`);
    entry.lastUsed = Date.now();
    return (await entry.client.callTool({
      name,
      arguments: args,
      options: { timeout, signal: abortSignal },
    })) as ToolOutput;
  };
  let result: ToolOutput;
  try {
    result = await run();
  } catch (error) {
    // Reconnect once when the transport died. Not after a timeout: the tool may have run.
    if (!isConnectionLost(error) || abortSignal?.aborted) throw new Error(describeMcpError(error, timeout));
    await ensure(server, true);
    result = await run();
  }
  const text = toModelText(result);
  if (result.isError) throw new Error(text || "MCP tool returned an error");
  return text;
}

function describeMcpError(error: unknown, timeout: number): string {
  if (MCPClientError.isInstance(error) && /timed out/i.test(error.message)) return `Tool timed out after ${timeout / 1000}s`;
  return describeError(error);
}

// Close idle clients so stdio children and HTTP sessions do not pile up.
setInterval(() => {
  const now = Date.now();
  for (const entry of entries.values()) {
    if (now - entry.lastUsed > IDLE_CLOSE_MS && entry.client) {
      void closeClient(entry);
      entry.status = "idle";
    }
  }
}, 60_000).unref();
