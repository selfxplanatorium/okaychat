import { assertMeteredService, withUnmeteredRoot } from "../credits/admission.js";
import { createHash } from "node:crypto";
import {
  createMCPClient,
  ElicitationRequestSchema,
  mcpAppClientCapabilities,
  MCPClientError,
  readMCPAppResource,
  UnauthorizedError,
  type ElicitResult,
  type MCPAppResource,
  type MCPClient,
} from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { dynamicTool, jsonSchema, tool, type ToolSet } from "ai";
import { z } from "zod";
import type { McpElicitation, McpPromptInfo, McpServerInfo, McpStatus, McpToolInfo } from "../../shared/types.js";
import { openElicitation } from "./elicitation.js";
import { mayUsePrivateHosts } from "../catalog/providers.js";
import { env } from "../env.js";
import { publicFetch } from "../public-fetch.js";
import { approvalRiskReason, externalMetadataFlag, injectionMetadata, riskMetadata, scanForInjection, wrapUntrusted, type UntrustedSource } from "../prompt-injection.js";
import { storeImage, type StoredImage } from "../tools/image.js";
import { MAX_TOOL_IMAGES_PER_TURN, type ToolImage } from "../tools/screenshots.js";
import { assertFeature, featureAllowed } from "../permissions/guard.js";
import { reserveOperation } from "../permissions/limits.js";
import { onPermissionChange } from "../permissions/audit.js";
import { StoredOAuthProvider } from "./oauth.js";
import { getAudience } from "../groups.js";
import { getVisibleServer, visibleServers, type McpServerRecord } from "./store.js";

// Rules from docs/implementation/mcp.md: @ai-sdk/mcp has no timeouts, no reconnect, and ignores
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
  _meta?: Record<string, unknown>;
}

/**
 * MCP Apps: a tool may name a `ui://` resource (HTML) the chat renders with its input and result, and say
 * who may call it. `["app"]` tools serve the app only and are hidden from the model.
 */
function uiMeta(tool: RawTool): { resourceUri?: string; visibility: Array<"model" | "app"> } {
  const meta = tool._meta ?? {};
  const ui = (meta.ui ?? {}) as { resourceUri?: unknown; visibility?: unknown };
  const uri = typeof ui.resourceUri === "string" ? ui.resourceUri : meta["ui/resourceUri"];
  const visibility = Array.isArray(ui.visibility) ? ui.visibility.filter((v): v is "model" | "app" => v === "model" || v === "app") : ["model", "app"];
  return { resourceUri: typeof uri === "string" && uri.startsWith("ui://") ? uri : undefined, visibility: visibility as Array<"model" | "app"> };
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
  // The baseline policy is the server's own explicit answer: an explicit `destructiveHint: false`
  // keeps the old no-prompt behaviour even when the tool is not read-only.
  return a?.destructiveHint === true || (a?.readOnlyHint === false && a.destructiveHint !== false);
}

/**
 * Writes or deletes by the server's own annotations, independent of the account's approval policy.
 * `destructiveHint: false` still means a non-read-only tool, which is enough to gate it after untrusted
 * content and to keep it away from unattended delegates.
 */
/** Only a tool that declares itself read-only may be called again after an ambiguous connection loss. */
function readOnlyTool(server: McpServerRecord, name: string): boolean {
  return entries.get(`${server.userId}:${server.id}`)?.tools.find((t) => t.name === name)?.annotations?.readOnlyHint === true;
}

function isDestructive(tool: RawTool): boolean {
  const a = tool.annotations;
  return a?.destructiveHint === true || a?.readOnlyHint === false;
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
  /** Server features beyond tools, from the initialize result. */
  capabilities: { resources: boolean; prompts: boolean };
  /** Tool calls in flight, newest last. An elicitation request goes to the newest one. */
  activeCalls: ActiveCall[];
  connecting?: Promise<void>;
  /** Set by disconnect. A connect still in flight closes what it opens instead of keeping an orphan client. */
  disposed?: boolean;
}

interface ActiveCall {
  timer: PausableTimeout;
  /** Absent when no one can answer (sub-agents, scheduled runs): the request is declined. */
  elicit?: (message: string, schema: unknown) => Promise<ElicitResult>;
}

/** A call's timeout that stops counting while the user fills in an elicitation form. */
class PausableTimeout {
  private readonly controller = new AbortController();
  private remaining: number;
  private startedAt = Date.now();
  private handle?: NodeJS.Timeout;
  fired = false;
  readonly signal = this.controller.signal;

