import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { decrypt, encrypt } from "./crypto.js";
import { db } from "./db.js";
import { env } from "./env.js";

// Each user signs in to their own ChatGPT account through the Codex CLI. The CLI needs its credentials as
// a plain auth.json in CODEX_HOME, so we keep them encrypted in SQLite and write them to a private temp
// CODEX_HOME only while a command runs. Token refreshes made by the CLI are read back afterwards.
// See docs/implementation/codex-images.md.

export const CODEX_COMMAND = process.env.OKAYCHAT_CODEX_COMMAND ?? "codex";
const TMP_ROOT = path.join(env.dataDir, "codex-tmp");
const SAFE_ENV = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "SSL_CERT_DIR", "SSL_CERT_FILE", "TMPDIR"];

mkdirSync(TMP_ROOT, { recursive: true, mode: 0o700 });

/** Only what the CLI needs. HOME points at the temp dir so nothing reads or writes the server's home. */
export function codexEnv(home: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { CODEX_HOME: home, HOME: home, NO_COLOR: "1" };
  for (const name of SAFE_ENV) if (process.env[name]) out[name] = process.env[name];
  return out;
}

let installed: Promise<string | null> | null = null;

/** The CLI version, or null when it is not installed. Cached for the process lifetime. */
export function codexVersion(): Promise<string | null> {
  installed ??= new Promise((resolve) => {
    const child = spawn(CODEX_COMMAND, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
  });
  return installed;
}

export const isConnected = (userId: string) => !!db.prepare("SELECT 1 FROM codex_auth WHERE user_id = ?").get(userId);

function saveAuth(userId: string, json: string) {
  db.prepare(
    "INSERT INTO codex_auth (user_id, auth_enc, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET auth_enc = excluded.auth_enc, updated_at = excluded.updated_at",
  ).run(userId, encrypt(json), Date.now());
}

export function disconnect(userId: string) {
  db.prepare("DELETE FROM codex_auth WHERE user_id = ?").run(userId);
  pendingLogins.get(userId)?.child.kill();
  pendingLogins.delete(userId);
}

const makeHome = () => mkdtemp(path.join(TMP_ROOT, "home-"));

// Runs are serialized per user: two concurrent runs could each refresh the token, and the refresh token
// rotates, so the second write would store a revoked one.
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(userId: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(userId) ?? Promise.resolve()).then(run, run);
  queues.set(
    userId,
    next.catch(() => {}),
  );
  return next;
}

function readAuth(userId: string): string {
  const row = db.prepare("SELECT auth_enc FROM codex_auth WHERE user_id = ?").get(userId) as { auth_enc: string } | undefined;
  if (!row) throw new Error("ChatGPT is not connected. Connect it in Settings → Providers or Image generation.");
  return decrypt(row.auth_enc);
}

/** Runs `fn` with a temporary CODEX_HOME holding the user's credentials. */
export function withCodexHome<T>(userId: string, fn: (home: string) => Promise<T>): Promise<T> {
  const run = async () => {
    const auth = readAuth(userId);
    const home = await makeHome();
    const authPath = path.join(home, "auth.json");
    await writeFile(authPath, auth, { mode: 0o600 });
    try {
      return await fn(home);
    } finally {
      const after = await readFile(authPath, "utf8").catch(() => null);
      if (after && after !== auth && isConnected(userId)) saveAuth(userId, after);
      await rm(home, { recursive: true, force: true });
    }
  };
  return serialized(userId, run);
}

// Chat models call the ChatGPT backend directly with the same login (docs/implementation/codex-chat.md). The CLI
// refreshes tokens itself during image runs; for chat we refresh here, inside the same per-user queue.
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_MARGIN_MS = 5 * 60_000;

interface AuthFile {
  tokens?: { id_token?: string; access_token?: string; refresh_token?: string; account_id?: string };
  last_refresh?: string;
  [key: string]: unknown;
}

