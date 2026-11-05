import { chatgptRoutes } from "./chatgpt-oauth-routes.js";
import { n8nRoutes, agentSessionRoutes } from "./n8n/routes.js";
import { listChatTargets } from "./catalog/chat-targets.js";
import { agentUsage, threadAgentRequests } from "./n8n/store.js";
import { appearanceRoutes } from "./appearance.js";
import { accountRoutes } from "./account.js";
import { memoryRoutes } from "./memory.js";
import { auth as mcpAuth } from "@ai-sdk/mcp";
import { Hono } from "hono";
import { imagePartUpdates } from "../shared/media.js";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { McpServerConfig, UserSettings } from "../shared/types.js";
import { requireUser, type AppEnv } from "./auth.js";
import { newId } from "./crypto.js";
import { deleteConnection, getOwnConnection, listModels, listProviders, privateUrlError, saveConnection } from "./catalog/providers.js";
import { OLLAMA, OLLAMA_DEFAULT_URL } from "./catalog/ollama.js";
import { ollamaManagementRoutes } from "./catalog/ollama-routes.js";
import { adminRoutes, audienceInput } from "./admin.js";
import { permissionRoutes } from "./permissions/routes.js";
import { artifactRoutes } from "./artifacts.js";
import { chatRoutes } from "./chat.js";
import { emailRoutes } from "./email/routes.js";
import { draftRoutes } from "./email/draft-routes.js";
import { exportRoutes } from "./export.js";
import { fileRoutes } from "./files.js";
import { fontRoutes } from "./fonts.js";
import { knowledgeRoutes } from "./knowledge/routes.js";
import { collectionAccessible } from "./knowledge/store.js";
import { libraryRoutes } from "./library.js";
import { messageEditRoutes } from "./message-edits.js";
import { messageAnnotationRoutes } from "./message-annotations.js";
import { savedPromptRoutes } from "./saved-prompts.js";
import { clearAudience, setAudience } from "./groups.js";
import { getProject, projectRoutes } from "./projects.js";
import { scheduleRoutes } from "./schedules.js";
import { searchRoutes } from "./search.js";
import { serviceRoutes } from "./services.js";
import { shareRoutes } from "./shares.js";
import { skillRoutes } from "./skills.js";
import { settingsPatch } from "./settings-schema.js";
import { speechRoutes } from "./speech/routes.js";
import { voiceRoutes } from "./voice/routes.js";
import { deleteThreadImages, imageRoutes } from "./tools/image.js";
import { deleteSandboxWorkspace, sandboxRoutes } from "./tools/sandbox.js";
import { env } from "./env.js";
import { AppError, errorJson, handleAppError } from "./errors.js";
import { describeBoundaryError } from "./provider-errors.js";
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

// Thread and message ids are chosen by the client (assistant-ui), so only their shape is checked.
const clientId = z.string().min(1).max(200);

const originOf = (url: string | undefined) => (url ? new URL(url).origin : undefined);

/** Masked values ("••••••") from the UI mean "keep what is stored". */
function mergeSecrets(next?: Record<string, string>, prev?: Record<string, string>) {
  if (!next) return undefined;
  return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v === "••••••" ? (prev?.[k] ?? "") : v]));
}

