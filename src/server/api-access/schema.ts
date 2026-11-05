import { z } from "zod";
import {
  API_LIMITS,
  type ApiChatMessage,
  type ApiChatRequest,
  type ApiScope,
} from "../../shared/api-access.js";
import { validModelRef } from "../../shared/permissions.js";
import { parseStrictJson, PolicyInputError } from "../permissions/schema.js";

// Bounded request parsing for the external API. Bodies are consumed with a byte cap and deadlines while
// streaming, never by `request.text()` first, so an oversized upload cannot be buffered.

export class ApiBodyTooLarge extends Error {}
export class ApiBodyTimeout extends Error {}
export class ApiValidationError extends Error {
  constructor(message: string, readonly param: string | null = null, readonly code = "invalid_request") {
    super(message);
  }
}

export interface BodyLimits {
  maxBytes: number;
  idleMs: number;
  totalMs: number;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Reads a request body up to `maxBytes`, cancelling the reader at the cap or a deadline. Chunks beyond
 * the cap are never buffered. Malformed UTF-8 is rejected rather than replaced.
 */
export async function readBoundedBody(request: Request, limits: BodyLimits, signal?: AbortSignal): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const started = Date.now();
  let idle = started;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelled = false;
  const cancel = async () => {
    if (cancelled) return;
    cancelled = true;
    await reader.cancel().catch(() => {});
  };
  const deadline = async <T>(promise: Promise<T>, ms: number, make: () => Error): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void cancel();
        reject(make());
      }, Math.max(1, ms));
      timer.unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    for (;;) {
      const remaining = limits.totalMs - (Date.now() - started);
      if (remaining <= 0) throw new ApiBodyTimeout();
      const { done, value } = await deadline(reader.read(), Math.min(remaining, limits.idleMs), () =>
        Date.now() - idle >= limits.idleMs ? new ApiBodyTimeout() : new ApiBodyTimeout(),
      );
      if (done) break;
      idle = Date.now();
      total += value.byteLength;
      if (total > limits.maxBytes) {
        await cancel();
        throw new ApiBodyTooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    await cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return utf8.decode(joined);
  } catch {
    throw new ApiValidationError("The request body is not valid UTF-8.", "body");
  }
}

/** Reads a management body (4 KiB) as strict JSON. */
export async function readStrictManagementBody(request: Request): Promise<unknown> {
  const text = await readBoundedBody(request, { maxBytes: 4 * 1024, idleMs: 5_000, totalMs: 10_000 });
  try {
    return parseStrictJson(text, 16);
  } catch (error) {
    if (error instanceof PolicyInputError) throw new ApiValidationError("The request body is not valid JSON.", "body");
    throw error;
  }
}

/** True when the body declares a media type we accept: JSON, optionally with `charset=utf-8`. */
export function acceptsJson(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const parts = contentType.split(";").map((part) => part.trim().toLowerCase());
  if (parts[0] !== "application/json") return false;
  return parts.slice(1).every((part) => part === "" || part === "charset=utf-8");
}

export function hasUnsupportedEncoding(contentEncoding: string | undefined): boolean {
  if (!contentEncoding) return false;
  const value = contentEncoding.trim().toLowerCase();
  return value !== "" && value !== "identity";
}

// Request validation ------------------------------------------------------------------------------------

const SCOPES = new Set<ApiScope>(["models:read", "chat:write"]);
export function isScope(value: unknown): value is ApiScope {
  return typeof value === "string" && SCOPES.has(value as ApiScope);
}

const messageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const requestSchema = z.strictObject({
  model: z.string(),
  messages: z.array(messageSchema).min(1).max(API_LIMITS.maxMessages),
  stream: z.boolean().optional(),
  stream_options: z.strictObject({ include_usage: z.boolean().optional() }).optional(),
  temperature: z.number().optional(),
  reasoning_effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  max_tokens: z.number().optional(),
  max_completion_tokens: z.number().optional(),
  n: z.literal(1).optional(),
});

