#!/usr/bin/env node
/**
 * okaychat ChatGPT desktop helper.
 *
 * Sign in with ChatGPT uses a loopback redirect, and the loopback address belongs to the computer whose
 * browser opens the authorization page. This helper runs on that computer, listens on 127.0.0.1, and sends
 * the one-time callback URL to the user's okaychat deployment over HTTPS. The deployment keeps the PKCE
 * verifier, state, nonce and tokens; the helper never sees them and never talks to an OAuth endpoint.
 *
 * Usage: node chatgpt-connect.mjs <path-to-launch-file>
 *
 * Security rules this file must keep (see docs/implementation/codex-chat.md):
 * - Only the origin pinned in the launch file is contacted. No discovery, authorization or token host is
 *   configurable here.
 * - The launch file is read once, size-bounded, schema-checked and deleted before any network request.
 * - The listener binds 127.0.0.1 only, starts before the prepare request, and accepts only GET
 *   /auth/callback with the exact Host header and one state value.
 * - The helper capability and helper secret never appear in output, a URL, an argument, or a log line.
 * - No shell is used to open the browser, and the authorization URL is never printed.
 */

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

export const HELPER_VERSION = "1.0.0";
export const LAUNCH_VERSION = 1;
export const CALLBACK_PATH = "/auth/callback";
export const AUTHORIZE_ORIGIN = "https://auth.openai.com";
export const AUTHORIZE_PATH = "/api/accounts/authorize";
export const RESOURCE = "https://api.openai.com/v1";
export const HELPER_PATH = "/api/chatgpt/helper";

const LAUNCH_LIMIT = 16 * 1024;
const CALLBACK_URI_LIMIT = 8 * 1024;
const AUTH_URL_LIMIT = 8 * 1024;
const RESPONSE_LIMIT = 64 * 1024;
const PREPARE_TIMEOUT_MS = 20_000;
const COMPLETE_TIMEOUT_MS = 25_000;
const CANCEL_TIMEOUT_MS = 5_000;
const MAX_ATTEMPT_MS = 60 * 60_000;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{4,100}$/;
const STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const CODE_PATTERN = /^[\x21-\x7e]{1,4096}$/;
const SENSITIVE = new Set(["code", "state", "client_id", "error", "error_description", "scope", "iss"]);

/** A failure whose message is safe to print: it is authored here, never an upstream body or URL. */
export class HelperError extends Error {
  constructor(message, kind = "failed") {
    super(message);
    this.name = "HelperError";
    this.kind = kind;
  }
}

const invalid = (message) => new HelperError(message, "invalid");
const expired = () => new HelperError("This sign-in request has expired. Start again from okaychat settings.", "expired");

export function nodeMajor(version) {
  const major = Number.parseInt(String(version).split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 0;
}

export function randomSecret() {
  return randomBytes(32).toString("base64url");
}

const plainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** HTTPS origin only: no credentials, query, fragment, or subpath. An explicit port is preserved. */
export function canonicalLaunchOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) throw invalid("The launch file has an invalid deployment address.");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalid("The launch file has an invalid deployment address.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw invalid("The launch file has an invalid deployment address.");
  }
  return url.origin;
}

const LAUNCH_KEYS = new Set(["version", "publicOrigin", "attemptId", "helperCapability", "expiresAt"]);