const api = new Hono<AppEnv>()
  .use(requireUser)
  .route("/chatgpt", chatgptRoutes)
  .route("/agents/n8n", n8nRoutes())
  .route("/", agentSessionRoutes)
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
    if (!parsed.success) {
      return errorJson(c, new AppError({ code: "validation", message: `Invalid setting ${parsed.error.issues[0]?.path.join(".")}` }));
    }
    return c.json(updateSettings(c.get("user").id, parsed.data as Partial<UserSettings>));
  })
  .route("/", appearanceRoutes)
  .route("/account", accountRoutes)
  .route("/memory", memoryRoutes)
  .route("/voice", voiceRoutes)

  // Providers and models
  .get("/providers", async (c) => c.json(await listProviders(c.get("user").id)))
  .put("/providers/:id", async (c) => {
    const body = providerInput.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    const id = c.req.param("id");
    const userId = c.get("user").id;
    // An omitted or empty Ollama address still means loopback, so validate that effective URL.
    const stored = id === OLLAMA ? getOwnConnection(userId, OLLAMA)?.baseURL : undefined;
    const effective = id === OLLAMA && !body.data.baseURL ? (stored ?? OLLAMA_DEFAULT_URL) : body.data.baseURL;
    const blocked = await privateUrlError(userId, effective);
    if (blocked) return c.json({ error: blocked }, 400);
    saveConnection(userId, id, body.data);
    return c.json({ ok: true });
  })
  .delete("/providers/:id", (c) => {
    deleteConnection(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .route("/providers/ollama", ollamaManagementRoutes("user"))
  .get("/models", async (c) => c.json(await listChatTargets(c.get("user").id)))

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
    return thread ? c.json({ ...thread, usage: { ...threadUsage(c.get("user").id, thread.id), agentRequests: threadAgentRequests(c.get("user").id, thread.id) } }) : c.json({ error: "Not found" }, 404);
  })
  .patch("/threads/:id", async (c) => {
    const parsed = z.object({
      title: z.string().max(200).optional(),
      status: z.enum(["regular", "archived"]).optional(),
      memoryDisabled: z.boolean().optional(),
      pinned: z.boolean().optional(),
      projectId: z.string().nullable().optional(),
      modelRef: z.string().min(1).max(300).optional(),
      knowledgeIds: z.array(z.string().min(1).max(200)).max(20).optional(),
    }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid chat settings" }, 400);
    const userId = c.get("user").id;
    const thread = getThread(userId, c.req.param("id"));
    if (!thread) return c.json({ error: "Thread not found" }, 404);
    // A foreign project would expose its files and memories to this chat. Memory tools already offered
    // re-check the thread's project on every call, so a move needs no extra revocation here.
    if (parsed.data.projectId && !getProject(userId, parsed.data.projectId)) return c.json({ error: "Project not found" }, 404);
    // Attachment ids are ownership-checked here and again on every tool call. A collection bound to
    // another project cannot be attached through a forged request.
    const projectId = parsed.data.projectId === undefined ? thread.projectId : parsed.data.projectId;
    let knowledgeIds = parsed.data.knowledgeIds;
    if (knowledgeIds) {
      if (knowledgeIds.some((id) => !collectionAccessible(userId, id, projectId))) return c.json({ error: "Knowledge collection not found" }, 404);
    } else if (parsed.data.projectId !== undefined && thread.knowledgeIds.length) {
      // Moving a chat drops attachments that no longer apply to its project.
      knowledgeIds = thread.knowledgeIds.filter((id) => collectionAccessible(userId, id, projectId));
    }
    updateThread(userId, c.req.param("id"), { ...parsed.data, ...(knowledgeIds ? { knowledgeIds } : {}) });
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
    const row = appendMessage(c.get("user").id, c.req.param("id"), { ...parsed.data, parent_id: parsed.data.parent_id ?? null });
    return c.json({ ok: true, images: imagePartUpdates(row.content) });
  })
  .route("/", messageEditRoutes)
  .route("/", messageAnnotationRoutes)
  .route("/saved-prompts", savedPromptRoutes)

  // Usage
  .get("/usage", (c) => {
    const days = Number(c.req.query("days") ?? 30);
    const groupBy = (c.req.query("groupBy") ?? "day") as "day" | "model" | "provider" | "kind";
    const since = Date.now() - days * 86_400_000;
    return c.json({ agents: agentUsage(c.get("user").id, since), rows: usageSummary(c.get("user").id, groupBy, since), go: goWindows(c.get("user").id) });
  })

  // Storage
  .get("/storage", (c) => {
    const userId = c.get("user").id;
    return c.json({ used: storageUsed(userId), limit: userStorageLimit(userId), defaultLimit: env.storageLimit });
  })

  // Service health for this account (sidecars cached for a few seconds, no background loop).
  .route("/", serviceRoutes)

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
      if (String((error as Error).message).includes("UNIQUE")) return c.json({ error: "A server with that name exists." }, 400);
      // A failed test connection can carry the remote server's own text. Keep it in the log; send the taxonomy.
      return errorJson(c, describeBoundaryError(error, { kind: "background" }));
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
  .route("/knowledge", knowledgeRoutes)
  .route("/", libraryRoutes)
  .route("/", artifactRoutes)
  .route("/", imageRoutes)
  .route("/", speechRoutes)
  .route("/", sandboxRoutes)
  .route("/", scheduleRoutes)
  .route("/", projectRoutes)
  .route("/skills", skillRoutes)
  .route("/email", emailRoutes)
  .route("/email", draftRoutes)
  .route("/", searchRoutes)
  .route("/", shareRoutes)
  .route("/", adminRoutes)
  .route("/", permissionRoutes)
  // One API boundary: every sub-router's AppError becomes the same safe wire shape, also when a
  // router is mounted on its own in tests.
  .onError(handleAppError);

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
