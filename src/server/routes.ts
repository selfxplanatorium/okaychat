import { appearanceRoutes } from "./appearance.js";
import { accountRoutes } from "./account.js";
import { memoryRoutes } from "./memory.js";
import { auth as mcpAuth } from "@ai-sdk/mcp";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { McpServerConfig, UserSettings } from "../shared/types.js";
import { requireUser, type AppEnv } from "./auth.js";
import { newId } from "./crypto.js";
import { deleteConnection, listModels, listProviders, mayUsePrivateHosts, saveConnection } from "./catalog/providers.js";
import { adminRoutes, audienceInput } from "./admin.js";
import { artifactRoutes } from "./artifacts.js";
import { chatRoutes } from "./chat.js";
import { exportRoutes } from "./export.js";
import { fileRoutes } from "./files.js";
import { fontRoutes } from "./fonts.js";
import { libraryRoutes } from "./library.js";
import { clearAudience, setAudience } from "./groups.js";
import { getProject, projectRoutes } from "./projects.js";
import { scheduleRoutes } from "./schedules.js";
import { searchRoutes } from "./search.js";
import { shareRoutes } from "./shares.js";
import { skillRoutes } from "./skills.js";
import { deleteThreadImages, imageRoutes } from "./tools/image.js";
import { deleteSandboxWorkspace, sandboxRoutes } from "./tools/sandbox.js";
import { env } from "./env.js";
import { assertPublicHost, BlockedAddressError } from "./public-fetch.js";
import {
  AppCallNeedsConfirmation,
  callbackUrl,
  callToolFromApp,
  disconnectServer,
  disconnectServerEverywhere,
  getPromptText,
  listPrompts,
  mcpFetch,
  notePublicOrigin,
  readAppResource,
  readResourceFromApp,
  serverInfo,
  testServer,
} from "./mcp/manager.js";
import { answerElicitation } from "./mcp/elicitation.js";
import { StoredOAuthProvider, takePending } from "./mcp/oauth.js";
import * as mcpStore from "./mcp/store.js";
import { storageUsed, userStorageLimit } from "./quota.js";
import { getSettings, updateSettings } from "./settings.js";
import { appendMessage, branchThread, deleteThread, ensureThread, getThread, listMessagesJson, listThreads, updateThread } from "./threads.js";
import { goWindows, threadUsage, usageSummary } from "./usage.js";

const providerInput = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().url().or(z.literal("")).optional(),
  name: z.string().max(60).optional(),
  enabled: z.boolean().optional(),
});

const mcpInput = z.object({
  name: z.string().trim().min(1).max(40).regex(/^[\w .-]+$/, "Letters, numbers, spaces, dot, dash"),
  transport: z.enum(["http", "sse", "stdio"]),
  enabled: z.boolean().default(true),
  shared: z.boolean().default(false),
  // Who a shared server is for. Omitted on update keeps the current audience.
  audience: audienceInput.optional(),
  config: z.object({
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
    approval: z.enum(["destructive", "always", "never"]).optional(),
  }),
});

/**
 * Non-admins may only point connections at the public internet, or any user could read the server's
 * network through a provider or MCP URL. Requests are checked again at connection time.
 */
async function privateUrlError(userId: string, url: string | undefined): Promise<string | null> {
  if (!url || mayUsePrivateHosts(userId)) return null;
  try {
    await assertPublicHost(new URL(url));
    return null;
  } catch (error) {
    return error instanceof BlockedAddressError ? "Only admins can use local or private network addresses." : (error as Error).message;
  }
}