  constructor(ms: number) {
    this.remaining = ms;
    this.start();
  }
  private start() {
    this.startedAt = Date.now();
    this.handle = setTimeout(() => {
      this.fired = true;
      this.controller.abort();
    }, this.remaining);
  }
  pause() {
    if (!this.handle) return;
    clearTimeout(this.handle);
    this.handle = undefined;
    this.remaining = Math.max(0, this.remaining - (Date.now() - this.startedAt));
  }
  resume() {
    if (!this.handle && !this.fired) this.start();
  }
  clear() {
    clearTimeout(this.handle);
    this.handle = undefined;
  }
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
  let client: MCPClient;
  try {
    client = await openClientWith(server, entry, true);
  } catch (error) {
    if (!isDiscoveryMismatch(error)) throw error;
    client = await openClientWith(server, entry, false);
  }
  client.onElicitationRequest(ElicitationRequestSchema, async (request) => {
    const call = entry.activeCalls.at(-1);
    if (!call?.elicit) return { action: "decline" };
    call.timer.pause();
    try {
      return await call.elicit(request.params.message, request.params.requestedSchema);
    } finally {
      call.timer.resume();
    }
  });
  return client;
}

async function openClientWith(server: McpServerRecord, entry: Entry, protocolVersionDiscovery: boolean): Promise<MCPClient> {
  const common = {
    protocolVersionDiscovery,
    clientName: "okaychat",
    version: env.version,
    // Form mode only: the spec forbids asking for secrets through forms, and URL mode needs a browser flow.
    capabilities: { elicitation: {}, ...mcpAppClientCapabilities },
    initializationOptions: { timeout: STARTUP_TIMEOUT_MS },
    onUncaughtError: (error: unknown) => {
      // list_changed arrives here as "Unsupported message type". Expire the cache so the next turn re-lists.
      if (String(error).includes("Unsupported message type")) entry.listedAt = 0;
    },
  };
  if (server.transport === "stdio") {
    if (!server.config.command) throw new Error("stdio server needs a command");
    // stdio runs as the server process. A demoted admin's servers must stop running, shared ones included.
    if (!mayUsePrivateHosts(server.ownerId)) throw new Error("Only admins can run stdio servers.");
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
      // The owner chose the URL, so the owner's network rules apply, also when an admin shares it.
      transport: { type: server.transport, url: server.config.url, headers: server.config.headers, authProvider, fetch: mcpFetch(server.ownerId) },
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

// Pagination bounds: a server that keeps returning a cursor must not hold every chat's turn forever.
const MAX_LIST_PAGES = 50;
const MAX_LIST_ITEMS = 2_000;

/** Follows `nextCursor` within the bounds above, stopping on a repeated cursor. */
async function paginate<T>(fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    cursor = result.nextCursor;
    if (!cursor || seen.has(cursor) || items.length >= MAX_LIST_ITEMS) break;
    seen.add(cursor);
  }
  return items.slice(0, MAX_LIST_ITEMS);
}

async function listAll(client: MCPClient): Promise<RawTool[]> {
  return paginate(async (cursor) => {
    const page = await client.listTools({ params: cursor ? { cursor } : undefined, options: { timeout: LIST_TIMEOUT_MS } });
    return { items: page.tools as RawTool[], nextCursor: page.nextCursor };
  });
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
      if (entry.disposed) {
        await closeClient(entry);
        return;
      }
      entry.tools = await listAll(entry.client);
      entry.instructions = entry.client.instructions;
      const caps = entry.client.initializeResult.capabilities as { resources?: unknown; prompts?: unknown };
      entry.capabilities = { resources: !!caps.resources, prompts: !!caps.prompts };
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

const CLOSE_TIMEOUT_MS = 5_000;

async function closeClient(entry: Entry) {
  const client = entry.client;
  entry.client = undefined;
  if (!client) return;
  // Closing a session can wait on a DELETE the server never answers; local cleanup must not.
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    client.close().catch(() => {}),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_TIMEOUT_MS))),
  ]);
  clearTimeout(timer);
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
      capabilities: { resources: false, prompts: false },
      activeCalls: [],
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
  // A running stdio child outlives its owner's admin role unless every use checks it again.
  if (server.transport === "stdio" && !mayUsePrivateHosts(server.ownerId)) {
    await closeClient(entry);
    entry.status = "error";
    entry.error = "Only admins can run stdio servers.";
    entry.tools = [];
    return entry;
  }
  if (entry.connecting) {
    await entry.connecting;
    return entry;
  }
  const stale = Date.now() - entry.listedAt > TOOL_LIST_TTL_MS;
  if (force || !entry.client || entry.status !== "connected") {
    // Connecting and discovering is one charged attempt, whatever the protocol's internal call count.
    const lease = reserveOperation({ userId: server.userId }, "mcp.connect");
    try {
      entry.connecting = connect(server, entry).finally(() => (entry.connecting = undefined));
      await entry.connecting;
    } finally {
      lease.release();
    }
  } else if (stale) {
    const lease = reserveOperation({ userId: server.userId }, "mcp.connect");
    try {
      entry.connecting = listAll(entry.client)
        .then((tools) => {
          entry.tools = tools;
          entry.listedAt = Date.now();
        })
        .catch(() => connect(server, entry))
        .finally(() => (entry.connecting = undefined));
      await entry.connecting;
    } finally {
      lease.release();
    }
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
  // Users of a shared server see where it points, never the owner's header names, command, or environment.
  if (server.ownerId !== server.userId) return { url: server.config.url, timeoutMs: server.config.timeoutMs, approval: server.config.approval };
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
    shared: server.shared,
    sharedWithMe: server.ownerId !== server.userId,
    ...(server.shared && server.ownerId === server.userId ? { audience: getAudience("mcp", server.id) } : {}),
    status: server.enabled ? (entry?.status ?? "idle") : "disabled",
    error: entry?.error,
    authorizationUrl: entry?.authorizationUrl,
    tools: entry ? toolInfos(server, entry) : [],
    config: maskConfig(server),
  };
}

