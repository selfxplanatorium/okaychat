import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { EmailDiscoveryEvent } from "../../shared/email.js";
import type { AppEnv } from "../auth.js";
import {
  accountSecrets,
  authMethods,
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  parseAccountDraft,
  recordCheck,
  setDefaultAccount,
  updateAccount,
} from "./accounts.js";
import { discoverEmail } from "./discover.js";
import type { EmailSecrets } from "./accounts.js";
import { mapEmailError } from "./errors.js";
import { verifyAccount } from "./imap.js";

// REST API for settings. Account CRUD is owned and validated in accounts.ts; discovery streams one
// NDJSON line per attempt so the wizard can show progress instead of a spinner. Decrypted passwords
// are never returned: the public account shape contains only server addresses and usernames.

const discoverInput = z.object({
  email: z.string().trim().min(3).max(254),
  allowInsecureProbe: z.boolean().optional(),
}).strict();

const testDraftInput = z.object({
  address: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(1024),
  imap: z.object({ host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535), security: z.enum(["tls", "starttls"]), username: z.string().min(1).max(320) }),
  smtp: z.object({ host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535), security: z.enum(["tls", "starttls"]), username: z.string().min(1).max(320) }),
  allowInsecureProbe: z.boolean().optional(),
}).strict();

function message(error: unknown): string {
  return mapEmailError(error).message;
}

function syntheticSecrets(userId: string, draft: Awaited<ReturnType<typeof parseAccountDraft>>): EmailSecrets {
  const now = Date.now();
  return {
    userId,
    account: {
      id: "draft",
      label: draft.address,
      address: draft.address,
      imap: draft.imap,
      smtp: draft.smtp,
      readEnabled: true,
      sendEnabled: true,
      isDefault: false,
      signature: "",
      allowInsecureProbe: draft.allowInsecureProbe,
      lastCheckAt: null,
      lastCheckStatus: null,
      lastCheckError: null,
      createdAt: now,
      updatedAt: now,
    },
    password: draft.password,
    imap: draft.imap,
    smtp: draft.smtp,
  };
}

export const emailRoutes = new Hono<AppEnv>()
  .get("/accounts", (c) => c.json(listAccounts(c.get("user").id)))
  .get("/auth-methods", (c) => c.json(authMethods()))
  .post("/discover", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const parsed = discoverInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter the email address to look up." }, 400);
    const userId = c.get("user").id;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const send = (event: EmailDiscoveryEvent) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            closed = true;
          }
        };
        try {
          const result = await discoverEmail({
            userId,
            email: parsed.data.email,
            allowInsecureProbe: parsed.data.allowInsecureProbe,
            signal: c.req.raw.signal,
            onAttempt: (attempt) => send({ type: "attempt", attempt }),
          });
          send({ type: "result", result });
        } catch (error) {
          send({ type: "error", error: message(error) });
        } finally {
          closed = true;
          try { controller.close(); } catch { /* The client went away. */ }
        }
      },
      cancel() { /* discoverEmail sees the request signal. */ },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  })
  .post("/test", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = testDraftInput.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Check the server settings." }, 400);
    try {
      const draft = await parseAccountDraft(c.get("user").id, raw);
      const result = await verifyAccount(syntheticSecrets(c.get("user").id, draft));
      return c.json({ ok: true, folders: result.folders });
    } catch (error) {
      return c.json({ error: message(error) }, 422);
    }
  })
  .post("/accounts", async (c) => {
    const account = await createAccount(c.get("user").id, await c.req.json().catch(() => null));
    return c.json(account, 201);
  })
  .patch("/accounts/:id", async (c) => {
    const account = await updateAccount(c.get("user").id, c.req.param("id"), await c.req.json().catch(() => null));
    return c.json(account);
  })
  .delete("/accounts/:id", (c) => {
    deleteAccount(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .post("/accounts/:id/default", (c) => c.json(setDefaultAccount(c.get("user").id, c.req.param("id"))))
  .post("/accounts/:id/test", async (c) => {
    const userId = c.get("user").id;
    // getAccount enforces ownership before any secret is decrypted.
    getAccount(userId, c.req.param("id"));
    try {
      const result = await verifyAccount(accountSecrets(userId, c.req.param("id")));
      recordCheck(userId, c.req.param("id"), "ok", null);
      return c.json({ ok: true, folders: result.folders, account: getAccount(userId, c.req.param("id")) });
    } catch (error) {
      const friendly = message(error);
      const account = recordCheck(userId, c.req.param("id"), "failed", friendly);
      return c.json({ error: friendly, account }, 422);
    }
  });
