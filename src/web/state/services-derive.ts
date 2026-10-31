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
  // A speech outage has two fixes: start the worker (the command text) or pick another engine here.
  startSpeech: "voice",
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

/**
 * The assistant-ui `PartState` shape for a tool call, with only what this module reads. `status` comes from
 * the message state wrapper (`PartState`), while a result tool error arrives as `isError` plus
 * `result: { error }` from `@assistant-ui/ai-sdk`'s converter. See docs/implementation/service-health.md.
 */
export interface ToolPartLike {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  status?: { type?: string; reason?: string; error?: unknown };
}

const objectOf = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

/** The text a failed tool carries, wherever assistant-ui put it. */
function toolErrorText(part: ToolPartLike): string | undefined {
  const error = objectOf(part.result)?.error;
  if (typeof error === "string") return error;
  const statusError = part.status?.type === "incomplete" ? part.status.error : undefined;
  if (typeof statusError === "string") return statusError;
  const nested = objectOf(statusError);
  return nested && typeof nested.message === "string" ? nested.message : undefined;
}

/**
 * A small, stable identity for a tool result. It must change when the final result arrives (so the watcher
 * re-evaluates) and stay put while text streams, and it must carry the fields the use rules read: a
 * document's kind, a page's fetch method, and an email account id. Never the whole result: the signature is
 * a selector value.
 */
function resultIdentity(result: unknown): string {
  if (result === undefined) return "";
  const value = objectOf(result);
  if (!value) return "value";
  const bits: string[] = [];
  if (typeof value.kind === "string") bits.push(`kind=${value.kind}`);
  if (typeof value.via === "string") bits.push(`via=${value.via}`);
  const account = objectOf(value.account);
  if (typeof account?.id === "string") bits.push(`account=${account.id}`);
  if (Array.isArray(value.accounts)) {
    const ids = value.accounts.flatMap((entry) => {
      const id = objectOf(entry)?.id;
      return typeof id === "string" ? [id] : [];
    });
    if (ids.length) bits.push(`accounts=${ids.join(",")}`);
  }
  return bits.length ? bits.join(",") : "object";
}

/**
 * Changes when a tool starts, finishes, or fails, and not for a text delta. `useAuiState` selectors must
 * return a primitive, so this is one string.
 */
export function toolPartsSignature(parts: readonly ToolPartLike[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part.type !== "tool-call") continue;
    const status = part.status;
    out.push([
      part.toolCallId ?? "",
      part.toolName ?? "",
      status?.type ?? "",
      status?.type === "incomplete" ? status.reason ?? "" : "",
      part.isError ? "error" : "",
      resultIdentity(part.result),
      part.isError ? toolErrorText(part)?.includes("service_unavailable") ? "service" : "" : "",
    ].join(":"));
  }
  return out.join("|");
}

/** The email account a call reached: its explicit argument, or the account its result names. */
function emailAccountId(part: ToolPartLike, result: Record<string, unknown> | undefined): string | undefined {
  const args = objectOf(part.args);
  if (typeof args?.accountId === "string" && args.accountId) return args.accountId;
  const account = objectOf(result?.account);
  return typeof account?.id === "string" && account.id ? account.id : undefined;
}

/**
 * Services a reply actually exercised. Called for the message being written, never for stored history, so
 * reopening an old chat does not raise a notice. A document tool counts only when it produced a PDF, the
 * one document format that needs the browser worker. Page reading counts Scrapling only when the fallback
 * actually served the page. Email counts the account the call used.
 */
export function usedServicesFromParts(parts: readonly ToolPartLike[]): ServiceId[] {
  const used = new Set<ServiceId>();
  for (const part of parts) {
    if (part.type !== "tool-call" || typeof part.toolName !== "string") continue;
    const name = part.toolName;
    const result = objectOf(part.result);
    const direct = TOOL_SERVICE[name];
    if (direct) used.add(direct);
    if (name === "web_fetch" && result?.via === "scrapling") used.add("scrapling");
    if (name === "create_document" || name === "edit_document" || name === "import_document") {
      if (result?.kind === "pdf" || objectOf(part.args)?.kind === "pdf") used.add("browser");
    }
    if (name.startsWith("email_")) {
      if (name === "email_folders" && Array.isArray(result?.accounts)) {
        for (const entry of result.accounts) {
          const id = objectOf(entry)?.id;
          if (typeof id === "string" && id) used.add(`email:${id}`);
        }
      } else {
        const id = emailAccountId(part, result);
        if (id) used.add(`email:${id}`);
      }
    }
    // A service failure names its tool; mark it so the banner can explain a call that never started.
    if ((part.isError === true || part.status?.type === "incomplete") && toolErrorText(part)?.includes("service_unavailable")) {
      if (direct) used.add(direct);
      else if (name === "create_document" || name === "edit_document" || name === "import_document") used.add("browser");
    }
  }
  return [...used];
}

/** A running reply itself is chat activity: the account's provider row is in use, and so is a Codex login. */
export function usedServicesForReply(parts: readonly ToolPartLike[], modelRef: string | undefined): ServiceId[] {
  const used = new Set<ServiceId>(usedServicesFromParts(parts));
  used.add("providers");
  if (modelRef?.startsWith("chatgpt/")) used.add("codex");
  return [...used];
}

/** True when a call failed because a registry service was down, which is a reason to re-check now. */
export function hasServiceFailure(parts: readonly ToolPartLike[]): boolean {
  return parts.some((part) =>
    part.type === "tool-call" &&
    (part.isError === true || part.status?.type === "incomplete") &&
    !!toolErrorText(part)?.includes("service_unavailable"),
  );
}

/** A custom panel note describes a down service; a degraded one explains its own limitation instead. */
export function customServiceMessageKey(state: ServiceAvailability, messageKey?: PlainMessageKey): PlainMessageKey | undefined {
  return state === "down" || state === "unconfigured" ? messageKey : undefined;
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
