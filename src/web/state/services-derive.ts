import {
  SERVICE_IDS,
  parseServiceStatus,
  type FixedServiceId,
  type ServiceFix,
  type ServiceId,
  type ServiceReason,
  type ServiceState,
  type ServiceStatus,
} from "@shared/services";
import type { PlainMessageKey } from "@/i18n";
import type { SettingsDestinationId } from "@/lib/settings-link";

// Pure derivation for service availability. No zustand, no DOM, no fetch: the store holds the data and the
// components render what these functions return, so the rules can be tested in Node. See
// docs/implementation/service-health.md.

/** `checking` means no answer has arrived for this account yet; it is never shown as `down`. */
export type ServiceAvailability = "checking" | ServiceState | "unknown";

/** What a screen knows: the last answer (or null), the services this session used, and what was dismissed. */
export interface ServiceView {
  statuses: ServiceStatus[] | null;
  used: Readonly<Record<string, number>>;
  dismissed: Readonly<Record<string, number>>;
}

const NAMES: Record<FixedServiceId, PlainMessageKey> = {
  browser: "services.nameBrowser",
  scrapling: "services.nameScrapling",
  speech: "services.nameSpeech",
  sandbox: "services.nameSandbox",
  searxng: "services.nameSearxng",
  codex: "services.nameCodex",
  providers: "services.nameProviders",
};

export const serviceNameKey = (id: ServiceId): PlainMessageKey =>
  id.startsWith("email:") ? "services.nameEmail" : (NAMES[id as FixedServiceId] ?? "services.nameService");

export const REASON_KEYS: Record<ServiceReason, PlainMessageKey> = {
  ok: "services.reasonOk",
  notConfigured: "services.reasonNotConfigured",
  unreachable: "services.reasonUnreachable",
  timeout: "services.reasonTimeout",
  refuses: "services.reasonRefuses",
  noChromium: "services.reasonNoChromium",
  noScrapling: "services.reasonNoScrapling",
  cpuFallback: "services.reasonCpuFallback",
  signedIn: "services.reasonSignedIn",
  signedOut: "services.reasonSignedOut",
  configured: "services.reasonConfigured",
  noProviders: "services.reasonNoProviders",
  providerRejected: "services.reasonProviderRejected",
  emailVerified: "services.reasonEmailVerified",
  emailTestFailed: "services.reasonEmailTestFailed",
  emailUntested: "services.reasonEmailUntested",
};

/** The turn note also carries MCP failures, which are not registry entries. */
export const TURN_REASON_KEYS = {
  ...REASON_KEYS,
  mcpError: "services.reasonMcpError",
  mcpNeedsAuth: "services.reasonMcpNeedsAuth",
} as const satisfies Record<ServiceReason | "mcpError" | "mcpNeedsAuth", PlainMessageKey>;

/** How to start or configure it, in words a user can act on. Commands are plain text, never links. */
export const FIX_KEYS: Record<ServiceFix | "mcp", PlainMessageKey> = {
  startBrowser: "services.fixBrowser",
  startSpeech: "services.fixSpeech",
  startSandbox: "services.fixSandbox",
  startSearxng: "services.fixSearxng",
  providers: "services.fixProviders",
  email: "services.fixEmail",
  voice: "services.fixVoice",
  codeExecution: "services.fixCodeExecution",
  mcp: "services.fixMcp",
};

/** The settings page that owns the fix, when one exists. A compose command has no settings page. */
export const FIX_SETTINGS: Partial<Record<ServiceFix | "mcp", SettingsDestinationId>> = {
  providers: "providers",
  email: "email",
  voice: "voice",
  mcp: "mcp",
};

/** Keeps known fields only, so a malformed or hostile payload cannot put text in the UI. */
export function parseServices(value: unknown): ServiceStatus[] {
  if (typeof value !== "object" || value === null) return [];
  const list = (value as { services?: unknown }).services;
  if (!Array.isArray(list)) return [];
  const out: ServiceStatus[] = [];
  for (const item of list.slice(0, 64)) {
    const status = parseServiceStatus(item);
    if (status) out.push(status);
  }
  return out;
}

/** A status for one service; `checking` until this account has an answer. */
export function availabilityOf(view: ServiceView, id: ServiceId): ServiceAvailability {
  if (!view.statuses) return "checking";
  return view.statuses.find((status) => status.id === id)?.state ?? "unknown";
}

/**
 * The services worth a notice: ones this session actually used that are down or degraded, minus anything
 * the user dismissed, in registry order so the banner never jumps. Loading the registry alone adds none.
 */
export function noticeServices(view: ServiceView): ServiceStatus[] {
  if (!view.statuses) return [];
  return orderedStatuses(view.statuses.filter(
    (status) => view.used[status.id] !== undefined && status.state !== "up" && status.state !== "unconfigured" && view.dismissed[status.id] === undefined,
  ));
}

/** Which registry entry a tool belongs to. Speech and providers have no chat tool. */
const TOOL_SERVICE: Record<string, ServiceId> = {
  run_code: "sandbox",
  view_artifact: "browser",
  web_search: "searxng",
};

export interface ToolPartLike {
  type?: string;
  toolName?: string;
  state?: string;
  output?: unknown;
  errorText?: unknown;
}

const toolNameOf = (part: ToolPartLike): string | undefined =>
  typeof part.toolName === "string" ? part.toolName : part.type?.startsWith("tool-") ? part.type.slice(5) : undefined;

/**
 * Services a reply actually exercised. Called for the message being written, never for stored history, so
 * reopening an old chat does not raise a notice. A document tool counts only when it produced a PDF, the
 * one document format that needs the browser worker.
 */
export function usedServicesFromParts(parts: readonly ToolPartLike[]): ServiceId[] {
  const used = new Set<ServiceId>();
  for (const part of parts) {
    const name = toolNameOf(part);
    if (!name) continue;
    const direct = TOOL_SERVICE[name];
    if (direct) used.add(direct);
    if (name === "create_document" || name === "edit_document" || name === "import_document") {
      const kind = part.output && typeof part.output === "object" ? (part.output as { kind?: unknown }).kind : undefined;
      if (kind === "pdf") used.add("browser");
    }
    // A service failure names its tool; mark it so the banner can explain a call that never started.
    if (part.state === "output-error" && typeof part.errorText === "string" && part.errorText.includes("service_unavailable")) {
      if (direct) used.add(direct);
      else if (name === "create_document" || name === "edit_document" || name === "import_document") used.add("browser");
    }
  }
  return [...used];
}

/** The status of a service, for an inline panel that must explain why it is unavailable. */
export function statusOf(view: ServiceView, id: ServiceId): ServiceStatus | undefined {
  return view.statuses?.find((status) => status.id === id);
}

/** A notice must survive a status refresh; only a service that recovered loses its dismissal. */
export function pruneDismissed(view: ServiceView, statuses: ServiceStatus[]): Record<string, number> {
  const dismissed = { ...view.dismissed };
  for (const status of statuses) {
    if (status.state === "up" || status.state === "unconfigured") delete dismissed[status.id];
  }
  return dismissed;
}

/** Registry order, so the banner is stable between renders. */
export const orderedStatuses = (statuses: readonly ServiceStatus[]) =>
  [...statuses].sort((a, b) => {
    const rank = (id: string) => (SERVICE_IDS as readonly string[]).indexOf(id);
    const left = rank(a.id);
    const right = rank(b.id);
    return (left < 0 ? SERVICE_IDS.length : left) - (right < 0 ? SERVICE_IDS.length : right);
  });
