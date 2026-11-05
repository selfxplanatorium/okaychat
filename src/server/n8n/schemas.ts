import { z } from "zod";
import { AGENT_AVATARS, N8N_LIMITS, type N8nAgentConfig, type N8nAgentPublicConfig } from "../../shared/n8n-agents.js";
import { AppError } from "../errors.js";

// Strict validation of agent definitions and route bodies. Every limit here is also enforced on save,
// so a crafted request cannot store what the form would refuse.

const RESERVED_KEYS = new Set(["action", "metadata", "__proto__", "prototype", "constructor"]);
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/;
// Headers the transport sets itself, or that would let a stored value smuggle identity, routing, or framing.
const DENIED_HEADERS = new Set([
  "host", "cookie", "set-cookie", "origin", "referer", "user-agent", "connection", "transfer-encoding", "te", "trailer",
  "upgrade", "forwarded", "keep-alive", "expect", "via",
]);
const DENIED_PREFIXES = ["content-", "accept", "proxy-", "sec-", "x-forwarded-"];

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
const chars = (value: string) => [...value].length;

export function headerNameAllowed(name: string): boolean {
  if (!HTTP_TOKEN.test(name)) return false;
  const lower = name.toLowerCase();
  return !DENIED_HEADERS.has(lower) && !DENIED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Opaque token text: ordinary spaces are allowed, any control byte (CR, LF, NUL, DEL) is not. */
export const headerValueAllowed = (value: string) =>
  value.length > 0 && byteLength(value) <= N8N_LIMITS.authValueBytes && !/[\u0000-\u001f\u007f]/.test(value);

export function webhookUrlProblem(value: string): string | null {
  if (byteLength(value) > N8N_LIMITS.urlBytes) return "url";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "url";
  }
  if (url.protocol !== "https:") return "publicHttps";
  if (url.username || url.password || url.hash || value.includes("#")) return "url";
  return null;
}

/** RFC 6901: "" is the root; each token decodes ~1 to "/" and ~0 to "~"; any other "~" escape is malformed. */
export function parsePointer(pointer: string): string[] | null {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return null;
  const tokens = pointer.slice(1).split("/");
  if (tokens.length > 16) return null;
  const decoded: string[] = [];
  for (const token of tokens) {
    if (/~[^01]|~$/.test(token)) return null;
    const value = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (RESERVED_KEYS.has(value) && value !== "action" && value !== "metadata") return null;
    decoded.push(value);
  }
  return decoded;
}

const fieldKey = z.string().regex(FIELD_KEY).refine((key) => !RESERVED_KEYS.has(key));

export const publicConfigSchema = z
  .object({
    webhookUrl: z.string().min(1).max(8192),
    protocol: z.enum(["webhook", "chat-trigger"]),
    memoryMode: z.enum(["none", "history", "remote"]),
    inputKey: fieldKey,
    sessionKey: fieldKey,
    historyKey: fieldKey,
    responseMode: z.enum(["auto", "ndjson", "sse", "json", "text"]),
    responsePointer: z.string().max(1024).nullable(),
    timeoutMs: z.number().int().min(N8N_LIMITS.timeoutMin).max(N8N_LIMITS.timeoutMax),
    idleTimeoutMs: z.number().int().min(N8N_LIMITS.idleMin).max(N8N_LIMITS.idleMax),
  })
  .strict();

const authHeaderSchema = z.object({ name: z.string().max(200), value: z.string().max(8192) }).strict();

export const audienceSchema = z
  .object({ mode: z.enum(["all", "selected"]), userIds: z.array(z.string().max(100)).max(10_000).default([]), groupIds: z.array(z.string().max(100)).max(10_000).default([]) })
  .strict();

const inputShape = {
  name: z.string().max(400),
  description: z.string().max(4000).default(""),
  avatar: z.enum(AGENT_AVATARS).default("workflow"),
  enabled: z.boolean().default(true),
  config: publicConfigSchema,
  authHeader: authHeaderSchema.nullable().optional(),
};

