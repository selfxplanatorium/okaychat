import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { ServiceStatus, ServicesResponse } from "../shared/services.js";

// The registry never touches a real sidecar here: every probe is replaced with a fake. Timeouts, TTL, and
// single-flight are checked with short timings instead of seconds.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-services-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "services-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { requireUser } = await import("./auth.js");
const { sha256 } = await import("./crypto.js");
const { saveConnection } = await import("./catalog/providers.js");
const { encrypt } = await import("./crypto.js");
const services = await import("./services.js");

for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 60_000);
}
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const app = new Hono().use(requireUser).route("/", services.serviceRoutes);
const get = (user?: string) => app.request("http://app/services", { headers: user ? { cookie: `okaychat_session=${user}` } : {} });

const up = (state: "up" | "down" | "degraded" = "up") => async () => ({
  results: {
    browser: { state, reasonKey: state === "up" ? "ok" : "refuses" } as const,
    scrapling: { state, reasonKey: state === "up" ? "ok" : "refuses" } as const,
  },
});

/** Every source answers fast, so a test only changes the one it cares about. */
function fastProbes() {
  services.setServiceProbeForTests("browser", up());
  services.setServiceProbeForTests("speech", async () => ({ results: { speech: { state: "up", reasonKey: "ok" } } }));
  services.setServiceProbeForTests("sandbox", async () => ({ results: { sandbox: { state: "up", reasonKey: "ok" } } }));
  services.setServiceProbeForTests("searxng", async () => ({ results: { searxng: { state: "up", reasonKey: "ok" } } }));
}

beforeEach(() => {
  services.resetServicesForTests();
  fastProbes();
  db.exec("DELETE FROM email_accounts; DELETE FROM provider_connections; DELETE FROM codex_auth; DELETE FROM shared_connections; DELETE FROM provider_model_policies; DELETE FROM provider_model_grants;");
});

const byId = (list: ServiceStatus[]) => new Map(list.map((status) => [status.id, status]));

test("the registry reports up, down, and degraded without throwing", async () => {
  services.setServiceProbeForTests("browser", async () => ({
    results: {
      browser: { state: "down", reasonKey: "noChromium", fixKey: "startBrowser" },
      scrapling: { state: "unconfigured", reasonKey: "noScrapling" },
    },
  }));
  services.setServiceProbeForTests("speech", async () => ({ results: { speech: { state: "degraded", reasonKey: "cpuFallback" } } }));
  services.setServiceProbeForTests("sandbox", async () => {
    throw new Error("connection refused");
  });
  const statuses = byId(await services.servicesFor("alice"));
  assert.equal(statuses.get("browser")?.state, "down");
  assert.equal(statuses.get("browser")?.reasonKey, "noChromium");
  assert.equal(statuses.get("browser")?.fixKey, "startBrowser");
  assert.equal(statuses.get("scrapling")?.state, "unconfigured");
  assert.equal(statuses.get("speech")?.state, "degraded", "a CPU fallback stays usable");
  assert.equal(statuses.get("sandbox")?.state, "down");
  assert.equal(statuses.get("sandbox")?.reasonKey, "unreachable");
  for (const status of statuses.values()) {
    assert.ok(status.checkedAt > 0);
    assert.equal(typeof status.reasonKey, "string");
  }
});

test("an unconfigured sidecar is reported as such, and never probed", async () => {
  let calls = 0;
  services.setServiceProbeForTests("sandbox", async () => {
    calls++;
    return "unconfigured";
  });
  const statuses = byId(await services.servicesFor("alice"));
  assert.equal(statuses.get("sandbox")?.state, "unconfigured");
  assert.equal(statuses.get("sandbox")?.reasonKey, "notConfigured");
  assert.equal(calls, 1);
});

test("a probe that never settles becomes a timeout, not a hang", async () => {
  services.setServiceTimingForTests({ probeTimeoutMs: 40 });
  services.setServiceProbeForTests("searxng", () => new Promise(() => {}));
  const started = Date.now();
  const statuses = byId(await services.servicesFor("alice"));
  assert.equal(statuses.get("searxng")?.state, "down");
  assert.equal(statuses.get("searxng")?.reasonKey, "timeout");
  assert.ok(Date.now() - started < 1_000);
});

test("results live for the TTL, then one probe is shared by every concurrent caller", async () => {
  services.setServiceTimingForTests({ ttlMs: 60 });
  let calls = 0;
  let release: (() => void) | undefined;
  services.setServiceProbeForTests("sandbox", async () => {
    calls++;
    await new Promise<void>((resolve) => (release = resolve));
    return { results: { sandbox: { state: "up", reasonKey: "ok" } } };
  });
  const first = services.servicesFor("alice");
  const second = services.servicesFor("bob");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1, "both callers share one probe in flight");
  release?.();
  await Promise.all([first, second]);
  await services.servicesFor("alice");
  assert.equal(calls, 1, "a fresh result is reused inside the TTL");
  await new Promise((resolve) => setTimeout(resolve, 80));
  const third = services.servicesFor("alice");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 2, "the next turn after the TTL probes again");
  release?.();
  await third;
});

