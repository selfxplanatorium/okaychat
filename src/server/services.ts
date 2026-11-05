import { Hono } from "hono";
import {
  SERVICE_IDS,
  type FixedServiceId,
  type ServiceFix,
  type ServiceReason,
  type ServiceState,
  type ServiceStatus,
  type ServicesResponse,
} from "../shared/services.js";
import type { AppEnv } from "./auth.js";
import { AppError } from "./errors.js";
import { featureAllowed } from "./permissions/guard.js";

// One registry of service probes. Sidecars (browser worker, speech worker, sandbox, SearXNG) are probed on
// demand only: a result lives for SERVICE_TTL_MS, concurrent callers share one probe in flight, and there is no
// timer, so an idle server spends nothing. Per-account entries (Codex login, providers, email) are database reads
// and never contact a vendor. Probes never throw. The client modules (browser.ts, tools/sandbox.ts,
// speech/worker.ts) are imported lazily inside the probes, because they import this module for the fail-fast
// guard and failure reports. See docs/implementation/service-health.md.

export const SERVICE_TTL_MS = 15_000;
export const PROBE_TIMEOUT_MS = 2_000;

/** Tests shorten both so TTL and timeout behaviour is checked without waiting seconds. */
let ttlMs = SERVICE_TTL_MS;
let probeTimeoutMs = PROBE_TIMEOUT_MS;

/** A sidecar probe source. The browser worker's one health answer yields both `browser` and `scrapling`. */
export type ServiceSource = "browser" | "speech" | "sandbox" | "searxng";
const SOURCE_IDS: Record<ServiceSource, FixedServiceId[]> = {
  browser: ["browser", "scrapling"],
  speech: ["speech"],
  sandbox: ["sandbox"],
  searxng: ["searxng"],
};
const SOURCE_OF: Partial<Record<FixedServiceId, ServiceSource>> = { browser: "browser", scrapling: "browser", speech: "speech", sandbox: "sandbox", searxng: "searxng" };
const SOURCES = Object.keys(SOURCE_IDS) as ServiceSource[];

type ProbeResult = { state: ServiceState; reasonKey: ServiceReason; fixKey?: ServiceFix };
/** What a source's network check returns: one entry per id of the source, plus private detail never sent to clients. */
export interface ProbeOutcome {
  results: Partial<Record<FixedServiceId, ProbeResult>>;
  /** Server-side only (for example the speech worker's device report for Admin → Voice). */
  detail?: unknown;
}
export type ProbeFn = (signal: AbortSignal) => Promise<ProbeOutcome | "unconfigured">;

const FIX: Record<ServiceSource, ServiceFix> = { browser: "startBrowser", speech: "startSpeech", sandbox: "startSandbox", searxng: "startSearxng" };

const isTimeout = (error: unknown) => (error as { name?: string })?.name === "TimeoutError" || (error as { name?: string })?.name === "AbortError";

export const searxngUrl = () => (process.env.OKAYCHAT_SEARXNG_URL ?? "").replace(/\/+$/, "");