export const agentInputSchema = z.object(inputShape).strict();
export const sharedAgentInputSchema = z.object({ ...inputShape, audience: audienceSchema.optional() }).strict();
export const agentUpdateSchema = z.object({ revision: z.number().int().min(1), ...inputShape }).strict();
export const sharedAgentUpdateSchema = z.object({ revision: z.number().int().min(1), ...inputShape, audience: audienceSchema.optional() }).strict();
export const deleteSchema = z.object({ revision: z.number().int().min(1) }).strict();
export const testSchema = z
  .object({
    agentId: z.string().max(100).optional(),
    revision: z.number().int().min(1).optional(),
    input: sharedAgentInputSchema.optional(),
    message: z.string().max(N8N_LIMITS.testMessageChars).optional(),
  })
  .strict();

export type AgentInputBody = z.infer<typeof sharedAgentInputSchema>;

const invalid = (field: string, message: string) =>
  new AppError({ code: "validation", message, details: { field } });

/** Semantic checks zod cannot express. Returns the trimmed identity fields. */
export function validateAgentInput(input: AgentInputBody): { name: string; description: string } {
  const name = input.name.trim();
  if (!name || chars(name) > N8N_LIMITS.nameChars) throw invalid("name", `Name must be 1 to ${N8N_LIMITS.nameChars} characters.`);
  const description = input.description.trim();
  if (chars(description) > N8N_LIMITS.descriptionChars) throw invalid("description", `Description must be at most ${N8N_LIMITS.descriptionChars} characters.`);
  validateConfig(input.config);
  if (input.authHeader) {
    if (!headerNameAllowed(input.authHeader.name)) throw invalid("authHeader", "That header name is not allowed. Use Authorization, X-API-Key, or another custom token header.");
    if (!headerValueAllowed(input.authHeader.value)) throw invalid("authHeader", "The header value must be 1 to 4096 bytes without line breaks or control characters.");
  }
  return { name, description };
}

export function validateConfig(config: N8nAgentPublicConfig): void {
  const urlProblem = webhookUrlProblem(config.webhookUrl);
  if (urlProblem === "publicHttps") throw invalid("webhookUrl", "Use an https:// webhook URL.");
  if (urlProblem) throw invalid("webhookUrl", "Enter a valid webhook URL without user name, password, or #fragment.");
  const keys = [config.inputKey, config.sessionKey, config.historyKey];
  if (new Set(keys).size !== keys.length) throw invalid("keys", "The message, session, and history fields must have different names.");
  if (config.responsePointer !== null) {
    if (config.responseMode !== "auto" && config.responseMode !== "json") throw invalid("responsePointer", "A response pointer only applies to JSON responses.");
    if (!parsePointer(config.responsePointer)) throw invalid("responsePointer", "Enter a JSON pointer like /output or /data/0/text.");
  }
  if (config.idleTimeoutMs > config.timeoutMs) throw invalid("idleTimeoutMs", "The idle timeout cannot be longer than the total timeout.");
}

export function fullConfig(config: N8nAgentPublicConfig, authHeader: N8nAgentConfig["authHeader"]): N8nAgentConfig {
  return {
    webhookUrl: config.webhookUrl,
    protocol: config.protocol,
    memoryMode: config.memoryMode,
    inputKey: config.inputKey,
    sessionKey: config.sessionKey,
    historyKey: config.historyKey,
    responseMode: config.responseMode,
    responsePointer: config.responsePointer,
    timeoutMs: config.timeoutMs,
    idleTimeoutMs: config.idleTimeoutMs,
    authHeader,
  };
}

/**
 * The stored header that may follow an edit. Omitted keeps it only for the exact same URL; a different
 * destination never inherits a credential. Null removes it; a new value replaces it (a renamed header is a
 * new value by definition).
 */
export function nextAuthHeader(
  previous: N8nAgentConfig | null,
  nextUrl: string,
  input: AgentInputBody["authHeader"],
): N8nAgentConfig["authHeader"] {
  if (input === null) return null;
  if (input !== undefined) return { name: input.name, value: input.value };
  if (!previous?.authHeader) return null;
  if (previous.webhookUrl !== nextUrl) {
    throw invalid("authHeader", "The webhook URL changed. Enter the header value again, or remove the header.");
  }
  return previous.authHeader;
}
