import { upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { requireUser, sessionAlive, type AppEnv } from "../auth.js";
import { adminSpeech } from "../speech/config.js";
import { getThread } from "../threads.js";
import { voiceAvailability, workerBackends } from "./backend.js";
import { CallRegistry, CallSession, type CallSocket } from "./session.js";
import { callLimits, StartLimiter } from "./limits.js";
import { MiniWebSocket, MiniWebSocketServer } from "./ws.js";
import { featureAllowed } from "../permissions/guard.js";
import { holdLease, reserveOperation } from "../permissions/limits.js";

// `/api/voice` availability and `/api/voice/call`, the one WebSocket a voice call uses. See
// docs/implementation/voice-calls.md. The socket is authenticated by the session cookie before the upgrade,
// checks its Origin strictly, and is bound to the chat named in `start`.

const limits = callLimits();

/** The `noServer` codec @hono/node-server's `websocket` option upgrades through. */
export const voiceWebSocketServer = new MiniWebSocketServer({ maxPayload: limits.maxMessageBytes });

const registry = new CallRegistry();
const starts = new StartLimiter(limits.maxStarts, limits.startWindowSeconds * 1000);

const publicOrigin = () => {
  try {
    return process.env.OKAYCHAT_PUBLIC_URL ? new URL(process.env.OKAYCHAT_PUBLIC_URL).origin : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A browser always sends a canonical serialized Origin. Accept only `http(s)://host[:port]` with no
 * credentials, path, query, or fragment; a malformed or crafted value (for example `ftp://…` or
 * `https://user@host`) is a foreign origin, not an alternate spelling of this one. Exported for tests.
 */
export function canonicalOrigin(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    // `URL.origin` drops a default port and lowercases the host; a non-canonical spelling never came from a browser.
    return url.origin === value ? url : null;
  } catch {
    return null;
  }
}

/**
 * Same-origin browsing (including through a reverse proxy that sets the request URL) is allowed, as is the
 * configured public origin. The only scheme mismatch allowed is the dev TLS proxy: an `https` page whose
 * upgrade request is `http` on exactly the same host. A cross-site page, a missing Origin, a malformed
 * Origin, or `Sec-Fetch-Site: cross-site` is refused. Exported for tests.
 */
export function voiceOriginAllowed(
  origin: string | undefined,
  requestOrigin: string,
  allowedPublicOrigin = publicOrigin(),
  secFetchSite?: string,
): boolean {
  if (!origin) return false;
  if (secFetchSite === "cross-site") return false;
  const given = canonicalOrigin(origin);
  const request = canonicalOrigin(requestOrigin);
  if (!given || !request) return false;
  if (origin === requestOrigin) return true;
  if (allowedPublicOrigin && origin === allowedPublicOrigin) return true;
  // Behind a TLS-terminating dev proxy the page is https while the upgrade request is http. The host still
  // has to match exactly and the downgrade is one-way, so a foreign page cannot pass by changing only the
  // scheme.
  return given.protocol === "https:" && request.protocol === "http:" && given.host === request.host;
}

/** The call registry and start limiter are per process; tests build their own `CallSession`s. */
export const voiceCallRegistry = registry;
export const voiceStartLimiter = starts;

export const voiceRoutes = new Hono<AppEnv>()
  // Also mounted under the authenticated API; kept here so the route can be mounted alone in a test.
  .use("*", requireUser)
  .get("/", async (c) => c.json(await voiceAvailability(c.get("user").id)))
  // Before the upgrade, so a foreign page gets an HTTP error instead of an open call. The upgrade request is
  // built from the raw socket, which sees http behind a TLS-terminating proxy; the forwarded headers are the
  // same ones the rest of the app trusts.
  .use("/call", async (c, next) => {
    const url = new URL(c.req.url);
    const proto = (c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() ?? url.protocol.replace(":", "")).toLowerCase();
    const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() ?? c.req.header("host") ?? url.host;
    if (!voiceOriginAllowed(c.req.header("origin"), `${proto}://${host}`, publicOrigin(), c.req.header("sec-fetch-site"))) {
      return c.text("Forbidden", 403);
    }
    // No upgrade, no signalling, and no worker warm when voice is not allowed for this account.
    if (!featureAllowed(c.get("user").id, "voice")) return c.text("Voice is disabled for this account.", 403);
    await next();
  })
  .get(
    "/call",
    upgradeWebSocket((c) => {
      const user = c.get("user");
      const sessionHash = c.get("session");
      let session: CallSession | null = null;
      return {
        onOpen(_event, ws) {
          const raw = ws.raw as MiniWebSocket | undefined;
          const socket: CallSocket = {
            // Hono's WSContext narrows binary sends to Uint8Array<ArrayBuffer>; ours are freshly allocated frames.
            send: (data) => ws.send(typeof data === "string" ? data : (data as Uint8Array<ArrayBuffer>)),
            close: (code, reason) => ws.close(code, reason),
            get bufferedAmount() {
              return raw?.bufferedAmount ?? 0;
            },
          };
          session = new CallSession(user.id, socket, {
            backends: workerBackends,
            limits,
            registry,
            starts,
            threadOwned: (userId, threadId) => threadId.startsWith("tmp_") || !!getThread(userId, threadId),
            stillSignedIn: () => sessionAlive(sessionHash),
            featureAllowed: (userId) => featureAllowed(userId, "voice"),
            // One operation lease for the session; released when the call ends or the socket closes.
            admit: () => holdLease(reserveOperation({ userId: user.id }, "voice.session")),
            maxRecordingSeconds: () => adminSpeech().maxRecordingSeconds,
            onUsage: (usage) => {
              // Counters only: never audio, text, or a secret. Chat model usage is recorded by /api/chat.
              console.log(`voice call ended (${usage.engine}): ${usage.sttSeconds}s speech to text, ${usage.ttsChars} characters to speech`);
            },
          });
        },
        onMessage(event, ws) {
          const data = event.data;
          if (typeof data === "string" || data instanceof ArrayBuffer) session?.onMessage(data);
          else if (data instanceof Uint8Array) session?.onMessage(data);
          else ws.close(1003, "unsupported");
        },
        onClose() {
          session?.onClose();
        },
        onError() {
          session?.onClose();
        },
      };
    }),
  );

/** The public URL origin is read per request so a test can change OKAYCHAT_PUBLIC_URL. */
export const voicePublicOrigin = publicOrigin;