const DEFAULT_PROBES: Record<ServiceSource, ProbeFn> = {
  browser: async (signal) => {
    const { browserConfigured, fetchBrowserHealth } = await import("./browser.js");
    if (!browserConfigured()) return "unconfigured";
    const health = await fetchBrowserHealth(signal);
    // A worker that cannot answer, or answers that it cannot take jobs, is down for rendering and fetching.
    if (!health) return { results: { browser: { state: "down", reasonKey: "refuses", fixKey: "startBrowser" }, scrapling: { state: "down", reasonKey: "refuses", fixKey: "startBrowser" } } };
    return {
      results: {
        // Without Chromium, PDF rendering and screenshots cannot work; plain page reading does not need the worker.
        browser: health.ok && health.chromium ? { state: "up", reasonKey: "ok" }
          : { state: "down", reasonKey: health.chromium ? "refuses" : "noChromium", fixKey: "startBrowser" },
        // Scrapling is web_fetch's fallback only, so a worker without it is reported apart from rendering.
        scrapling: health.scrapling ? { state: "up", reasonKey: "ok" }
          : health.ok ? { state: "unconfigured", reasonKey: "noScrapling" } : { state: "down", reasonKey: "refuses", fixKey: "startBrowser" },
      },
    };
  },
  speech: async (signal) => {
    const { speechWorkerConfigured, fetchWorkerHealth } = await import("./speech/worker.js");
    if (!speechWorkerConfigured()) return "unconfigured";
    // /health reports the device probe; it never loads a Whisper or Piper model.
    const health = await fetchWorkerHealth(signal);
    if (!health) return { results: { speech: { state: "down", reasonKey: "refuses", fixKey: "startSpeech" } } };
    // A CUDA failure that fell back to the CPU is slower, never unavailable.
    return {
      results: { speech: health.degraded ? { state: "degraded", reasonKey: "cpuFallback" } : health.ok ? { state: "up", reasonKey: "ok" } : { state: "down", reasonKey: "refuses", fixKey: "startSpeech" } },
      detail: health,
    };
  },
  sandbox: async (signal) => {
    const { sandboxConfigured, sandboxHealthy } = await import("./tools/sandbox.js");
    if (!sandboxConfigured()) return "unconfigured";
    // 503 means the runner is up but refuses every run (isolation could not be set up): fail closed.
    return { results: { sandbox: (await sandboxHealthy(signal)) ? { state: "up", reasonKey: "ok" } : { state: "down", reasonKey: "refuses", fixKey: "startSandbox" } } };
  },
  searxng: async (signal) => {
    const url = searxngUrl();
    if (!url) return "unconfigured";
    const res = await fetch(`${url}/healthz`, { signal });
    await res.body?.cancel().catch(() => {});
    // Search keeps working through the public fallback engines, so a missing SearXNG is a slower search, not none.
    return { results: { searxng: res.ok ? { state: "up", reasonKey: "ok" } : { state: "down", reasonKey: "refuses", fixKey: "startSearxng" } } };
  },
};

let probes: Record<ServiceSource, ProbeFn> = { ...DEFAULT_PROBES };

interface Cached {
  statuses: ServiceStatus[];
  at: number;
  detail?: unknown;
}
const cache = new Map<ServiceSource, Cached>();
const inflight = new Map<ServiceSource, Promise<Cached>>();

// Real request outcomes are stronger evidence than a probe that started before them. Each id carries a
// version; a probe merges only the ids whose version did not move while it was in flight. Without this a
// failure reported during a probe was overwritten by that older probe's answer (result.at is completion time).
const evidence = new Map<FixedServiceId, { version: number; status: ServiceStatus }>();
let evidenceVersion = 0;

/** A forced refresh shares one per-source cooldown, so ten tabs (or accounts) cannot fan out. */
export const FORCE_COOLDOWN_MS = 5_000;
let forceCooldownMs = FORCE_COOLDOWN_MS;
const lastForced = new Map<ServiceSource, number>();

const unconfigured = (source: ServiceSource, at: number): ServiceStatus[] =>
  SOURCE_IDS[source].map((id) => ({ id, state: "unconfigured", reasonKey: "notConfigured", checkedAt: at }));

const failed = (source: ServiceSource, reasonKey: "unreachable" | "timeout", at: number, latencyMs?: number): ServiceStatus[] =>
  SOURCE_IDS[source].map((id) => ({ id, state: "down", reasonKey, fixKey: FIX[source], checkedAt: at, ...(latencyMs !== undefined ? { latencyMs } : {}) }));

/** Resolves after `work` settles or `ms` passes, whichever comes first. The deadline is never left pending. */
function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const wait = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return Promise.race([work.then(() => undefined, () => undefined), wait]).finally(() => clearTimeout(timer));
}

/** Runs one source's probe with its own deadline. Never throws: every failure becomes a `down` status. */
async function runProbe(source: ServiceSource): Promise<Cached> {
  const started = Date.now();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException("probe timed out", "TimeoutError"));
      resolve("timeout");
    }, probeTimeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([probes[source](controller.signal), deadline]);
    const at = Date.now();
    const latencyMs = at - started;
    if (outcome === "timeout") return { statuses: failed(source, "timeout", at, latencyMs), at };
    if (outcome === "unconfigured") return { statuses: unconfigured(source, at), at };
    const statuses = SOURCE_IDS[source].map((id): ServiceStatus => {
      const result = outcome.results[id] ?? { state: "down", reasonKey: "refuses", fixKey: FIX[source] };
      return { id, ...result, checkedAt: at, latencyMs };
    });
    return { statuses, at, detail: outcome.detail };
  } catch (error) {
    const at = Date.now();
    return { statuses: failed(source, controller.signal.aborted || isTimeout(error) ? "timeout" : "unreachable", at, at - started), at };
  } finally {
    clearTimeout(timer);
  }
}

