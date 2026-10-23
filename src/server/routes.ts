import { appearanceRoutes } from "./appearance.js";
import { accountRoutes } from "./account.js";
import { memoryRoutes } from "./memory.js";
import { auth as mcpAuth } from "@ai-sdk/mcp";
import { Hono } from "hono";
import { z } from "zod";
import type { McpServerConfig, UserSettings } from "../shared/types.js";
import { requireUser, type AppEnv } from "./auth.js";
import { newId } from "./crypto.js";
import { deleteConnection, listModels, listProviders, mayUsePrivateHosts, saveConnection } from "./catalog/providers.js";
import { adminRoutes } from "./admin.js";
import { artifactRoutes } from "./artifacts.js";
import { chatRoutes } from "./chat.js";
import { exportRoutes } from "./export.js";
import { fileRoutes } from "./files.js";
import { fontRoutes } from "./fonts.js";
import { libraryRoutes } from "./library.js";
import { getProject, projectRoutes } from "./projects.js";
import { scheduleRoutes } from "./schedules.js";
import { searchRoutes } from "./search.js";
import { shareRoutes } from "./shares.js";
import { skillRoutes } from "./skills.js";
import { deleteThreadImages, imageRoutes } from "./tools/image.js";
import { deleteSandboxWorkspace, sandboxRoutes } from "./tools/sandbox.js";
import { env } from "./env.js";
import { assertPublicHost, BlockedAddressError } from "./public-fetch.js";
import { callbackUrl, disconnectServer, mcpFetch, notePublicOrigin, serverInfo, testServer } from "./mcp/manager.js";
import { StoredOAuthProvider, takePending } from "./mcp/oauth.js";
import * as mcpStore from "./mcp/store.js";
import { storageUsed, userStorageLimit } from "./quota.js";
import { getSettings, updateSettings } from "./settings.js";
import { appendMessage, deleteThread, ensureThread, getThread, listMessages, listThreads, updateThread } from "./threads.js";
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
    return c.json(listThreads(c.get("user").id, project === undefined ? undefined : project === "none" ? null : project));
  })
  .post("/threads", async (c) => {
    const user = c.get("user");
    const { id, projectId } = (await c.req.json()) as { id?: string; projectId?: string | null };
    // A project id from the client must belong to the user, or the thread would read another user's files.
    const project = projectId && getProject(user.id, projectId) ? projectId : null;
    return c.json(ensureThread(user.id, id ?? newId("thr"), project));
  })
  .get("/threads/:id", (c) => {
    const thread = getThread(c.get("user").id, c.req.param("id"));
    return thread ? c.json({ ...thread, usage: threadUsage(c.get("user").id, thread.id) }) : c.json({ error: "Not found" }, 404);
  })
  .patch("/threads/:id", async (c) => {
    const parsed = z.object({ title: z.string().max(200).optional(), status: z.enum(["regular", "archived"]).optional(), memoryDisabled: z.boolean().optional() }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid chat settings" }, 400);
    if (!getThread(c.get("user").id, c.req.param("id"))) return c.json({ error: "Thread not found" }, 404);
    updateThread(c.get("user").id, c.req.param("id"), parsed.data);
    return c.json({ ok: true });
  })
  .delete("/threads/:id", async (c) => {
    deleteThread(c.get("user").id, c.req.param("id"));
    await deleteThreadImages(c.get("user").id, c.req.param("id"));
    await deleteSandboxWorkspace(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .get("/threads/:id/messages", (c) => c.json(listMessages(c.get("user").id, c.req.param("id"))))
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
  .get("/mcp", (c) => c.json(mcpStore.listServers(c.get("user").id).map(serverInfo)))
  .post("/mcp", async (c) => {
    const user = c.get("user");
    const body = mcpInput.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    // stdio servers run as the server process. Only admins may add them.
    if (body.data.transport === "stdio" && user.role !== "admin") return c.json({ error: "Only admins can add stdio servers." }, 403);
    const blocked = await privateUrlError(user.id, body.data.transport === "stdio" ? undefined : body.data.config.url);
    if (blocked) return c.json({ error: blocked }, 400);
    // Every enabled server holds a live connection from this process.
    if (mcpStore.listServers(user.id).length >= 30) return c.json({ error: "You have the maximum of 30 MCP servers. Remove one first." }, 409);
    try {
      const id = mcpStore.createServer(user.id, body.data);
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
    if (moved) mcpStore.writeOAuth(prev.id, null);
    await disconnectServer(user.id, prev.id);
    return c.json(body.data.enabled ? await testServer(user.id, prev.id) : serverInfo(mcpStore.getServer(user.id, prev.id)!));
  })
  .patch("/mcp/:id/tools", async (c) => {
    const user = c.get("user");
    const parsed = z.object({ disabledTools: z.array(z.string().max(200)).max(1000) }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid tool list" }, 400);
    if (!mcpStore.getServer(user.id, c.req.param("id"))) return c.json({ error: "Not found" }, 404);
    mcpStore.updateServer(user.id, c.req.param("id"), { disabledTools: parsed.data.disabledTools });
    return c.json(serverInfo(mcpStore.getServer(user.id, c.req.param("id"))!));
  })
  .post("/mcp/:id/test", async (c) => c.json(await testServer(c.get("user").id, c.req.param("id"))))
  .delete("/mcp/:id", async (c) => {
    const user = c.get("user");
    await disconnectServer(user.id, c.req.param("id"));
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
  const server = mcpStore.getServer(pending.userId, pending.serverId);
  if (!server?.config.url) return page("MCP server not found.");
  const provider = new StoredOAuthProvider(pending.userId, pending.serverId, callbackUrl(pending.userId));
  try {
    await mcpAuth(provider, {
      serverUrl: server.config.url,
      fetchFn: mcpFetch(pending.userId),
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