const jwtExpiry = (token: string): number => {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { exp?: number };
    return (claims.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
};

/** A current access token and account id for the ChatGPT backend. `force` refreshes even an unexpired token (after a 401). */
export function codexAccess(userId: string, force = false): Promise<{ token: string; accountId: string }> {
  return serialized(userId, async () => {
    const auth = JSON.parse(readAuth(userId)) as AuthFile;
    const tokens = auth.tokens;
    if (!tokens?.access_token || !tokens.account_id) throw new Error("The ChatGPT login has no access token. Connect it again.");
    if (!force && jwtExpiry(tokens.access_token) - REFRESH_MARGIN_MS > Date.now()) return { token: tokens.access_token, accountId: tokens.account_id };
    if (!tokens.refresh_token) throw new Error("The ChatGPT login expired. Connect it again.");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: tokens.refresh_token, scope: "openid profile email" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(res.status === 400 || res.status === 401 ? "The ChatGPT login expired. Connect it again." : `ChatGPT token refresh failed (HTTP ${res.status}).`);
    const fresh = (await res.json()) as { id_token?: string; access_token?: string; refresh_token?: string };
    if (!fresh.access_token) throw new Error("ChatGPT token refresh returned no access token.");
    auth.tokens = {
      ...tokens,
      access_token: fresh.access_token,
      ...(fresh.id_token ? { id_token: fresh.id_token } : {}),
      ...(fresh.refresh_token ? { refresh_token: fresh.refresh_token } : {}),
    };
    auth.last_refresh = new Date().toISOString();
    if (isConnected(userId)) saveAuth(userId, JSON.stringify(auth, null, 2));
    return { token: fresh.access_token, accountId: tokens.account_id };
  });
}

interface PendingLogin {
  child: ReturnType<typeof spawn>;
  url?: string;
  code?: string;
  error?: string;
  startedAt: number;
}

const pendingLogins = new Map<string, PendingLogin>();
const LOGIN_TTL = 15 * 60_000;

export function loginStatus(userId: string): { url?: string; code?: string; error?: string } | null {
  const p = pendingLogins.get(userId);
  if (!p) return null;
  return { url: p.url, code: p.code, error: p.error };
}

/** Starts `codex login --device-auth` and resolves once the CLI prints the link and one-time code. */
export async function startLogin(userId: string): Promise<{ url: string; code: string }> {
  const existing = pendingLogins.get(userId);
  if (existing?.url && existing.code && !existing.error && Date.now() - existing.startedAt < LOGIN_TTL) {
    return { url: existing.url, code: existing.code };
  }
  existing?.child.kill();
  const home = await makeHome();
  const child = spawn(CODEX_COMMAND, ["login", "--device-auth"], { env: codexEnv(home), cwd: home, stdio: ["ignore", "pipe", "pipe"] });
  const pending: PendingLogin = { child, startedAt: Date.now() };
  pendingLogins.set(userId, pending);
  const timer = setTimeout(() => child.kill(), LOGIN_TTL);

  child.on("close", async (code) => {
    clearTimeout(timer);
    try {
      const auth = code === 0 ? await readFile(path.join(home, "auth.json"), "utf8").catch(() => null) : null;
      if (auth) {
        saveAuth(userId, auth);
        if (pendingLogins.get(userId) === pending) pendingLogins.delete(userId);
      } else if (pendingLogins.get(userId) === pending) {
        pending.error = code === null ? "Login expired. Start again." : "Login did not complete. Start again.";
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  return new Promise((resolve, reject) => {
    let out = "";
    const onData = (chunk: Buffer) => {
      out += chunk.toString().replace(/\x1b\[[0-9;]*m/g, "");
      const url = out.match(/https:\/\/\S+/)?.[0];
      const code = out.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/)?.[0];
      if (url && code && !pending.url) {
        pending.url = url;
        pending.code = code;
        resolve({ url, code });
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("error", (e) => reject(new Error(`Could not start Codex CLI: ${e.message}`)));
    child.on("close", () => reject(new Error(out.trim().split("\n").pop() || "Codex login exited early.")));
  });
}