const nonWhitespace = (text: string) => /\S/.test(text);

export interface ValidatedChatRequest extends ApiChatRequest {
  messages: ApiChatMessage[];
}

/**
 * Parses and validates one chat completion body. Unknown fields are rejected at every level, as are
 * duplicate keys and prototype keys (the strict JSON reader builds own properties, and the strict
 * schemas then refuse anything not in the contract).
 */
export function parseChatRequest(text: string): ValidatedChatRequest {
  let raw: unknown;
  try {
    raw = parseStrictJson(text, 16);
  } catch (error) {
    if (error instanceof PolicyInputError) throw new ApiValidationError("The request body is not valid JSON.", "body");
    throw error;
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path ?? [];
    // A rejected unknown key must not echo attacker-chosen field names.
    const known = path.length > 0 && path.every((part) => typeof part === "number" || ["model", "messages", "role", "content", "stream", "stream_options", "include_usage", "temperature", "reasoning_effort", "max_tokens", "max_completion_tokens", "n"].includes(String(part)));
    if (issue?.code === "unrecognized_keys" || !known) {
      throw new ApiValidationError("Unsupported parameter.", null, "unsupported_parameter");
    }
    const param = path.length ? path.map((part, index) => (index === 0 ? String(part) : typeof part === "number" ? `[${part}]` : `.${String(part)}`)).join("") : null;
    throw new ApiValidationError(issue?.message ?? "The request is not valid.", param);
  }
  const body = parsed.data;
  const model = validApiModel(body.model);
  if (!model) throw new ApiValidationError("Use a provider-qualified model id, such as provider/model.", "model");

  let total = 0;
  let seenNonSystem = false;
  let seenUser = false;
  for (const [index, message] of body.messages.entries()) {
    const bytes = Buffer.byteLength(message.content, "utf8");
    if (bytes > API_LIMITS.messageBytes) throw new ApiValidationError("This message is too long.", `messages[${index}].content`);
    total += bytes;
    if (message.role === "system") {
      if (seenNonSystem) throw new ApiValidationError("System messages must come first.", `messages[${index}].role`);
    } else {
      seenNonSystem = true;
    }
    if (message.role === "user") {
      seenUser = true;
      if (!nonWhitespace(message.content)) throw new ApiValidationError("A user message cannot be empty.", `messages[${index}].content`);
    }
    if (message.role === "system" && !nonWhitespace(message.content)) throw new ApiValidationError("A system message cannot be empty.", `messages[${index}].content`);
  }
  if (total > API_LIMITS.totalContentBytes) throw new ApiValidationError("The conversation is too large.", "messages");
  const last = body.messages.at(-1);
  if (!seenUser || last?.role !== "user") throw new ApiValidationError("The last message must be from the user.", "messages");

  if (body.stream_options !== undefined && body.stream !== true) {
    throw new ApiValidationError("stream_options requires stream: true.", "stream_options");
  }
  if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) {
    throw new ApiValidationError("temperature must be between 0 and 2.", "temperature");
  }
  for (const key of ["max_tokens", "max_completion_tokens"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0 || value > API_LIMITS.maxOutputTokens) {
      throw new ApiValidationError(`${key} must be a whole number between 1 and ${API_LIMITS.maxOutputTokens}.`, key);
    }
  }
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) {
    throw new ApiValidationError("Use max_tokens or max_completion_tokens, not both.", "max_completion_tokens");
  }
  return body as ValidatedChatRequest;
}

/** A provider-qualified ref with a nonempty side on each side of the first slash and no controls. */
export function validApiModel(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if ([...value].length > 300 || Buffer.byteLength(value, "utf8") > 1_200) return null;
  if (!validModelRef(value)) return null;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  if (/\s/.test(value)) return null;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return null;
  }
  return value;
}

/** Model refs keep their slashes; only the first one separates provider and model. */
export function splitModelRef(ref: string): { providerId: string; modelId: string } {
  const slash = ref.indexOf("/");
  return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}