/** Strict launch-file schema. The file is credential-like: keep every field accounted for. */
export function parseLaunch(text, now = Date.now()) {
  if (typeof text !== "string") throw invalid("The launch file could not be read.");
  if (Buffer.byteLength(text, "utf8") > LAUNCH_LIMIT) throw invalid("The launch file is too large. Start again from okaychat settings.");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalid("The launch file is not valid. Start again from okaychat settings.");
  }
  if (!plainObject(data)) throw invalid("The launch file is not valid. Start again from okaychat settings.");
  const keys = Object.keys(data);
  if (keys.length !== LAUNCH_KEYS.size || keys.some((key) => !LAUNCH_KEYS.has(key))) {
    throw invalid("The launch file is not valid. Start again from okaychat settings.");
  }
  if (data.version !== LAUNCH_VERSION) throw invalid("This helper is not the right version for this launch file.");
  const publicOrigin = canonicalLaunchOrigin(data.publicOrigin);
  if (typeof data.attemptId !== "string" || !ATTEMPT_PATTERN.test(data.attemptId)) throw invalid("The launch file is not valid. Start again from okaychat settings.");
  if (typeof data.helperCapability !== "string" || !SECRET_PATTERN.test(data.helperCapability)) {
    throw invalid("The launch file is not valid. Start again from okaychat settings.");
  }
  const expiresAt = data.expiresAt;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw expired();
  if (expiresAt - now > MAX_ATTEMPT_MS) throw invalid("The launch file is not valid. Start again from okaychat settings.");
  return { version: LAUNCH_VERSION, publicOrigin, attemptId: data.attemptId, helperCapability: data.helperCapability, expiresAt };
}

/**
 * Reads a regular file once, then deletes it before returning. The helper must not leave the capability on
 * disk after it has been read.
 */
export function readLaunchFile(path, options = {}) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw invalid("The launch file could not be found.");
  }
  if (!stat.isFile()) throw invalid("The launch file could not be read.");
  if (stat.size > LAUNCH_LIMIT) throw invalid("The launch file is too large. Start again from okaychat settings.");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw invalid("The launch file could not be read.");
  }
  try {
    unlinkSync(path);
  } catch {
    // Deleting is best effort on platforms that hold the file open; the capability is consumed once anyway.
  }
  options.onRead?.(stat);
  return text;
}

function single(params, name) {
  const all = params.getAll(name);
  if (all.length !== 1) throw invalid("The sign-in page returned an unexpected address.");
  return all[0];
}

/**
 * Validates the authorization URL the deployment prepared: fixed endpoint, loopback callback for this
 * listener, PKCE S256, one state, and the deployment's own expiry. Unknown extra parameters are ignored;
 * duplicates of the values read here are not.
 */
export function validatePrepare(body, expected) {
  if (!plainObject(body)) throw invalid("The deployment returned an unexpected answer.");
  const { authorizationUrl, expiresAt } = body;
  if (typeof authorizationUrl !== "string" || authorizationUrl.length > AUTH_URL_LIMIT) throw invalid("The deployment returned an unexpected answer.");
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= expected.now) throw expired();
  if (expiresAt - expected.now > MAX_ATTEMPT_MS) throw invalid("The deployment returned an unexpected answer.");
  let url;
  try {
    url = new URL(authorizationUrl);
  } catch {
    throw invalid("The deployment returned an unexpected sign-in address.");
  }
  if (url.protocol !== "https:" || url.origin !== AUTHORIZE_ORIGIN || url.pathname !== AUTHORIZE_PATH || url.hash) {
    throw invalid("The deployment returned an unexpected sign-in address.");
  }
  const redirect = single(url.searchParams, "redirect_uri");
  const expectedRedirect = `http://127.0.0.1:${expected.port}${CALLBACK_PATH}`;
  if (redirect !== expectedRedirect) throw invalid("The deployment returned an unexpected sign-in address.");
  const state = single(url.searchParams, "state");
  if (!STATE_PATTERN.test(state)) throw invalid("The deployment returned an unexpected sign-in address.");
  if (single(url.searchParams, "response_type") !== "code") throw invalid("The deployment returned an unexpected sign-in address.");
  if (single(url.searchParams, "code_challenge_method") !== "S256") throw invalid("The deployment returned an unexpected sign-in address.");
  const challenge = single(url.searchParams, "code_challenge");
  if (!SECRET_PATTERN.test(challenge)) throw invalid("The deployment returned an unexpected sign-in address.");
  if (single(url.searchParams, "resource") !== RESOURCE) throw invalid("The deployment returned an unexpected sign-in address.");
  const scopes = single(url.searchParams, "scope").split(/\s+/).filter(Boolean);
  if (!scopes.includes("chatgpt.tokens.use.direct") || !scopes.includes("resource.invoke")) throw invalid("The deployment returned an unexpected sign-in address.");
  const clientId = single(url.searchParams, "client_id");
  if (!clientId || clientId.length > 512 || /[\s\x00-\x1f]/.test(clientId)) throw invalid("The deployment returned an unexpected sign-in address.");
  return { url, state, redirectUri: expectedRedirect, expiresAt };
}