const fresh = (entry: Cached | undefined, now = Date.now()) => !!entry && now - entry.at < ttlMs;

/** A cached result within the TTL, or one probe shared by every concurrent caller. */
function sourceStatus(source: ServiceSource, force = false): Promise<Cached> {
  const cached = cache.get(source);
  if (force) {
    const now = Date.now();
    if (now - (lastForced.get(source) ?? 0) >= forceCooldownMs) lastForced.set(source, now);
    else force = false;
  }
  if (!force && fresh(cached) && SOURCE_IDS[source].every((id) => cached!.statuses.some((status) => status.id === id && Date.now() - status.checkedAt < ttlMs))) return Promise.resolve(cached!);
  let pending = inflight.get(source);
  if (!pending) {
    // Snapshot before starting: a report that lands while this probe runs is newer than its answer.
    const versions = new Map(SOURCE_IDS[source].map((id) => [id, evidence.get(id)?.version ?? 0]));
    pending = runProbe(source)
      .then((result) => {
        const statuses = SOURCE_IDS[source].map((id) => {
          const newer = evidence.get(id);
          if (newer && newer.version > (versions.get(id) ?? 0)) return newer.status;
          return result.statuses.find((status) => status.id === id) ?? {
            id,
            state: "down" as const,
            reasonKey: "refuses" as const,
            fixKey: FIX[source],
            checkedAt: result.at,
          };
        });
        const merged: Cached = { statuses, at: result.at, detail: result.detail };
        cache.set(source, merged);
        return merged;
      })
      .finally(() => inflight.delete(source));
    inflight.set(source, pending);
  }
  return pending;
}

/** The last known status of a sidecar, at any age, without probing. Undefined until the first probe. */
export function serviceSnapshot(id: FixedServiceId): ServiceStatus | undefined {
  const source = SOURCE_OF[id];
  return source ? cache.get(source)?.statuses.find((status) => status.id === id) : undefined;
}

/** One sidecar's status, probing at most once per TTL. Never throws. */
export async function serviceStatus(id: FixedServiceId): Promise<ServiceStatus | undefined> {
  const source = SOURCE_OF[id];
  if (!source) return undefined;
  return (await sourceStatus(source)).statuses.find((status) => status.id === id);
}

/** True only for a fresh `down` result. A stale or missing result never blocks a request: the request itself tests it. */
export function serviceDown(id: FixedServiceId): boolean {
  const source = SOURCE_OF[id];
  if (!source) return false;
  const entry = cache.get(source);
  const status = entry?.statuses.find((status) => status.id === id);
  return !!status && Date.now() - status.checkedAt < ttlMs && status.state === "down";
}

/**
 * Statuses for the sidecars a chat turn needs. Fresh results are used as they are; otherwise the turn waits at
 * most `waitMs` for the shared probe and treats a still-unknown service as available (its call then fails fast).
 */
export async function turnServiceStates(ids: FixedServiceId[], waitMs = PROBE_TIMEOUT_MS): Promise<Map<FixedServiceId, ServiceStatus | undefined>> {
  const sources = [...new Set(ids.map((id) => SOURCE_OF[id]).filter((source): source is ServiceSource => !!source))];
  await within(Promise.all(sources.map((source) => sourceStatus(source))), waitMs);
  const out = new Map<FixedServiceId, ServiceStatus | undefined>();
  for (const id of ids) {
    const source = SOURCE_OF[id];
    const entry = source ? cache.get(source) : undefined;
    const status = entry?.statuses.find((status) => status.id === id);
    out.set(id, status && Date.now() - status.checkedAt < ttlMs ? status : undefined);
  }
  return out;
}

/** The speech worker's own report for Admin → Voice, from the same cached probe. */
export async function speechWorkerDetail<T>(force = false): Promise<T | null> {
  return ((await sourceStatus("speech", force)).detail as T | undefined) ?? null;
}

/** Stores newer evidence for one id, keeping the other ids of the same worker untouched. */
function reportEvidence(id: FixedServiceId, status: ServiceStatus) {
  evidence.set(id, { version: ++evidenceVersion, status });
  const source = SOURCE_OF[id];
  if (!source) return;
  const current = cache.get(source);
  const statuses = current
    ? [...current.statuses.filter((entry) => entry.id !== id), status]
    : [status];
  cache.set(source, { statuses, at: status.checkedAt, detail: current?.detail });
}

