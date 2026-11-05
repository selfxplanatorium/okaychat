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

// Bumped whenever the stored login is replaced or removed. A run that started under an older login
// must not write its refreshed tokens over the newer one.
const loginGeneration = new Map<string, number>();
const generationOf = (userId: string) => loginGeneration.get(userId) ?? 0;
const loginListeners = new Set<(userId: string) => void>();

/** Called after a login is replaced or removed, for caches derived from the old account. */
export function onLoginChange(listener: (userId: string) => void) {
  loginListeners.add(listener);
}

function loginChanged(userId: string) {
  loginGeneration.set(userId, generationOf(userId) + 1);
  for (const listener of loginListeners) listener(userId);
}

/** Saves refreshed tokens only while the login they came from is still the stored one. */
function saveRefreshed(userId: string, generation: number, json: string) {
  if (generation === generationOf(userId) && isConnected(userId)) saveAuth(userId, json);
}

export function disconnect(userId: string) {
  db.prepare("DELETE FROM codex_auth WHERE user_id = ?").run(userId);
  pendingLogins.get(userId)?.child.kill();
  pendingLogins.delete(userId);
  loginChanged(userId);
}

const makeHome = () => mkdtemp(path.join(TMP_ROOT, "home-"));

// Runs are serialized per user: two concurrent runs could each refresh the token, and the refresh token
// rotates, so the second write would store a revoked one.
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(userId: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(userId) ?? Promise.resolve()).then(run, run);
  // The tail holds no result (an image buffer or a token) and leaves the map once nothing follows it.
  const tail: Promise<unknown> = next.then(
    () => undefined,
    () => undefined,
  );
  queues.set(userId, tail);
  void tail.then(() => {
    if (queues.get(userId) === tail) queues.delete(userId);
  });
  return next;
}

function readAuth(userId: string): string {
  const row = db.prepare("SELECT auth_enc FROM codex_auth WHERE user_id = ?").get(userId) as { auth_enc: string } | undefined;
  if (!row) throw new Error("ChatGPT is not connected. Connect it in Settings → Image generation.");
  return decrypt(row.auth_enc);
}

/** Runs `fn` with a temporary CODEX_HOME holding the user's credentials. */
export function withCodexHome<T>(userId: string, fn: (home: string) => Promise<T>): Promise<T> {
  const run = async () => {
    const generation = generationOf(userId);
    const auth = readAuth(userId);
    const home = await makeHome();
    const authPath = path.join(home, "auth.json");
    await writeFile(authPath, auth, { mode: 0o600 });
    try {
      return await fn(home);
    } finally {
      const after = await readFile(authPath, "utf8").catch(() => null);
      if (after && after !== auth) saveRefreshed(userId, generation, after);
      await rm(home, { recursive: true, force: true });
    }
  };
  return serialized(userId, run);
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

  child.on("close", (code) => {
    clearTimeout(timer);
    void (async () => {
      try {
        const auth = code === 0 ? await readFile(path.join(home, "auth.json"), "utf8").catch(() => null) : null;
        // A disconnect, a newer login, or a deleted account during the read invalidates this attempt.
        if (pendingLogins.get(userId) !== pending) return;
        if (auth) {
          pendingLogins.delete(userId);
          saveAuth(userId, auth);
          loginChanged(userId);
        } else {
          pending.error = code === null ? "Login expired. Start again." : "Login did not complete. Start again.";
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    })().catch((error: unknown) => console.error("codex login:", (error as Error).message));
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
