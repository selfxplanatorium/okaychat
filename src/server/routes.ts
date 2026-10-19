import { appearanceRoutes } from "./appearance.js";
import { auth as mcpAuth } from "@ai-sdk/mcp";
import { Hono } from "hono";
import { z } from "zod";
import type { McpServerConfig, UserSettings } from "../shared/types.js";
import { requireUser, type AppEnv } from "./auth.js";
import { newId } from "./crypto.js";
import { deleteConnection, listModels, listProviders, saveConnection } from "./catalog/providers.js";
import { adminRoutes } from "./admin.js";
import { artifactRoutes } from "./artifacts.js";
import { chatRoutes } from "./chat.js";
import { fileRoutes } from "./files.js";
import { getProject, projectRoutes } from "./projects.js";
import { scheduleRoutes } from "./schedules.js";
import { searchRoutes } from "./search.js";
import { shareRoutes } from "./shares.js";
import { deleteThreadImages, imageRoutes } from "./tools/image.js";
import { callbackUrl, disconnectServer, serverInfo, testServer } from "./mcp/manager.js";
import { pendingByState, StoredOAuthProvider } from "./mcp/oauth.js";
import * as mcpStore from "./mcp/store.js";
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

/** Masked values ("••••••") from the UI mean "keep what is stored". */
function mergeSecrets(next?: Record<string, string>, prev?: Record<string, string>) {
  if (!next) return undefined;
  return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v === "••••••" ? (prev?.[k] ?? "") : v]));
}

const api = new Hono<AppEnv>()
  .use(requireUser)
  .get("/me", (c) => c.json(c.get("user")))
  .get("/settings", (c) => c.json(getSettings(c.get("user").id)))
  .patch("/settings", async (c) => {
    // Appearance has its own validated endpoint and must not be overwritten by a stale settings form.
    const { appearance: _appearance, ...patch } = (await c.req.json()) as Partial<UserSettings>;
    return c.json(updateSettings(c.get("user").id, patch));
  })
  .route("/", appearanceRoutes)

  // Providers and models
  .get("/providers", async (c) => c.json(await listProviders(c.get("user").id)))
  .put("/providers/:id", async (c) => {
    const body = providerInput.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
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
    updateThread(c.get("user").id, c.req.param("id"), (await c.req.json()) as { title?: string; status?: "regular" | "archived" });
    return c.json({ ok: true });
  })
  .delete("/threads/:id", async (c) => {
    deleteThread(c.get("user").id, c.req.param("id"));
    await deleteThreadImages(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .get("/threads/:id/messages", (c) => c.json(listMessages(c.get("user").id, c.req.param("id"))))
  .post("/threads/:id/messages", async (c) => {
    const row = (await c.req.json()) as { id: string; parent_id: string | null; format: string; content: unknown };
    appendMessage(c.get("user").id, c.req.param("id"), row);
    return c.json({ ok: true });
  })

  // Usage
  .get("/usage", (c) => {
    const days = Number(c.req.query("days") ?? 30);
    const groupBy = (c.req.query("groupBy") ?? "day") as "day" | "model" | "provider" | "kind";
    const since = Date.now() - days * 86_400_000;
    return c.json({ rows: usageSummary(c.get("user").id, groupBy, since), go: goWindows(c.get("user").id) });
  })

  // MCP servers
  .get("/mcp", (c) => c.json(mcpStore.listServers(c.get("user").id).map(serverInfo)))
  .post("/mcp", async (c) => {
    const user = c.get("user");
    const body = mcpInput.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    // stdio servers run as the server process. Only admins may add them.
    if (body.data.transport === "stdio" && user.role !== "admin") return c.json({ error: "Only admins can add stdio servers." }, 403);
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
    const config: McpServerConfig = {
      ...body.data.config,
      headers: mergeSecrets(body.data.config.headers, prev.config.headers),
      env: mergeSecrets(body.data.config.env, prev.config.env),
    };
    mcpStore.updateServer(user.id, prev.id, { ...body.data, config });
    await disconnectServer(user.id, prev.id);
    return c.json(body.data.enabled ? await testServer(user.id, prev.id) : serverInfo(mcpStore.getServer(user.id, prev.id)!));
  })
  .patch("/mcp/:id/tools", async (c) => {
    const user = c.get("user");
    const { disabledTools } = (await c.req.json()) as { disabledTools: string[] };
    mcpStore.updateServer(user.id, c.req.param("id"), { disabledTools });
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
  .route("/", artifactRoutes)
  .route("/", imageRoutes)
  .route("/", scheduleRoutes)
  .route("/", projectRoutes)
  .route("/", searchRoutes)
  .route("/", shareRoutes)
  .route("/", adminRoutes);

/** OAuth redirect target. Not behind requireUser: the state parameter identifies the user and server. */
export const mcpOAuthCallback = new Hono().get("/", async (c) => {
  const state = c.req.query("state") ?? "";
  const pending = pendingByState.get(state);
  const page = (message: string) =>
    c.html(`<!doctype html><meta charset="utf-8"><title>okaychat</title><body style="font-family:system-ui;padding:2rem">
      <p>${message}</p><script>window.opener?.postMessage({type:"okaychat:mcp-oauth"},location.origin);setTimeout(()=>window.close(),1200)</script></body>`);
  if (!pending) return page("This authorization link expired. Close this tab and click Authorize again.");
  pendingByState.delete(state);
  const server = mcpStore.getServer(pending.userId, pending.serverId);
  if (!server?.config.url) return page("MCP server not found.");
  const provider = new StoredOAuthProvider(pending.userId, pending.serverId, callbackUrl());
  try {
    await mcpAuth(provider, {
      serverUrl: server.config.url,
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