/**
 * A request to the service could not connect. Only the id the call needed goes down: a failed page fetch
 * says nothing about PDF rendering, and a busy render says nothing about Scrapling.
 */
export function reportServiceFailure(id: FixedServiceId, reasonKey: "unreachable" | "timeout" = "unreachable") {
  const source = SOURCE_OF[id];
  if (!source) return;
  reportEvidence(id, {
    id,
    state: "down",
    reasonKey,
    fixKey: FIX[source],
    checkedAt: Date.now(),
  });
}

/** A request succeeded. A cached `down` for this id is wrong now; the next probe establishes the real state. */
export function reportServiceSuccess(id: FixedServiceId) {
  if (!SOURCE_OF[id]) return;
  const source = SOURCE_OF[id]!;
  const current = cache.get(source)?.statuses.find((status) => status.id === id);
  // A successful call proves the worker answers, not that a known limitation (the CPU fallback) is gone.
  if (current?.state === "degraded") {
    reportEvidence(id, current);
    return;
  }
  reportEvidence(id, { id, state: "up", reasonKey: "ok", checkedAt: Date.now() });
}

/** Server-side English for the model and the wire fallback. The web app translates by code and service. */
const UNAVAILABLE: Partial<Record<FixedServiceId, { message: string; hint: string }>> = {
  browser: {
    message: "The browser worker is not reachable, so PDF rendering and screenshots are unavailable right now.",
    hint: "Ask an admin to start the browser service (docker compose up -d browser). Word and Excel documents still work.",
  },
  scrapling: {
    message: "The browser worker's page-reading fallback is not reachable right now.",
    hint: "Plain page reading still works when possible. Ask an admin to start the browser service (docker compose up -d browser).",
  },
  speech: {
    message: "The speech worker is not reachable, so server voices and Whisper are unavailable right now.",
    hint: "Ask an admin to start the speech service (docker compose up -d speech), or pick another engine in Settings → Voice.",
  },
  sandbox: {
    message: "The code sandbox is not reachable, so code cannot run right now.",
    hint: "Ask an admin to start the sandbox service (docker compose up -d sandbox). Saved outputs stay in the Library.",
  },
};

export function serviceUnavailable(id: FixedServiceId): AppError {
  const text = UNAVAILABLE[id] ?? { message: "A service this needs is unavailable.", hint: "Try again shortly." };
  return new AppError({ code: "service_unavailable", message: text.message, hint: text.hint });
}

/** Fails fast with `service_unavailable` while a fresh probe or failed request says the service is down. */
export function assertServiceAvailable(id: FixedServiceId) {
  if (serviceDown(id)) throw serviceUnavailable(id);
}

/** Tool errors arrive in the stream as plain text; ours are recognised so the card shows the service failure. */
export function serviceUnavailableFromText(text: unknown): AppError | undefined {
  if (typeof text !== "string") return undefined;
  for (const [id, value] of Object.entries(UNAVAILABLE)) {
    if (value && text.includes(value.message)) return serviceUnavailable(id as FixedServiceId);
  }
  return undefined;
}

// Provider connections are never tested from here: that would spend the user's quota or a shared key. The only
// evidence is the outcome of the user's own last chat request, kept in memory per account.
const providerRejections = new Map<string, number>();

export function noteProviderOutcome(userId: string, outcome: "ok" | "rejected") {
  if (outcome === "ok") providerRejections.delete(userId);
  else providerRejections.set(userId, Date.now());
}

