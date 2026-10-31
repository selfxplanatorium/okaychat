import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../auth.js";
import { sharedModelAccess } from "../entitlements.js";
import {
  ollamaBaseURL,
  ollamaDelete,
  ollamaInventory,
  ollamaPull,
  ollamaStatus,
  OllamaError,
  type OllamaConnection,
} from "./ollama.js";
import { describeProviderError } from "../provider-errors.js";
import { errorJson } from "../errors.js";
import {
  getConnection,
  getOwnConnection,
  getSharedConnection,
  mayUsePrivateHosts,
  privateUrlError,
  type Connection,
} from "./providers.js";

/**
 * Native Ollama management. The user scope reads the connection the user can use (their own, else a
 * shared one) but only changes models through their own row. The admin scope edits the server-wide row.
 * See docs/implementation/ollama.md.
 */
export type OllamaScope = "user" | "admin";

const modelName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/, "Enter an Ollama model name without spaces.");

const address = z.string().trim().url().max(2048);
const testInput = z.object({ baseURL: address.optional() });
const pullInput = z.object({ model: modelName });
const deleteInput = z.object({ model: modelName });

/** Running pulls, so a double click or a second tab cannot start the same download twice. */
const pulls = new Set<string>();
const pullKey = (userId: string, conn: OllamaConnection) => `${userId}|${ollamaBaseURL(conn)}`;

function checkedAddress(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Enter an http or https Ollama address.";
    if (parsed.username || parsed.password) return "An Ollama address cannot contain a username or password.";
    if (parsed.search || parsed.hash) return "An Ollama address cannot contain a query or fragment.";
    return null;
  } catch {
    return "Enter a valid Ollama address, e.g. http://127.0.0.1:11434.";
  }
}

const normalized = (url: string | undefined) => (url ?? "").trim().replace(/\/+$/, "");

function lookupConnection(scope: OllamaScope, userId: string): Connection | undefined {
  return scope === "admin" ? getSharedConnection("ollama") : getConnection(userId, "ollama");
}

function storedConnection(scope: OllamaScope, userId: string): Connection {
  const conn = lookupConnection(scope, userId);
  if (!conn) {
    throw new HTTPException(404, {
      message: scope === "admin" ? "Connect the server-wide Ollama connection first." : "Connect Ollama first.",
    });
  }
  return conn;
}

/** Pull and delete need the row that owns the daemon; a viewer of a shared connection never mutates it. */
function mutableConnection(scope: OllamaScope, userId: string): Connection {
  if (scope === "admin") return storedConnection("admin", userId);
  const own = getOwnConnection(userId, "ollama");
  if (own) return own;
  if (getConnection(userId, "ollama")) {
    throw new HTTPException(403, { message: "Only the owner of the shared Ollama connection can pull or delete its models." });
  }
  throw new HTTPException(404, { message: "Connect Ollama first." });
}

function failure(c: Context<AppEnv>, error: unknown) {
  const status = error instanceof OllamaError && error.status === 404 ? 404 : 502;
  // Ollama's own body can echo a path or an arbitrary message; keep it in the log, send the taxonomy.
  return errorJson(c, describeProviderError(error, { provider: "ollama" }), status);
}

export function ollamaManagementRoutes(scope: OllamaScope) {
  return new Hono<AppEnv>()
    .get("/status", async (c) => {
      const conn = storedConnection(scope, c.get("user").id);
      try {
        return c.json({ ok: true, ...(await ollamaStatus(conn)) });
      } catch (error) {
        return failure(c, error);
      }
    })
    .post("/test", async (c) => {
      const body = testInput.safeParse(await c.req.json().catch(() => ({})));
      if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "Invalid address" }, 400);
      const userId = c.get("user").id;
      const stored = lookupConnection(scope, userId);
      const sameAsStored = !!stored?.baseURL && normalized(stored.baseURL) === normalized(body.data.baseURL);
      const candidate: OllamaConnection | undefined = body.data.baseURL
        ? sameAsStored
          // A viewer testing a server-wide connection inherits the admin's private-host trust.
          ? stored
          : { baseURL: body.data.baseURL, guarded: !mayUsePrivateHosts(userId) }
        : stored;
      if (!candidate) return c.json({ error: "Enter an Ollama address." }, 400);
      if (body.data.baseURL) {
        const invalid = checkedAddress(body.data.baseURL);
        if (invalid) return c.json({ error: invalid }, 400);
      }
      if (!sameAsStored) {
        const blocked = await privateUrlError(userId, candidate.baseURL);
        if (blocked) return c.json({ error: blocked }, 400);
      }
      try {
        return c.json({ ok: true, ...(await ollamaStatus(candidate)) });
      } catch (error) {
        return failure(c, error);
      }
    })
    .get("/models", async (c) => {
      const conn = storedConnection(scope, c.get("user").id);
      try {
        const inventory = await ollamaInventory(conn);
        if (scope === "user" && conn.shared) {
          const access = sharedModelAccess(c.get("user").id, "ollama");
          if (!access.all) {
            inventory.models = inventory.models.filter((model) => access.ids.has(model.name));
            inventory.status.modelCount = inventory.models.length;
            inventory.status.loadedCount = inventory.models.filter((model) => model.loaded).length;
          }
        }
        return c.json(inventory);
      } catch (error) {
        return failure(c, error);
      }
    })
    .post("/pull", async (c) => {
      const body = pullInput.safeParse(await c.req.json());
      if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "Invalid model name" }, 400);
      const userId = c.get("user").id;
      let conn: Connection;
      try {
        conn = mutableConnection(scope, userId);
      } catch (error) {
        const status = (error as HTTPException).status ?? 400;
        return c.json({ error: (error as Error).message }, status);
      }
      const key = pullKey(userId, conn);
      if (pulls.has(key)) return c.json({ error: "A pull is already running for this Ollama connection." }, 409);
      pulls.add(key);
      const encoder = new TextEncoder();
      // A downstream cancel (closed settings panel, client that stops reading) is not always reported
      // as a request abort. Abort the upstream pull ourselves, and only release the lock after the
      // generator has cleaned up, so a second download cannot overlap the first.
      const cancelPull = new AbortController();
      const signal = AbortSignal.any([c.req.raw.signal, cancelPull.signal]);
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: unknown) => {
            if (cancelled) return;
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            } catch {
              cancelled = true;
            }
          };
          try {
            for await (const progress of ollamaPull(conn, body.data.model, signal)) {
              if (cancelled || signal.aborted) break;
              send(progress);
            }
          } catch (error) {
            if (!cancelled && !signal.aborted) {
              // The progress channel shows one sentence; the raw daemon body is logged at the boundary.
              send({ error: describeProviderError(error, { provider: "ollama" }).message });
            }
          } finally {
            pulls.delete(key);
            if (!cancelled) {
              try {
                controller.close();
              } catch {
                // Closed by an aborted request.
              }
            }
          }
        },
        cancel() {
          cancelled = true;
          cancelPull.abort();
        },
      });
      return c.body(stream, 200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
    })
    .delete("/models", async (c) => {
      const body = deleteInput.safeParse(await c.req.json());
      if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "Invalid model name" }, 400);
      const userId = c.get("user").id;
      let conn: Connection;
      try {
        conn = mutableConnection(scope, userId);
      } catch (error) {
        const status = (error as HTTPException).status ?? 400;
        return c.json({ error: (error as Error).message }, status);
      }
      try {
        await ollamaDelete(conn, body.data.model);
        return c.json({ ok: true });
      } catch (error) {
        return failure(c, error);
      }
    });
}