export function hostMatches(host, port) {
  return host === `127.0.0.1:${port}`;
}

/**
 * Parses the loopback request line. Only GET `/auth/callback?…` with one value per sensitive parameter can
 * consume the attempt. A wrong state is reported without consuming it, so a stray request cannot kill a
 * legitimate sign-in.
 */
export function inspectCallback(rawUrl, expected) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > CALLBACK_URI_LIMIT || rawUrl.includes("#")) return { kind: "invalid" };
  if (rawUrl === CALLBACK_PATH) return { kind: "empty" };
  if (!rawUrl.startsWith(`${CALLBACK_PATH}?`)) return { kind: "not_callback" };
  const query = rawUrl.slice(CALLBACK_PATH.length + 1);
  const values = new Map();
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    let key;
    let value;
    try {
      key = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, " "));
      value = decodeURIComponent((eq === -1 ? "" : pair.slice(eq + 1)).replace(/\+/g, " "));
    } catch {
      return { kind: "invalid" };
    }
    if (SENSITIVE.has(key) && values.has(key)) return { kind: "invalid" };
    values.set(key, value);
  }
  if (values.get("state") !== expected.state) return { kind: "state_mismatch" };
  const code = values.get("code");
  const error = values.get("error");
  if (code !== undefined && error !== undefined) return { kind: "invalid" };
  if (error !== undefined) return { kind: "callback", callbackUrl: `http://127.0.0.1:${expected.port}${rawUrl}` };
  if (typeof code !== "string" || !CODE_PATTERN.test(code)) return { kind: "invalid" };
  return { kind: "callback", callbackUrl: `http://127.0.0.1:${expected.port}${rawUrl}` };
}

/** Binds an ephemeral port on loopback only. An occupied port is simply a different ephemeral port. */
export function listenLoopback(server = createServer()) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new HelperError("The local sign-in listener could not start."));
        return;
      }
      resolve({ server, port: address.port, address: address.address });
    });
  });
}

/** The browser command as an argument vector, never a shell string. */
export function browserCommand(url, platform = process.platform) {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { command: "xdg-open", args: [url] };
}

export function openBrowser(url, options = {}) {
  const { command, args } = browserCommand(url, options.platform ?? process.platform);
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    let settled = false;
    const done = (opened) => {
      if (settled) return;
      settled = true;
      resolve(opened);
    };
    let child;
    try {
      child = spawnImpl(command, args, { shell: false, stdio: "ignore", detached: true });
    } catch {
      done(false);
      return;
    }
    child.once("error", () => done(false));
    child.once("spawn", () => {
      child.unref?.();
      done(true);
    });
    // A missing opener usually reports `error`; do not hang the helper if a launcher stays silent.
    setTimeout(() => done(false), 1_500).unref?.();
  });
}

export function isConfirmed(answer) {
  return /^(?:y|yes)$/i.test(String(answer).trim());
}

async function confirm(origin) {
  if (!process.stdin.isTTY) throw invalid("Run this helper in a terminal so you can confirm the deployment address.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Connect your ChatGPT account to ${origin}? Only continue if you started this from that deployment. Type yes to continue: `);
    return isConfirmed(answer);
  } finally {
    rl.close();
  }
}