async function accountStatuses(userId: string): Promise<ServiceStatus[]> {
  const now = Date.now();
  const out: ServiceStatus[] = [];
  const [{ isConnected }, { usableConnectionCount }, { listAccounts }] = await Promise.all([
    import("./codex.js"),
    import("./catalog/providers.js"),
    import("./email/accounts.js"),
  ]);
  out.push(isConnected(userId)
    ? { id: "codex", state: "up", reasonKey: "signedIn", checkedAt: now }
    : { id: "codex", state: "unconfigured", reasonKey: "signedOut", fixKey: "providers", checkedAt: now });
  // Database only, honouring audiences and model policies: configured is not the same as verified.
  const connections = usableConnectionCount(userId);
  const rejected = providerRejections.get(userId);
  out.push(!connections
    ? { id: "providers", state: "unconfigured", reasonKey: "noProviders", fixKey: "providers", checkedAt: now }
    : rejected
      ? { id: "providers", state: "degraded", reasonKey: "providerRejected", fixKey: "providers", checkedAt: rejected }
      : { id: "providers", state: "up", reasonKey: "configured", checkedAt: now });
  // One unreadable row must not hide the other accounts' statuses (or the provider entries above).
  let accounts: ReturnType<typeof listAccounts> = [];
  try {
    accounts = listAccounts(userId);
  } catch {
    accounts = [];
  }
  for (const account of accounts) {
    // The stored result of the user's own last test. An untested account is never reported as working.
    out.push(account.lastCheckStatus === "ok"
      ? { id: `email:${account.id}`, state: "up", reasonKey: "emailVerified", checkedAt: account.lastCheckAt ?? 0 }
      : account.lastCheckStatus === "failed"
        ? { id: `email:${account.id}`, state: "down", reasonKey: "emailTestFailed", fixKey: "email", checkedAt: account.lastCheckAt ?? 0 }
        : { id: `email:${account.id}`, state: "degraded", reasonKey: "emailUntested", fixKey: "email", checkedAt: 0 });
  }
  return out;
}

/** The sidecar sources this account can actually use. A disabled capability is never probed. */
function usableSources(userId: string): ServiceSource[] {
  const sources: ServiceSource[] = [];
  // Rendering follows artifacts; Scrapling is web_fetch's fallback.
  if (featureAllowed(userId, "artifacts") || featureAllowed(userId, "webFetch")) sources.push("browser");
  if (featureAllowed(userId, "voice")) sources.push("speech");
  if (featureAllowed(userId, "code")) sources.push("sandbox");
  if (featureAllowed(userId, "webSearch")) sources.push("searxng");
  return sources;
}

/** Every entry for one account: shared sidecars from the cache or one probe, then that account's own entries. */
export async function servicesFor(userId: string, force = false): Promise<ServiceStatus[]> {
  const usable = usableSources(userId);
  const [sidecars, account] = await Promise.all([
    Promise.all(usable.map((source) => sourceStatus(source, force))),
    accountStatuses(userId).catch(() => [] as ServiceStatus[]),
  ]);
  const byId = new Map(sidecars.flatMap((entry) => entry.statuses).map((status) => [status.id, status]));
  // A capability the account may not use reports a local "not configured here" status, never a probe or
  // an outage: an admin Allow is what changes it, not a service restart.
  const at = Date.now();
  for (const source of SOURCES) {
    if (usable.includes(source)) continue;
    for (const id of SOURCE_IDS[source]) byId.set(id, { id, state: "unconfigured", reasonKey: "notConfigured", checkedAt: at });
  }
  return [...SERVICE_IDS.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])), ...account];
}

export const serviceRoutes = new Hono<AppEnv>().get("/services", async (c) => {
  const userId = c.get("user").id;
  // The per-source cooldown in sourceStatus bounds a forced refresh across accounts and tabs; one account
  // cannot multiply probes, and the shared worker health stays one path.
  const force = c.req.query("refresh") === "1";
  c.header("Cache-Control", "private, no-store");
  return c.json({ services: await servicesFor(userId, force) } satisfies ServicesResponse);
});

/** Tests only: replace one source's network check, and clear every cached result. */
export function setServiceProbeForTests(source: ServiceSource, probe: ProbeFn | null) {
  probes = { ...probes, [source]: probe ?? DEFAULT_PROBES[source] };
}

export function resetServicesForTests() {
  cache.clear();
  inflight.clear();
  evidence.clear();
  evidenceVersion = 0;
  providerRejections.clear();
  lastForced.clear();
  probes = { ...DEFAULT_PROBES };
  ttlMs = SERVICE_TTL_MS;
  probeTimeoutMs = PROBE_TIMEOUT_MS;
  forceCooldownMs = FORCE_COOLDOWN_MS;
}

/** Tests only: shorten the cache lifetime, the per-probe deadline, and the forced-refresh cooldown. */
export function setServiceTimingForTests(timing: { ttlMs?: number; probeTimeoutMs?: number; forceCooldownMs?: number }) {
  if (timing.ttlMs !== undefined) ttlMs = timing.ttlMs;
  if (timing.probeTimeoutMs !== undefined) probeTimeoutMs = timing.probeTimeoutMs;
  if (timing.forceCooldownMs !== undefined) forceCooldownMs = timing.forceCooldownMs;
}