export async function testServer(userId: string, serverId: string) {
  assertFeature(userId, "mcp");
  const server = getVisibleServer(userId, serverId);
  if (!server) throw new Error("MCP server not found");
  await ensure(server, true);
  return serverInfo(server);
}

export async function disconnectServer(userId: string, serverId: string) {
  const entry = entries.get(`${userId}:${serverId}`);
  if (entry) {
    entry.disposed = true;
    entries.delete(entry.key);
    await closeClient(entry);
  }
}

/** Closes every user's connection to a server, after its owner edits, unshares, or deletes it. */
export async function disconnectServerEverywhere(serverId: string) {
  await Promise.all([...entries.values()].filter((e) => e.serverId === serverId).map((e) => disconnectServer(e.userId, serverId)));
}

interface ContentPart {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
}
type ToolOutput = { content: ContentPart[]; isError?: boolean; structuredContent?: unknown };

/** One MCP result may carry this many images, each at most this size, before the rest are dropped. */
const MAX_IMAGES_PER_RESULT = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const base64Bytes = (data: string) => Math.floor((data.length * 3) / 4);

function toModelText(result: ToolOutput): string {
  const parts = (result.content ?? []).map((p) => {
    if (p.type === "text") return p.text ?? "";
    if (p.type === "image") return `[image ${p.mimeType ?? ""}]`;
    if (p.type === "audio") return `[audio ${p.mimeType ?? ""}, not supported]`;
    // Embedded resources: text inline, binary as a note so base64 never reaches the model as text.
    if (p.type === "resource" && p.resource) {
      if (typeof p.resource.text === "string") return p.resource.text;
      return `[resource ${p.resource.uri ?? ""} ${p.resource.mimeType ?? ""}, ${base64Bytes(p.resource.blob ?? "")} bytes, binary]`;
    }
    return JSON.stringify(p);
  });
  if (parts.length === 0 && result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return parts.join("\n");
}

/** What an MCP tool returns to the chat: text for the model, and saved images for the user. */
export interface McpToolResult {
  text: string;
  images: StoredImage[];
  /** Advisory scan of the text, shown as a quiet badge on the tool card. */
  injection?: ReturnType<typeof scanForInjection>;
  /** The tool has an MCP App: the card renders `resourceUri` and hands it `result`. */
  app?: { serverId: string; resourceUri: string };
  /** The call result for the app, without images. Kept with the message, so it is size-capped. */
  result?: { content: ContentPart[]; structuredContent?: unknown };
}

/** An app's copy of the result is stored with the chat message. Larger results are left out. */
const MAX_APP_RESULT_BYTES = 256 * 1024;

function appResult(result: ToolOutput): McpToolResult["result"] {
  const kept = { content: (result.content ?? []).filter((p) => p.type === "text"), structuredContent: result.structuredContent };
  return JSON.stringify(kept).length <= MAX_APP_RESULT_BYTES ? kept : { content: [{ type: "text", text: "The result is too large to show here." }] };
}

export interface McpTurnOptions {
  /** Saves returned images to this thread. Without it (sub-agents of temporary chats) images are only noted. */
  threadId?: string;
  /** Collects returned images by tool call id, for injection into the next step. Only for vision models. */
  images?: Map<string, ToolImage[]>;
  /** A user watches this turn and can answer elicitation forms. False for scheduled runs. */
  interactive?: boolean;
  /**
   * A restrictive assistant: connect only servers that own a selected tool, build only those tools, and
   * omit resources. Identity stays exact so two servers with the same tool name cannot widen the grant.
   */
  select?: Array<{ serverId: string; toolName: string }>;
}

async function presentResult(
  server: McpServerRecord,
  tool: string,
  source: UntrustedSource,
  result: ToolOutput,
  toolCallId: string,
  opts: McpTurnOptions,
  appUri?: string,
): Promise<McpToolResult> {
  const text = toModelText(result);
  // A thrown error reaches the model as error text without toModelOutput, so it gets the same envelope.
  if (result.isError) throw new Error(text ? wrapUntrusted(text, source).text : "MCP tool returned an error");
  const parts = (result.content ?? []).filter((p) => p.type === "image" && typeof p.data === "string");
  const app = appUri ? { app: { serverId: server.id, resourceUri: appUri }, result: appResult(result) } : {};
  const injection = scanForInjection(text);
  const scanned = injectionMetadata(injection) ? { injection } : {};
  if (!parts.length) return { text, images: [], ...scanned, ...app };
  // Images get their own summary and notes below, so the text leaves out their placeholders.
  const prose = toModelText({ ...result, content: (result.content ?? []).filter((p) => p.type !== "image") });
  const images: StoredImage[] = [];
  const forModel: ToolImage[] = [];
  const notes: string[] = [];
  const shownThisTurn = [...(opts.images?.values() ?? [])].reduce((n, list) => n + list.length, 0);
  for (const [index, part] of parts.entries()) {
    if (index >= MAX_IMAGES_PER_RESULT || base64Bytes(part.data!) > MAX_IMAGE_BYTES) {
      notes.push(`Image ${index + 1} was dropped (more than ${MAX_IMAGES_PER_RESULT} images or over 10 MB).`);
      continue;
    }
    const buf = Buffer.from(part.data!, "base64");
    // The server's mimeType is not trusted: storeImage sniffs the bytes, and only raster formats are kept.
    let stored: StoredImage | null = null;
    if (opts.threadId) {
      try {
        stored = await storeImage(server.userId, opts.threadId, buf, `${server.name} · ${tool}`);
        if (!stored) notes.push(`Image ${index + 1} is not a PNG, JPEG, WebP, or GIF and was dropped.`);
      } catch (error) {
        notes.push(`Image ${index + 1} could not be saved: ${(error as Error).message}`);
      }
    }
    if (stored) images.push(stored);
    const mediaType = stored?.mime ?? (/^image\/(png|jpeg|webp|gif)$/.test(part.mimeType ?? "") ? part.mimeType! : undefined);
    if (!mediaType || !opts.images) continue;
    if (shownThisTurn + forModel.length >= MAX_TOOL_IMAGES_PER_TURN) notes.push(`Image ${index + 1} is not shown to you: this reply reached its image limit.`);
    else forModel.push({ data: buf, mediaType });
  }
  if (forModel.length) opts.images?.set(toolCallId, forModel);
  const summary = images.length ? `[${images.length} image${images.length === 1 ? "" : "s"} shown to the user]` : "";
  const finalText = [prose, summary, ...notes].filter(Boolean).join("\n");
  const finalScan = scanForInjection(finalText);
  return { text: finalText, images, ...(injectionMetadata(finalScan) ? { injection: finalScan } : {}), ...app };
}

/**
 * Runs a tool call as a stream: while the server waits for the user, the form is yielded as a preliminary
 * output for the tool card, then the outcome. The last value yielded is the tool's result.
 */
async function* runWithElicitation<T>(
  server: McpServerRecord,
  signal: AbortSignal | undefined,
  interactive: boolean,
  run: (elicit?: ActiveCall["elicit"]) => Promise<T>,
): AsyncGenerator<T | { elicitation: McpElicitation }> {
  const updates: McpElicitation[] = [];
  let wake: (() => void) | undefined;
  const push = (view: McpElicitation) => {
    updates.push(view);
    wake?.();
  };
  const elicit = interactive
    ? async (message: string, schema: unknown): Promise<ElicitResult> => {
        const opened = openElicitation(server.userId, server.name, message, schema, signal);
        if (!opened) return { action: "decline" };
        push(opened.view);
        const answer = await opened.answer;
        push({ ...opened.view, answered: answer.action });
        return { ...answer };
      }
    : undefined;
  let finished: { value: T } | { error: unknown } | undefined;
  void run(elicit).then(
    (value) => {
      finished = { value };
      wake?.();
    },
    (error) => {
      finished = { error };
      wake?.();
    },
  );
  while (!finished || updates.length) {
    if (updates.length) {
      yield { elicitation: updates.shift()! };
      continue;
    }
    await new Promise<void>((resolve) => (wake = resolve));
  }
  if ("error" in finished) throw finished.error;
  yield finished.value;
}

// The model sees text only, spotlighted as third-party data. Images reach vision models through
// `McpTurnOptions.images`; the card still receives the raw object with its saved image URLs.
const mcpModelText = (output: unknown, source: UntrustedSource) => {
  const text = typeof output === "string" ? output : ((output as Partial<McpToolResult>).text ?? "");
  return { type: "text", value: wrapUntrusted(text, source).text } as const;
};

/** A resource read can be a whole file. The model gets this much text from one read. */
const MAX_RESOURCE_CHARS = 100_000;
const MAX_LISTED_RESOURCES = 200;

/**
 * Resources are read-only context a server offers (files, records, schemas). One pair of tools covers every
 * server that has them, so the tool block stays small. Reads go through the same image handling as tool results.
 */
function resourceTools(userId: string, servers: McpServerRecord[], opts: McpTurnOptions): ToolSet {
  if (!servers.length) return {};
  const names = servers.map((s) => s.name) as [string, ...string[]];
  const byName = (name: string) => servers.find((s) => s.name === name)!;
  const serverParam = z.enum(names).describe("MCP server name");
  return {
    mcp_list_resources: tool({
      description: `List the resources (files, records, documents) an MCP server offers, and URI templates for resources it can produce. Servers with resources: ${names.join(", ")}. Read one with mcp_read_resource.`,
      inputSchema: z.object({ server: serverParam, cursor: z.string().optional().describe("nextCursor from a previous call") }),
      execute: async ({ server, cursor }, { abortSignal }) => {
        assertFeature(userId, "mcp");
        const text = await listResourcesText(byName(server), cursor, abortSignal);
        const injection = scanForInjection(text);
        return { text, ...(injectionMetadata(injection) ? { injection } : {}) };
      },
      toModelOutput: ({ input, output }) =>
        mcpModelText(output.text, { kind: "mcp_resource_list", name: `resources on ${input.server}`, server: input.server }),
    }),
    mcp_read_resource: tool({
      description: "Read one MCP resource by URI, from mcp_list_resources or a filled-in URI template.",
      inputSchema: z.object({ server: serverParam, uri: z.string().min(1).max(2000) }),
      execute: async ({ server, uri }, { abortSignal, toolCallId }) => {
        assertFeature(userId, "mcp");
        const record = byName(server);
        const result = await withClient(record, (client, timeout) => client.readResource({ uri, options: { timeout, signal: abortSignal } }), abortSignal);
        const content: ContentPart[] = result.contents.map((c) => {
          const item = c as { uri: string; mimeType?: string; text?: string; blob?: string };
          if (typeof item.text === "string") return { type: "text", text: item.text.length > MAX_RESOURCE_CHARS ? `${item.text.slice(0, MAX_RESOURCE_CHARS)}\n[Truncated at ${MAX_RESOURCE_CHARS} characters]` : item.text };
          if (item.blob && item.mimeType?.startsWith("image/")) return { type: "image", data: item.blob, mimeType: item.mimeType };
          return { type: "resource", resource: item };
        });
        return presentResult(record, `resource ${uri}`, { kind: "mcp_resource", name: `resource ${uri}`, url: uri, server }, { content }, toolCallId, opts);
      },
      toModelOutput: ({ input, output }) =>
        mcpModelText(output, { kind: "mcp_resource", name: `resource ${input.uri}`, url: input.uri, server: input.server }),
    }),
  };
}

async function listResourcesText(server: McpServerRecord, cursor: string | undefined, signal?: AbortSignal): Promise<string> {
  return withClient(server, async (client, timeout) => {
    const page = await client.listResources({ params: cursor ? { cursor } : undefined, options: { timeout, signal } });
    // Templates are optional for servers; a failure only means there are none.
    const templates = cursor ? [] : await client.listResourceTemplates({ options: { timeout, signal } }).then((r) => r.resourceTemplates, () => []);
    const lines = page.resources.slice(0, MAX_LISTED_RESOURCES).map((r) => {
      const item = r as { uri: string; name?: string; title?: string; description?: string; mimeType?: string };
      return `- ${item.uri}${item.title ?? item.name ? ` — ${item.title ?? item.name}` : ""}${item.mimeType ? ` (${item.mimeType})` : ""}${item.description ? `: ${item.description}` : ""}`;
    });
    const templateLines = templates.map((t) => {
      const item = t as { uriTemplate: string; name?: string; description?: string };
      return `- ${item.uriTemplate}${item.name ? ` — ${item.name}` : ""}${item.description ? `: ${item.description}` : ""}`;
    });
    return [
      lines.length ? `Resources:\n${lines.join("\n")}` : "No resources listed.",
      templateLines.length ? `URI templates:\n${templateLines.join("\n")}` : "",
      page.nextCursor ? `More resources: call again with cursor "${page.nextCursor}".` : "",
    ].filter(Boolean).join("\n\n");
  }, signal);
}

/** Prompts from every enabled server that offers them. Servers that fail are skipped. */
export async function listPrompts(userId: string): Promise<McpPromptInfo[]> {
  assertFeature(userId, "mcp");
  const servers = visibleServers(userId).filter((s) => s.enabled);
  const lists = await Promise.all(
    servers.map(async (server) => {
      const entry = await ensure(server);
      if (entry.status !== "connected" || !entry.capabilities.prompts || !entry.client) return [];
      const lease = reserveOperation({ userId }, "mcp.call");
      try {
        const client = entry.client;
        const raw = await paginate(async (cursor) => {
          const page = await client.experimental_listPrompts({ params: cursor ? { cursor } : undefined, options: { timeout: LIST_TIMEOUT_MS } });
          return { items: page.prompts as Array<{ name: string; title?: string; description?: string; arguments?: McpPromptInfo["arguments"] }>, nextCursor: page.nextCursor };
        });
        return raw.slice(0, 500).map((p) => ({ serverId: server.id, server: server.name, name: p.name, title: p.title, description: p.description, arguments: p.arguments ?? [] }));
      } catch {
        return [];
      } finally {
        lease.release();
      }
    }),
  );
  return lists.flat();
}

/** A prompt's messages as text for the composer. Images and binary resources become notes. */
export async function getPromptText(userId: string, serverId: string, name: string, args: Record<string, string>): Promise<string> {
  assertFeature(userId, "mcp");
  const server = getVisibleServer(userId, serverId);
  if (!server?.enabled) throw new Error("MCP server not found");
  const result = await withClient(server, (client, timeout) => client.experimental_getPrompt({ name, arguments: args, options: { timeout } }));
  const text = result.messages
    .map((m) => {
      const c = m.content as ContentPart;
      if (c.type === "text") return c.text ?? "";
      return toModelText({ content: [c] });
    })
    .filter(Boolean)
    .join("\n\n");
  // This lands in the composer, visible and editable, but the author is the MCP server, not the user.
  // Emitting the same deterministic envelope from the start means sending it stays data-only and the
  // turn is tainted; the user can still inspect and edit the quoted request.
  return wrapUntrusted(text, { kind: "mcp_prompt", name: `${server.name} · ${name}`, server: server.name }).text;
}

/** Thrown when an app calls a tool the user must confirm first. */
export class AppCallNeedsConfirmation extends Error {}

async function appServer(userId: string, serverId: string) {
  const server = getVisibleServer(userId, serverId);
  if (!server?.enabled) throw new Error("MCP server not found");
  return server;
}

/** The HTML for an app card. Only `ui://` resources, read on the user's own connection. */
export async function readAppResource(userId: string, serverId: string, uri: string): Promise<MCPAppResource> {
  assertFeature(userId, "mcp");
  if (!uri.startsWith("ui://")) throw new Error("Not an MCP App resource");
  const server = await appServer(userId, serverId);
  return withClient(server, (client, timeout) => readMCPAppResource({ client, uri, options: { timeout } }));
}

/**
 * A call an app makes from its card. Only tools of the app's own server that the user left on and that the
 * server lets apps call; tools that would ask before running need the user's confirmation here too.
 */
export async function callToolFromApp(userId: string, serverId: string, name: string, args: Record<string, unknown>, confirmed: boolean): Promise<ToolOutput> {
  assertFeature(userId, "mcp");
  const server = await appServer(userId, serverId);
  const entry = await ensure(server);
  const raw = entry.tools.find((t) => t.name === name);
  if (!raw || server.disabledTools.includes(name) || !uiMeta(raw).visibility.includes("app")) throw new Error(`Tool "${name}" is not available to this app`);
  // An MCP App is third-party code running in an iframe, not a user click. Even an explicit `never`
  // policy does not let its JavaScript run a destructive or non-read-only tool on its own; the server
  // route turns the thrown confirmation into the existing 409 card, and a user Allow retries with
  // `confirmed: true`. Read-only tools still run automatically.
  if (isDestructive(raw) && !confirmed) {
    throw new AppCallNeedsConfirmation(
      approvalRiskReason("destructive", `The MCP App on "${server.name}" asked to run "${name}"`, "the call came from untrusted content in an MCP App, not from a user click"),
    );
  }
  if (needsApproval(server, raw) && !confirmed) throw new AppCallNeedsConfirmation(`Allow ${server.name} to run "${name}"?`);
  return callTool(server, name, args);
}

export async function readResourceFromApp(userId: string, serverId: string, uri: string) {
  assertFeature(userId, "mcp");
  const server = await appServer(userId, serverId);
  return withClient(server, (client, timeout) => client.readResource({ uri, options: { timeout } }));
}

export interface McpToolBundle {
  tools: ToolSet;
  /** For sub-agents: no tool that waits for approval, and elicitation requests are declined. */
  subTools: ToolSet;
  instructions: string[];
  servers: Array<{ name: string; status: McpStatus; error?: string }>;
  /** Exposed name → exact server/tool pair, so a restrictive policy can verify identity, not a label. */
  identities: Map<string, { serverId: string; toolName: string }>;
}

/** Tools from every enabled server for this user, ready for streamText. Sorted so the prompt prefix stays cacheable. */
export async function toolsForUser(userId: string, opts: McpTurnOptions = {}): Promise<McpToolBundle> {
  // A denied feature means no new connection, no discovery, and no tools. Spreads nothing to the model.
  if (!featureAllowed(userId, "mcp")) return { tools: {}, subTools: {}, instructions: [], servers: [], identities: new Map() };
  const selected = opts.select?.length
    ? new Map<string, Set<string>>()
    : null;
  for (const entry of opts.select ?? []) {
    const set = selected!.get(entry.serverId) ?? new Set<string>();
    set.add(entry.toolName);
    selected!.set(entry.serverId, set);
  }
  if (selected && !selected.size) {
    // Selected with no MCP tools means no MCP at all: no connection, no instructions, no resources.
    return { tools: {}, subTools: {}, instructions: [], servers: [], identities: new Map() };
  }
  // Under a selected policy, only servers that own a chosen tool are connected at all.
  const servers = visibleServers(userId).filter((s) => s.enabled && (!selected || selected.has(s.id)));
  const ready = await Promise.all(servers.map(async (s) => ({ server: s, entry: await ensure(s) })));
  const tools: ToolSet = {};
  const subTools: ToolSet = {};
  const instructions: string[] = [];
  const identities = new Map<string, { serverId: string; toolName: string }>();
  const build = (server: McpServerRecord, raw: RawTool, interactive: boolean) => {
    const thirdPartyDescription = raw.description?.trim();
    return dynamicTool({
      // Tool metadata is third-party text too. The description is enveloped and the tool is marked as
      // carrying external metadata, so even a first destructive call on an otherwise clean turn is gated.
      // Input-schema descriptions stay raw: the provider API constrains them to strings inside the JSON
      // schema, and wrapping them would change the schema every server sees. That is a documented limit.
      description: thirdPartyDescription
        ? wrapUntrusted(thirdPartyDescription, { kind: "mcp_tool", name: `${server.name} · ${raw.name}`, server: server.name }).text
        : `Third-party MCP tool from "${server.name}". ${raw.name}`,
      inputSchema: jsonSchema(raw.inputSchema ?? { type: "object", properties: {} }),
      ...((isDestructive(raw) || thirdPartyDescription)
        ? { metadata: { ...(isDestructive(raw) ? riskMetadata("destructive") : {}), ...(thirdPartyDescription ? externalMetadataFlag() : {}) } }
        : {}),
      needsApproval: needsApproval(server, raw),
      execute: (args, { abortSignal, toolCallId }) => {
        // Live feature check: a revoke during a turn closes this tool even though the set was already built.
        assertFeature(userId, "mcp");
        // The tool set is built once per turn; sharing, the server switch, a disabled tool, or a config
        // change can revoke it meanwhile, and a captured record would reconnect with the old secrets.
        const live = getVisibleServer(userId, server.id);
        if (!live?.enabled || live.disabledTools.includes(raw.name) || fingerprintOf(live) !== fingerprintOf(server)) {
          throw new Error(`The MCP tool "${raw.name}" from "${server.name}" is no longer available.`);
        }
        return runWithElicitation(server, abortSignal, interactive, async (elicit) =>
          presentResult(
            server,
            raw.name,
            { kind: "mcp_tool", name: `${server.name} · ${raw.name}`, server: server.name },
            await callTool(server, raw.name, args as Record<string, unknown>, abortSignal, elicit),
            toolCallId,
            opts,
            // Only an interactive chat has a screen to render the app on.
            interactive ? uiMeta(raw).resourceUri : undefined,
          ),
        );
      },
      toModelOutput: ({ output }) =>
        mcpModelText(output, { kind: "mcp_tool", name: `${server.name} · ${raw.name}`, server: server.name }),
    });
  };
  for (const { server, entry } of ready) {
    if (entry.status !== "connected") continue;
    if (entry.instructions) instructions.push(`## ${server.name}\n${entry.instructions}`);
    const sorted = [...entry.tools].sort((a, b) => a.name.localeCompare(b.name));
    const chosen = selected?.get(server.id);
    for (const raw of sorted) {
      if (chosen && !chosen.has(raw.name)) continue;
      if (server.disabledTools.includes(raw.name) || !uiMeta(raw).visibility.includes("model")) continue;
      let name = exposedToolName(server.name, raw.name);
      // Sanitizing is lossy ("a.b" and "a b" both become "a_b"); a collision must not silently replace
      // another server's tool, so the later one gets a hash of its real pair.
      if (tools[name]) name = `${name.slice(0, 55)}_${createHash("sha256").update(`${server.id}\0${raw.name}`).digest("hex").slice(0, 8)}`;
      tools[name] = build(server, raw, opts.interactive === true);
      identities.set(name, { serverId: server.id, toolName: raw.name });
      // Sub-agents run unattended: no tool that waits for approval, and no destructive tool even when
      // the account's policy is "never" (the output of a web or MCP read must not reach one).
      if (!needsApproval(server, raw) && !isDestructive(raw)) subTools[name] = build(server, raw, false);
    }
  }
  // A selected policy omits resources entirely: their server argument could otherwise bypass tool selectors.
  const resources = selected
    ? {}
    : resourceTools(userId, ready.filter(({ entry }) => entry.status === "connected" && entry.capabilities.resources).map(({ server }) => server), opts);
  Object.assign(tools, resources);
  Object.assign(subTools, resources);
  return {
    tools,
    subTools,
    instructions,
    servers: ready.map(({ server, entry }) => ({ name: server.name, status: entry.status, error: entry.error })),
    identities,
  };
}

async function callTool(server: McpServerRecord, name: string, args: Record<string, unknown>, abortSignal?: AbortSignal, elicit?: ActiveCall["elicit"]) {
  return withClient(
    server,
    async (client, timeout, entry) => {
      const call: ActiveCall = { timer: new PausableTimeout(timeout), elicit };
      entry.activeCalls.push(call);
      try {
        const signal = abortSignal ? AbortSignal.any([abortSignal, call.timer.signal]) : call.timer.signal;
        return (await client.callTool({ name, arguments: args, options: { signal } })) as ToolOutput;
      } catch (error) {
        if (call.timer.fired) throw new Error(`Tool timed out after ${timeout / 1000}s`);
        throw error;
      } finally {
        call.timer.clear();
        entry.activeCalls.splice(entry.activeCalls.indexOf(call), 1);
        entry.lastUsed = Date.now();
      }
    },
    abortSignal,
    // A lost connection does not mean the call did not run; replaying could send or charge twice.
    readOnlyTool(server, name),
  );
}

/** Runs one request on the server's client with its timeout. Reconnects once when the transport died. */
async function withClient<T>(
  server: McpServerRecord,
  run: (client: MCPClient, timeout: number, entry: Entry) => Promise<T>,
  abortSignal?: AbortSignal,
  replayable = true,
): Promise<T> {
  // One tool, resource, or prompt invocation is one charged operation, before the transport is touched.
  // A remote server can start paid work with no token price, so a finite allowance refuses it here,
  // at the executor, including approvals replayed from an earlier turn.
  assertMeteredService(server.userId, "mcp");
  const lease = reserveOperation({ userId: server.userId }, "mcp.call");
  try {
    return await withUnmeteredRoot(server.userId, "mcp", () => withClientWork(server, run, abortSignal, replayable));
  } finally {
    lease.release();
  }
}

async function withClientWork<T>(
  server: McpServerRecord,
  run: (client: MCPClient, timeout: number, entry: Entry) => Promise<T>,
  abortSignal?: AbortSignal,
  replayable = true,
): Promise<T> {
  const timeout = server.config.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const attempt = async () => {
    const entry = await ensure(server);
    if (!entry.client) throw new Error(`MCP server "${server.name}" is ${entry.status}: ${entry.error ?? ""}`);
    entry.lastUsed = Date.now();
    return run(entry.client, timeout, entry);
  };
  try {
    return await attempt();
  } catch (error) {
    // Not after a timeout: the request may have run.
    if (!isConnectionLost(error) || abortSignal?.aborted) throw new Error(describeMcpError(error, timeout));
    // Reconnect for later requests either way; only a read-only request runs again by itself.
    await ensure(server, true);
    if (!replayable) throw new Error(`The connection to "${server.name}" was lost during the call, so it may or may not have run. Check before trying again.`);
    return attempt();
  }
}

function describeMcpError(error: unknown, timeout: number): string {
  if (MCPClientError.isInstance(error) && /timed out/i.test(error.message)) return `Tool timed out after ${timeout / 1000}s`;
  return describeError(error);
}

// A revoke closes cached sessions for that account, so no retained handle can be reused; a later allow
// reconnects on demand. The listener is bounded by the number of live entries.
onPermissionChange(() => {
  for (const entry of [...entries.values()]) {
    if (featureAllowed(entry.userId, "mcp")) continue;
    void disconnectServer(entry.userId, entry.serverId);
  }
});

// Close idle clients so stdio children and HTTP sessions do not pile up.
setInterval(() => {
  const now = Date.now();
  for (const entry of entries.values()) {
    // A long call (timeouts go up to an hour) or a paused elicitation is not idle.
    if (now - entry.lastUsed > IDLE_CLOSE_MS && entry.client && !entry.activeCalls.length && !entry.connecting) {
      void closeClient(entry);
      entry.status = "idle";
    }
  }
}, 60_000).unref();