const modelRef = z.string().min(1).max(300);
// Thread and message ids are chosen by the client (assistant-ui), so only their shape is checked.
const clientId = z.string().min(1).max(200);
const settingsPatch = z.object({
  // Checked against the known values in updateSettings.
  sidebarItems: z.array(z.string()).max(50).optional(),
  keyboard: z.object({
    bindings: z.record(z.string().regex(/^[a-z][a-zA-Z0-9.]{0,63}$/), z.array(z.string().min(1).max(48).regex(/^[\x21-\x7e]+$/)).max(4))
      .refine((value) => Object.keys(value).length <= 200, "too many commands").optional(),
    sendWith: z.enum(["enter", "modEnter"]).optional(),
    singleKeys: z.boolean().optional(),
  }).strict().optional(),
  maxSteps: z.number().optional(),
  maxSearches: z.number().optional(),
  imageServices: z.record(z.string(), z.unknown()).optional(),
  defaultModel: modelRef.nullable().optional(),
  utilityModel: modelRef.nullable().optional(),
  subagentModel: modelRef.nullable().optional(),
  favoriteModels: z.array(modelRef).max(500).optional(),
  reasoningEffort: z.record(modelRef, z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]))
    .refine((value) => Object.keys(value).length <= 500, "too many models").optional(),
  systemPrompt: z.string().max(50_000).optional(),
  autoCompactAt: z.number().min(0).max(1).optional(),
  trimBeforeCompact: z.boolean().optional(),
  webTools: z.boolean().optional(),
  artifacts: z.boolean().optional(),
  generativeUI: z.boolean().optional(),
  subagents: z.boolean().optional(),
  codeExecution: z.boolean().optional(),
});

const originOf = (url: string | undefined) => (url ? new URL(url).origin : undefined);

/** Masked values ("••••••") from the UI mean "keep what is stored". */
function mergeSecrets(next?: Record<string, string>, prev?: Record<string, string>) {
  if (!next) return undefined;
  return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v === "••••••" ? (prev?.[k] ?? "") : v]));
}