test("a failed request marks a service down, a success clears it, and a probe recovers it", async () => {
  await services.servicesFor("alice");
  assert.equal(services.serviceDown("sandbox"), false);
  services.reportServiceFailure("sandbox");
  assert.equal(services.serviceDown("sandbox"), true);
  assert.equal(services.serviceSnapshot("sandbox")?.reasonKey, "unreachable");
  services.reportServiceSuccess("sandbox");
  assert.equal(services.serviceDown("sandbox"), false, "a successful call proves the cached failure wrong");
  services.reportServiceFailure("sandbox");
  services.setServiceProbeForTests("sandbox", async () => ({ results: { sandbox: { state: "up", reasonKey: "ok" } } }));
  await services.servicesFor("alice", true);
  assert.equal(services.serviceDown("sandbox"), false, "a forced probe recovers without a reload");
});

test("chat turn state uses fresh results only and never blocks on an unknown service", async () => {
  services.setServiceTimingForTests({ ttlMs: 20 });
  services.setServiceProbeForTests("sandbox", async () => ({ results: { sandbox: { state: "down", reasonKey: "refuses", fixKey: "startSandbox" } } }));
  const first = await services.turnServiceStates(["sandbox"]);
  assert.equal(first.get("sandbox")?.state, "down");
  await new Promise((resolve) => setTimeout(resolve, 40));
  const stale = await services.turnServiceStates(["sandbox"], 10);
  assert.equal(stale.get("sandbox")?.state, "down", "the expired result is refreshed by the shared probe");
  services.resetServicesForTests();
  fastProbes();
  services.setServiceTimingForTests({ probeTimeoutMs: 5_000 });
  services.setServiceProbeForTests("sandbox", () => new Promise(() => {}));
  const unknown = await services.turnServiceStates(["sandbox"], 5);
  assert.equal(unknown.get("sandbox"), undefined, "an unanswered probe leaves the service available");
});

test("/api/services requires a session and returns only the safe shape", async () => {
  assert.equal((await get()).status, 401);
  services.setServiceProbeForTests("searxng", async () => ({
    results: { searxng: { state: "down", reasonKey: "refuses", fixKey: "startSearxng" } },
    // Private detail (a URL, a worker message) must never reach the wire.
    detail: { url: "http://internal-searxng:8080/healthz", token: "secret-token-value" },
  }));
  const res = await get("alice");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  const text = await res.text();
  assert.ok(!text.includes("internal-searxng"));
  assert.ok(!text.includes("secret-token-value"));
  const body = JSON.parse(text) as ServicesResponse;
  assert.ok(Array.isArray(body.services));
  const allowed = new Set(["id", "state", "reasonKey", "fixKey", "checkedAt", "latencyMs"]);
  for (const status of body.services) {
    for (const key of Object.keys(status)) assert.ok(allowed.has(key), `unexpected field ${key}`);
  }
});

