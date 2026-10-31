/**
 * Service health shared by the server registry (`src/server/services.ts`) and the browser
 * (`src/web/state/services.ts`). The wire carries only these fields: no URL, token, host, or raw worker text.
 * Reasons and fixes are short codes the web app translates. See docs/implementation/service-health.md.
 */

/** Server-wide sidecars, then per-account entries. Email accounts add `email:<accountId>` entries. */
export const SERVICE_IDS = ["browser", "scrapling", "speech", "sandbox", "searxng", "codex", "providers"] as const;
export type FixedServiceId = (typeof SERVICE_IDS)[number];
export type ServiceId = FixedServiceId | `email:${string}`;

export const SERVICE_STATES = ["up", "down", "degraded", "unconfigured"] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

export const SERVICE_REASONS = [
  /** Answered its health check. */
  "ok",
  "notConfigured",
  "unreachable",
  "timeout",
  /** Answered, but reports that it cannot do its job (sandbox isolation, worker not ready). */
  "refuses",
  /** The browser worker answers but its Chromium is missing. */
  "noChromium",
  /** The browser worker answers but Scrapling is not installed in it. */
  "noScrapling",
  /** The speech worker runs on the CPU after a GPU failure. Slower, still usable. */
  "cpuFallback",
  "signedIn",
  "signedOut",
  /** At least one provider connection is configured; nothing has been checked against the vendor. */
  "configured",
  "noProviders",
  /** The last chat request on this account was rejected by a provider (key, quota). */
  "providerRejected",
  /** The account's last connection test passed (`checkedAt` is that test's time). */
  "emailVerified",
  "emailTestFailed",
  "emailUntested",
] as const;
export type ServiceReason = (typeof SERVICE_REASONS)[number];

/** What fixes it: a compose service to start, or the settings page that configures it. */
export const SERVICE_FIXES = ["startBrowser", "startSpeech", "startSandbox", "startSearxng", "providers", "email", "voice", "codeExecution"] as const;
export type ServiceFix = (typeof SERVICE_FIXES)[number];

export interface ServiceStatus {
  id: ServiceId;
  state: ServiceState;
  reasonKey: ServiceReason;
  fixKey?: ServiceFix;
  /** When this result was produced, ms since epoch. For email it is the account's last test. 0 when never checked. */
  checkedAt: number;
  latencyMs?: number;
}

export interface ServicesResponse {
  services: ServiceStatus[];
}

/**
 * Tools a turn did not offer because a service they need was down when the turn started, stored on the
 * assistant message's metadata (`unavailable`) so the reply can say why and continuations keep the same tool list.
 * `service` is a registry id or `mcp`; `name` is the MCP server's own name.
 */
export interface TurnUnavailable {
  service: FixedServiceId | "mcp";
  tools: string[];
  reasonKey: ServiceReason | "mcpError" | "mcpNeedsAuth";
  fixKey?: ServiceFix | "mcp";
  name?: string;
}

const STATES = new Set<string>(SERVICE_STATES);
const REASONS = new Set<string>(SERVICE_REASONS);
const FIXES = new Set<string>(SERVICE_FIXES);
const FIXED = new Set<string>(SERVICE_IDS);
const ID = /^email:[A-Za-z0-9_-]{1,64}$/;

export const isServiceId = (value: unknown): value is ServiceId => typeof value === "string" && (FIXED.has(value) || ID.test(value));

/** Keeps known fields only, so an unexpected payload cannot put arbitrary text in the UI. */
export function parseServiceStatus(value: unknown): ServiceStatus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (!isServiceId(v.id) || typeof v.state !== "string" || !STATES.has(v.state) || typeof v.reasonKey !== "string" || !REASONS.has(v.reasonKey)) return undefined;
  const checkedAt = typeof v.checkedAt === "number" && Number.isFinite(v.checkedAt) ? v.checkedAt : 0;
  return {
    id: v.id,
    state: v.state as ServiceState,
    reasonKey: v.reasonKey as ServiceReason,
    ...(typeof v.fixKey === "string" && FIXES.has(v.fixKey) ? { fixKey: v.fixKey as ServiceFix } : {}),
    checkedAt,
    ...(typeof v.latencyMs === "number" && Number.isFinite(v.latencyMs) && v.latencyMs >= 0 ? { latencyMs: Math.round(v.latencyMs) } : {}),
  };
}

const TURN_REASONS = new Set<string>([...SERVICE_REASONS, "mcpError", "mcpNeedsAuth"]);

/** Reads `unavailable` from assistant metadata, wherever assistant-ui or the AI SDK put it. */
export function parseTurnUnavailable(value: unknown): TurnUnavailable[] {
  if (!Array.isArray(value)) return [];
  const out: TurnUnavailable[] = [];
  for (const item of value.slice(0, 20)) {
    if (typeof item !== "object" || item === null) continue;
    const v = item as Record<string, unknown>;
    if (typeof v.service !== "string" || !(FIXED.has(v.service) || v.service === "mcp")) continue;
    if (typeof v.reasonKey !== "string" || !TURN_REASONS.has(v.reasonKey)) continue;
    const tools = Array.isArray(v.tools) ? v.tools.filter((tool): tool is string => typeof tool === "string" && tool.length <= 128).slice(0, 20) : [];
    out.push({
      service: v.service as TurnUnavailable["service"],
      tools,
      reasonKey: v.reasonKey as TurnUnavailable["reasonKey"],
      ...(typeof v.fixKey === "string" && (FIXES.has(v.fixKey) || v.fixKey === "mcp") ? { fixKey: v.fixKey as TurnUnavailable["fixKey"] } : {}),
      ...(typeof v.name === "string" && v.name.trim() ? { name: v.name.slice(0, 80) } : {}),
    });
  }
  return out;
}