const api = new Hono<AppEnv>()
  .use(requireUser)
  .use(async (c, next) => {
    // Learn the OAuth redirect origin only from signed-in requests. Any anonymous request could otherwise
    // set a forged Host first and receive every user's authorization codes.
    const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
    if (host) notePublicOrigin(c.get("user").id, `${proto ?? new URL(c.req.url).protocol.replace(":", "")}://${host}`);
    await next();
  })
  .get("/me", (c) => c.json(c.get("user")))
  .get("/settings", (c) => c.json(getSettings(c.get("user").id)))
  .patch("/settings", async (c) => {
    // Unknown keys are dropped. Appearance has its own validated endpoint and must not be overwritten by a stale settings form.
    const parsed = settingsPatch.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: `Invalid setting ${parsed.error.issues[0]?.path.join(".")}` }, 400);
    return c.json(updateSettings(c.get("user").id, parsed.data as Partial<UserSettings>));
  })
  .route("/", appearanceRoutes)
  .route("/account", accountRoutes)
  .route("/memory", memoryRoutes)

  // Providers and models
  .get("/providers", async (c) => c.json(await listProviders(c.get("user").id)))
  .put("/providers/:id", async (c) => {
    const body = providerInput.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    const blocked = await privateUrlError(c.get("user").id, body.data.baseURL);
    if (blocked) return c.json({ error: blocked }, 400);
    saveConnection(c.get("user").id, c.req.param("id"), body.data);
    return c.json({ ok: true });
  })
  .delete("/providers/:id", (c) => {
    deleteConnection(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .get("/models", async (c) => c.json(await listModels(c.get("user").id)))

  // Threads and history (assistant-ui ThreadHistoryAdapter rows)
  .get("/threads", (c) => {
    const project = c.req.query("project");
    const status = c.req.query("status");
    if (status !== undefined && status !== "regular" && status !== "archived") return c.json({ error: "Invalid status" }, 400);
    return c.json(listThreads(c.get("user").id, project === undefined ? undefined : project === "none" ? null : project, status));
  })
  .post("/threads", async (c) => {
    const user = c.get("user");
    const parsed = z.object({ id: clientId.optional(), projectId: z.string().max(200).nullable().optional() }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid chat" }, 400);
    const { id, projectId } = parsed.data;
    // A project id from the client must belong to the user, or the thread would read another user's files.
    const project = projectId && getProject(user.id, projectId) ? projectId : null;
    return c.json(ensureThread(user.id, id ?? newId("thr"), project));
  })
  .get("/threads/:id", (c) => {
    const thread = getThread(c.get("user").id, c.req.param("id"));
    return thread ? c.json({ ...thread, usage: threadUsage(c.get("user").id, thread.id) }) : c.json({ error: "Not found" }, 404);
  })
  .patch("/threads/:id", async (c) => {
    const parsed = z.object({
      title: z.string().max(200).optional(),
      status: z.enum(["regular", "archived"]).optional(),
      memoryDisabled: z.boolean().optional(),
      pinned: z.boolean().optional(),
      projectId: z.string().nullable().optional(),
      modelRef: z.string().min(1).max(300).optional(),
    }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid chat settings" }, 400);
    const userId = c.get("user").id;
    if (!getThread(userId, c.req.param("id"))) return c.json({ error: "Thread not found" }, 404);
    // A foreign project would expose its files and memories to this chat. Memory tools already offered
    // re-check the thread's project on every call, so a move needs no extra revocation here.
    if (parsed.data.projectId && !getProject(userId, parsed.data.projectId)) return c.json({ error: "Project not found" }, 404);
    updateThread(userId, c.req.param("id"), parsed.data);
    return c.json({ ok: true });
  })
  .delete("/threads/:id", async (c) => {
    deleteThread(c.get("user").id, c.req.param("id"));
    await deleteThreadImages(c.get("user").id, c.req.param("id"));
    await deleteSandboxWorkspace(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .post("/threads/:id/branch", async (c) => {
    const parsed = z.object({ messageId: z.string().min(1).max(200), modelRef: z.string().min(1).max(300).optional() }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid branch" }, 400);
    return c.json(branchThread(c.get("user").id, c.req.param("id"), parsed.data.messageId, newId("thr"), parsed.data.modelRef));
  })
  .route("/", exportRoutes)
  .get("/threads/:id/messages", (c) => c.body(listMessagesJson(c.get("user").id, c.req.param("id")), 200, { "Content-Type": "application/json" }))
  .post("/threads/:id/messages", async (c) => {
    const parsed = z.object({
      id: clientId,
      parent_id: clientId.nullable().optional(),
      format: z.string().min(1).max(40),
      content: z.record(z.string(), z.unknown()),
    }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid message" }, 400);
    appendMessage(c.get("user").id, c.req.param("id"), { ...parsed.data, parent_id: parsed.data.parent_id ?? null });
    return c.json({ ok: true });
  })

  // Usage
  .get("/usage", (c) => {
    const days = Number(c.req.query("days") ?? 30);
    const groupBy = (c.req.query("groupBy") ?? "day") as "day" | "model" | "provider" | "kind";
    const since = Date.now() - days * 86_400_000;
    return c.json({ rows: usageSummary(c.get("user").id, groupBy, since), go: goWindows(c.get("user").id) });
  })

  // Storage
  .get("/storage", (c) => {
    const userId = c.get("user").id;
    return c.json({ used: storageUsed(userId), limit: userStorageLimit(userId), defaultLimit: env.storageLimit });
  })

  // MCP servers
  .get("/mcp", (c) => c.json(mcpStore.visibleServers(c.get("user").id).map(serverInfo)))
  // Before the `/mcp/:id` routes, which would shadow it.
  .get("/mcp/prompts", async (c) => c.json(await listPrompts(c.get("user").id)))
  // The user's answer to a form an MCP server opened during a tool call.
  .post("/mcp/elicitations/:id", async (c) => {
    const parsed = z
      .object({
        action: z.enum(["accept", "decline", "cancel"]),
        content: z.record(z.string().max(200), z.union([z.string().max(20_000), z.number(), z.boolean(), z.array(z.string().max(2000)).max(100)])).optional(),
      })
      .safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid answer" }, 400);
    try {
      if (!answerElicitation(c.get("user").id, c.req.param("id"), parsed.data)) return c.json({ error: "This request is no longer waiting." }, 404);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    return c.json({ ok: true });
  })
  // MCP Apps: the card's HTML, and the requests its bridge forwards. All run on the user's own connection.
  .post("/mcp/:id/app/resource", async (c) => {
    const parsed = z.object({ uri: z.string().min(1).max(2000) }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid resource" }, 400);
    try {
      return c.json(await readAppResource(c.get("user").id, c.req.param("id"), parsed.data.uri));
    } catch (error) {
      throw new HTTPException(400, { message: (error as Error).message });
    }
  })
  .post("/mcp/:id/app/call", async (c) => {
    const parsed = z
      .object({ name: z.string().min(1).max(200), arguments: z.record(z.string(), z.unknown()).default({}), confirmed: z.boolean().default(false) })
      .safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid tool call" }, 400);
    try {
      return c.json(await callToolFromApp(c.get("user").id, c.req.param("id"), parsed.data.name, parsed.data.arguments, parsed.data.confirmed));
    } catch (error) {
      if (error instanceof AppCallNeedsConfirmation) return c.json({ error: error.message, needsConfirmation: true }, 409);
      throw new HTTPException(400, { message: (error as Error).message });
    }
  })
  .post("/mcp/:id/app/read", async (c) => {
    const parsed = z.object({ uri: z.string().min(1).max(2000) }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid resource" }, 400);
    try {
      return c.json(await readResourceFromApp(c.get("user").id, c.req.param("id"), parsed.data.uri));
    } catch (error) {
      throw new HTTPException(400, { message: (error as Error).message });
    }
  })
  .post("/mcp/:id/prompts", async (c) => {
    const parsed = z
      .object({ name: z.string().min(1).max(200), arguments: z.record(z.string().max(200), z.string().max(20_000)).default({}) })
      .safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid prompt request" }, 400);
    try {
      return c.json({ text: await getPromptText(c.get("user").id, c.req.param("id"), parsed.data.name, parsed.data.arguments) });
    } catch (error) {
      throw new HTTPException(400, { message: (error as Error).message });
    }
  })
  .post("/mcp", async (c) => {
    const user = c.get("user");
    const body = mcpInput.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    // stdio servers run as the server process. Only admins may add them.
    if (body.data.transport === "stdio" && user.role !== "admin") return c.json({ error: "Only admins can add stdio servers." }, 403);
    if (body.data.shared && user.role !== "admin") return c.json({ error: "Only admins can share servers." }, 403);
    const blocked = await privateUrlError(user.id, body.data.transport === "stdio" ? undefined : body.data.config.url);
    if (blocked) return c.json({ error: blocked }, 400);
    if (mcpStore.listSharedServers(user.id).some((s) => s.name.toLowerCase() === body.data.name.toLowerCase())) {
      return c.json({ error: "An admin shares a server with that name. Pick another name." }, 400);
    }
    // Every enabled server holds a live connection from this process.
    if (mcpStore.listServers(user.id).length >= 30) return c.json({ error: "You have the maximum of 30 MCP servers. Remove one first." }, 409);
    try {
      const id = mcpStore.createServer(user.id, body.data);
      if (body.data.shared && body.data.audience) setAudience("mcp", id, body.data.audience);
      return c.json(await testServer(user.id, id));
    } catch (error) {
      return c.json({ error: String((error as Error).message).includes("UNIQUE") ? "A server with that name exists." : (error as Error).message }, 400);
    }
  })
  .put("/mcp/:id", async (c) => {
    const user = c.get("user");
    const body = mcpInput.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    const prev = mcpStore.getServer(user.id, c.req.param("id"));
    if (!prev) return c.json({ error: "Not found" }, 404);
    if (body.data.transport === "stdio" && user.role !== "admin") return c.json({ error: "Only admins can add stdio servers." }, 403);
    if (body.data.shared && user.role !== "admin") return c.json({ error: "Only admins can share servers." }, 403);
    const blocked = await privateUrlError(user.id, body.data.transport === "stdio" ? undefined : body.data.config.url);
    if (blocked) return c.json({ error: blocked }, 400);
    // Stored header values and OAuth tokens belong to the old server. They must not follow a new origin.
    const moved = originOf(body.data.config.url) !== originOf(prev.config.url);
    if (moved && Object.values(body.data.config.headers ?? {}).includes("••••••")) {
      return c.json({ error: "Enter the header values again when changing the server URL." }, 400);
    }
    const config: McpServerConfig = {
      ...body.data.config,
      headers: mergeSecrets(body.data.config.headers, prev.config.headers),
      env: mergeSecrets(body.data.config.env, prev.config.env),
    };
    mcpStore.updateServer(user.id, prev.id, { ...body.data, config });
    if (!body.data.shared) clearAudience("mcp", prev.id);
    else if (body.data.audience) setAudience("mcp", prev.id, body.data.audience);
    if (moved) {
      mcpStore.writeOAuth(user.id, prev.id, null);
      mcpStore.clearSharedOAuth(prev.id);
    }
    // Users of a shared server reconnect with the new settings, or lose it when it is no longer shared.
    await disconnectServerEverywhere(prev.id);
    return c.json(body.data.enabled ? await testServer(user.id, prev.id) : serverInfo(mcpStore.getServer(user.id, prev.id)!));
  })
  // The parts of a server each user controls, including on servers an admin shares with them.
  .patch("/mcp/:id/tools", async (c) => {
    const user = c.get("user");
    const parsed = z
      .object({ enabled: z.boolean().optional(), disabledTools: z.array(z.string().max(200)).max(1000).optional() })
      .safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid tool list" }, 400);
    const server = mcpStore.getVisibleServer(user.id, c.req.param("id"));
    if (!server) return c.json({ error: "Not found" }, 404);
    if (server.ownerId === user.id) mcpStore.updateServer(user.id, server.id, parsed.data);
    else mcpStore.updateSharedPrefs(user.id, server.id, parsed.data);
    if (parsed.data.enabled === false) await disconnectServer(user.id, server.id);
    if (parsed.data.enabled === true) return c.json(await testServer(user.id, server.id));
    return c.json(serverInfo(mcpStore.getVisibleServer(user.id, server.id)!));
  })
  .post("/mcp/:id/test", async (c) => c.json(await testServer(c.get("user").id, c.req.param("id"))))
  .delete("/mcp/:id", async (c) => {
    const user = c.get("user");
    if (!mcpStore.getServer(user.id, c.req.param("id"))) return c.json({ error: "Not found" }, 404);
    await disconnectServerEverywhere(c.req.param("id"));
    mcpStore.deleteServer(user.id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .route("/", chatRoutes)
  .route("/", fileRoutes)
  .route("/", fontRoutes)
  .route("/", libraryRoutes)
  .route("/", artifactRoutes)
  .route("/", imageRoutes)
  .route("/", sandboxRoutes)
  .route("/", scheduleRoutes)
  .route("/", projectRoutes)
  .route("/skills", skillRoutes)
  .route("/", searchRoutes)
  .route("/", shareRoutes)
  .route("/", adminRoutes);

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** OAuth redirect target. Not behind requireUser: the state parameter identifies the user and server. */
export const mcpOAuthCallback = new Hono().get("/", async (c) => {
  const state = c.req.query("state") ?? "";
  const pending = takePending(state);
  // Server names and errors from the remote authorization server are untrusted text.
  const page = (message: string) =>
    c.html(`<!doctype html><meta charset="utf-8"><title>okaychat</title><body style="font-family:system-ui;padding:2rem">
      <p>${escapeHtml(message)}</p><script>window.opener?.postMessage({type:"okaychat:mcp-oauth"},location.origin);setTimeout(()=>window.close(),1200)</script></body>`);
  if (!pending) return page("This authorization link expired. Close this tab and click Authorize again.");
  const server = mcpStore.getVisibleServer(pending.userId, pending.serverId);
  if (!server?.config.url) return page("MCP server not found.");
  const provider = new StoredOAuthProvider(pending.userId, pending.serverId, callbackUrl(pending.userId));
  try {
    await mcpAuth(provider, {
      serverUrl: server.config.url,
      fetchFn: mcpFetch(server.ownerId),
      authorizationCode: c.req.query("code"),
      callbackState: state,
      callbackIssuer: c.req.query("iss"),
    });
    await testServer(pending.userId, pending.serverId);
    return page(`Connected ${server.name}. You can close this tab.`);
  } catch (error) {
    return page(`Authorization failed: ${(error as Error).message}`);
  }
});

export { api };