test("account entries are per user and never contact a vendor", async () => {
  saveConnection("alice", "openai", { apiKey: "sk-test-not-real" });
  db.prepare("INSERT INTO codex_auth (user_id, auth_enc, updated_at) VALUES ('alice', 'x', 1)").run();
  const now = Date.now();
  const encrypted = encrypt(JSON.stringify({ imap: {}, smtp: {} }));
  const insert = db.prepare(
    "INSERT INTO email_accounts (id, user_id, label, address, imap_enc, smtp_enc, password_enc, last_check_at, last_check_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const account = (id: string, user: string, label: string, address: string, status: "ok" | "failed") =>
    insert.run(id, user, label, address, encrypted, encrypted, encrypted, now, status, now, now);
  account("eml_a", "alice", "Work", "work@example.test", "failed");
  account("eml_b", "alice", "Home", "home@example.test", "ok");
  account("eml_c", "bob", "Bob", "bob@example.test", "ok");

  const alice = byId(await services.servicesFor("alice"));
  assert.equal(alice.get("providers")?.state, "up");
  assert.equal(alice.get("codex")?.state, "up");
  assert.equal(alice.get("email:eml_a")?.state, "down");
  assert.equal(alice.get("email:eml_a")?.reasonKey, "emailTestFailed");
  assert.equal(alice.get("email:eml_b")?.state, "up");

  const bob = byId(await services.servicesFor("bob"));
  assert.equal(bob.get("providers")?.state, "unconfigured", "another account's key is never counted");
  assert.equal(bob.get("codex")?.state, "unconfigured");
  assert.equal(bob.get("email:eml_a"), undefined);
  assert.equal(bob.get("email:eml_c")?.state, "up");
});

test("a rejected provider request degrades that account's providers until a success", async () => {
  saveConnection("alice", "openai", { apiKey: "sk-test-not-real" });
  services.noteProviderOutcome("alice", "rejected");
  assert.equal(byId(await services.servicesFor("alice")).get("providers")?.state, "degraded");
  assert.equal(byId(await services.servicesFor("bob")).get("providers")?.state, "unconfigured");
  services.noteProviderOutcome("alice", "ok");
  assert.equal(byId(await services.servicesFor("alice")).get("providers")?.state, "up");
});

test("a failure reported during a probe survives that probe's older answer", async () => {
  let release: (() => void) | undefined;
  services.setServiceProbeForTests("sandbox", async () => {
    await new Promise<void>((resolve) => (release = resolve));
    return { results: { sandbox: { state: "up", reasonKey: "ok" } } };
  });
  const pending = services.servicesFor("alice");
  await new Promise((resolve) => setTimeout(resolve, 10));
  services.reportServiceFailure("sandbox");
  release?.();
  const statuses = byId(await pending);
  assert.equal(statuses.get("sandbox")?.state, "down", "a real failure is newer than the probe that was already running");
  assert.equal(services.serviceDown("sandbox"), true);
});

test("a success reported during a probe is not overwritten either", async () => {
  let release: (() => void) | undefined;
  services.setServiceProbeForTests("sandbox", async () => {
    await new Promise<void>((resolve) => (release = resolve));
    return { results: { sandbox: { state: "down", reasonKey: "refuses" } } };
  });
  const pending = services.servicesFor("alice");
  await new Promise((resolve) => setTimeout(resolve, 10));
  services.reportServiceSuccess("sandbox");
  release?.();
  const statuses = byId(await pending);
  assert.equal(statuses.get("sandbox")?.state, "up");
  assert.equal(services.serviceDown("sandbox"), false);
});

test("a successful request does not erase a known degraded state", async () => {
  services.setServiceProbeForTests("speech", async () => ({ results: { speech: { state: "degraded", reasonKey: "cpuFallback" } } }));
  await services.servicesFor("alice");
  assert.equal(services.serviceSnapshot("speech")?.state, "degraded");
  services.reportServiceSuccess("speech");
  assert.equal(services.serviceSnapshot("speech")?.state, "degraded", "a CPU fallback is still degraded after a successful request");
});

test("a forced refresh is cooldown-limited per source across accounts", async () => {
  let probes = 0;
  services.setServiceProbeForTests("sandbox", async () => {
    probes++;
    return { results: { sandbox: { state: "up", reasonKey: "ok" } } };
  });
  await services.servicesFor("alice", true);
  assert.equal(probes, 1);
  // Another account's ten tabs cannot force a second probe inside the shared cooldown.
  await services.servicesFor("bob", true);
  await services.servicesFor("alice", true);
  assert.equal(probes, 1, "one probe per source per cooldown, not one per account");
});

test("speech-only and image-only keys do not count as chat providers", async () => {
  saveConnection("alice", "speech-openai", { apiKey: "sk-speech-only" });
  saveConnection("alice", "image-black-forest-labs", { apiKey: "sk-image-only" });
  assert.equal(byId(await services.servicesFor("alice")).get("providers")?.state, "unconfigured");
  saveConnection("alice", "openai", { apiKey: "sk-chat" });
  assert.equal(byId(await services.servicesFor("alice", true)).get("providers")?.state, "up");
});

test("request evidence for one capability cannot hide or refresh its sibling", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  services.setServiceProbeForTests("browser", async () => {
    calls++;
    return { results: {
      browser: { state: "up", reasonKey: "ok" },
      scrapling: { state: "down", reasonKey: "refuses" },
    } };
  });
  services.reportServiceSuccess("browser");
  const initial = byId(await services.servicesFor("alice"));
  assert.equal(initial.get("scrapling")?.state, "down", "partial request evidence still needs a complete probe");
  assert.equal(calls, 1);
  now += services.SERVICE_TTL_MS + 1;
  services.reportServiceSuccess("browser");
  assert.equal(services.serviceDown("scrapling"), false, "a stale sibling failure is no longer a guard");
  await services.servicesFor("alice");
  assert.equal(calls, 2, "a render request cannot extend the fetch health TTL");
});

test("a shared key the user is not entitled to does not count as a provider", async () => {
  saveConnection(null, "openai", { apiKey: "sk-shared-not-real" });
  const { setAudience } = await import("./groups.js");
  // Restricted to bob, so alice sees no usable connection while bob does.
  setAudience("provider", "openai", { mode: "selected", userIds: ["bob"], groupIds: [] });
  assert.equal(byId(await services.servicesFor("alice")).get("providers")?.state, "unconfigured");
  assert.equal(byId(await services.servicesFor("bob")).get("providers")?.state, "up");
});