async function readBounded(res, limit) {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw invalid("The deployment returned an unexpected answer.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One HTTPS POST to the pinned origin. No cookies, no redirects, no proxy credentials from the environment. */
async function postHelper({ origin, action, capability, body, timeoutMs }) {
  const res = await fetch(`${origin}${HELPER_PATH}/${action}`, {
    method: "POST",
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    headers: { Authorization: `Bearer ${capability}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await readBounded(res, RESPONSE_LIMIT);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, body: json };
}

function helperFailure(status, action) {
  if (status === 404) return invalid("This sign-in request is not valid. Start again from okaychat settings.");
  if (status === 410) return expired();
  if (status === 409 && action === "prepare") {
    return invalid("This sign-in is not ready. In okaychat, download the launch file first, then run the helper again.");
  }
  if (status === 409) return invalid("This sign-in request was already used. Start again from okaychat settings.");
  if (status === 429) return new HelperError("Too many sign-in attempts. Wait a few minutes, then start again from okaychat settings.", "rate_limited");
  if (status === 503) return new HelperError("ChatGPT sign-in is not available on this deployment.", "unavailable");
  return new HelperError(action === "complete" ? "The sign-in could not be completed. Start again from okaychat settings." : "The deployment could not start the sign-in. Start again from okaychat settings.");
}

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  // The listener closes right after the page; a kept-alive socket would hold the helper open.
  Connection: "close",
};

const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

const PAGES = {
  success: { status: 200, html: page("ChatGPT connected", "You can close this tab and return to okaychat.") },
  plan_disabled: { status: 200, html: page("Signed in", "ChatGPT plan use is not enabled for this account. Return to okaychat and choose Enable plan usage.") },
  failed: { status: 200, html: page("Sign-in was not completed", "Return to okaychat and start again.") },
  invalid: { status: 400, html: page("This link is not valid", "Return to okaychat and start a new sign-in.") },
  empty: { status: 200, html: page("Waiting for sign-in", "This is the okaychat sign-in listener. Finish signing in in the browser tab that opened.") },
  busy: { status: 409, html: page("Already handled", "This sign-in was already completed.") },
  not_found: { status: 404, html: page("Not found", "There is nothing here.") },
  host: { status: 400, html: page("This link is not valid", "Return to okaychat and start a new sign-in.") },
  method: { status: 405, html: page("Not allowed", "There is nothing here.") },
};

function respond(res, key, headers = {}) {
  if (!res || res.writableEnded) return;
  const entry = PAGES[key] ?? PAGES.not_found;
  res.writeHead(entry.status, { ...PAGE_HEADERS, ...headers });
  res.end(entry.html);
}

function waitForCallback(server, expected) {
  return new Promise((resolve) => {
    let consumed = false;
    server.on("request", (req, res) => {
      if (!hostMatches(req.headers.host, expected.port)) {
        respond(res, "host");
        return;
      }
      if (req.method !== "GET") {
        respond(res, "method", { Allow: "GET" });
        return;
      }
      const inspection = inspectCallback(req.url, expected);
      if (inspection.kind === "callback") {
        if (consumed) {
          respond(res, "busy");
          return;
        }
        consumed = true;
        resolve({
          callbackUrl: inspection.callbackUrl,
          respond: (outcome) => respond(res, outcome),
        });
        return;
      }
      if (inspection.kind === "state_mismatch") {
        respond(res, "invalid");
        return;
      }
      if (inspection.kind === "empty") {
        respond(res, "empty");
        return;
      }
      respond(res, inspection.kind === "not_callback" ? "not_found" : "invalid");
    });
  });
}

function withDeadline(promise, ms, timeoutError) {
  return new Promise((resolve, reject) => {
    if (!(ms > 0)) {
      reject(timeoutError());
      return;
    }
    const timer = setTimeout(() => reject(timeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function say(line) {
  process.stdout.write(`${line}\n`);
}

export async function main(argv = process.argv) {
  if (argv[2] === "--version") {
    say(`chatgpt-connect ${HELPER_VERSION}`);
    return 0;
  }
  if (nodeMajor(process.versions.node) < 22) throw new HelperError("This helper needs Node 22 or newer.");
  const file = argv[2];
  if (!file || file.startsWith("-") || argv[3]) {
    throw new HelperError("Usage: node chatgpt-connect.mjs <path-to-launch-file>");
  }

  let insecureFileWarning = false;
  const text = readLaunchFile(file, {
    onRead: (stat) => {
      insecureFileWarning = (stat.mode & 0o077) !== 0;
    },
  });
  const launch = parseLaunch(text);
  if (insecureFileWarning) say("Note: the launch file could have been read by other users on this computer. It has been deleted; start a new sign-in if you are unsure who could read it.");

  say(`This connects your ChatGPT account to ${launch.publicOrigin}.`);
  say("Only continue if you started this from that deployment. Anyone with the launch file can finish this sign-in.");
  if (!(await confirm(launch.publicOrigin))) {
    say("Cancelled.");
    return 1;
  }

  const { server, port } = await listenLoopback();
  const helperSecret = randomSecret();
  let prepared = false;
  let finished = false;
  let pending = null;

  const cancelAttempt = async () => {
    if (!prepared || finished) return;
    try {
      await postHelper({
        origin: launch.publicOrigin,
        action: "cancel",
        capability: launch.helperCapability,
        body: { attemptId: launch.attemptId, helperSecret },
        timeoutMs: CANCEL_TIMEOUT_MS,
      });
    } catch {
      // Cancelling is best effort: the attempt expires on its own.
    }
  };
  const onSigint = () => {
    void cancelAttempt().finally(() => {
      server.closeAllConnections?.();
      server.close();
      say("\nCancelled.");
      process.exit(130);
    });
  };
  process.once("SIGINT", onSigint);

  try {
    const preparedResponse = await postHelper({
      origin: launch.publicOrigin,
      action: "prepare",
      capability: launch.helperCapability,
      body: { attemptId: launch.attemptId, port, helperSecret },
      timeoutMs: PREPARE_TIMEOUT_MS,
    });
    if (preparedResponse.status !== 200) throw helperFailure(preparedResponse.status, "prepare");
    prepared = true;
    const now = Date.now();
    const auth = validatePrepare(preparedResponse.body, { port, now });
    const expiresAt = Math.min(launch.expiresAt, auth.expiresAt);

    const waiting = waitForCallback(server, { port, state: auth.state });
    const opened = await openBrowser(auth.url.toString());
    if (!opened) throw new HelperError("Your browser could not be opened. Start again from okaychat settings.");
    say("Finish signing in in the browser window that opened.");

    pending = await withDeadline(waiting, expiresAt - Date.now(), () => new HelperError("This sign-in request expired before it finished. Start again from okaychat settings.", "expired"));
    let outcome = "failed";
    try {
      const completed = await postHelper({
        origin: launch.publicOrigin,
        action: "complete",
        capability: launch.helperCapability,
        body: { attemptId: launch.attemptId, helperSecret, callbackUrl: pending.callbackUrl },
        timeoutMs: COMPLETE_TIMEOUT_MS,
      });
      if (completed.status === 200 && (completed.body?.status === "succeeded" || completed.body?.status === "plan_disabled")) outcome = completed.body.status;
    } catch {
      // The completion request is never retried: a retry could redeem the authorization code twice.
    }
    finished = true;
    pending.respond(outcome);
    pending = null;
    if (outcome === "succeeded") {
      say("ChatGPT plan connected. Return to the okaychat tab.");
      return 0;
    }
    if (outcome === "plan_disabled") {
      say("Signed in. ChatGPT plan use is not enabled for this account. Return to okaychat and choose Enable plan usage.");
      return 0;
    }
    say("The sign-in could not be completed. Start again from okaychat settings.");
    return 1;
  } catch (error) {
    if (pending) {
      pending.respond("failed");
      pending = null;
    }
    await cancelAttempt();
    throw error;
  } finally {
    process.removeListener("SIGINT", onSigint);
    server.close();
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const message = error instanceof HelperError ? error.message : "The sign-in failed. Start again from okaychat settings.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
