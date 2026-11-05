import { isIP } from "node:net";
import { AppError } from "../errors.js";
import { publicAddress } from "../public-fetch.js";
import {
  PRODUCTION_EVENT_TYPES,
  WEBHOOK_LIMITS,
  type ProductionEventType,
  type TextProjection,
} from "../../shared/outgoing-webhooks.js";

/**
 * Strict runtime validation for everything that reaches a destination or the outbox. URLs and header
 * values are credentials: rejection messages never echo them, and no value here is ever logged.
 */

export function validationError(message: string): AppError {
  return new AppError({ code: "validation", message });
}

export function trimmedName(value: unknown): string {
  if (typeof value !== "string") throw validationError("Enter a name for this endpoint.");
  const name = value.trim();
  if (!name || name.length > WEBHOOK_LIMITS.nameChars) throw validationError(`Use a name of 1–${WEBHOOK_LIMITS.nameChars} characters.`);
  // Controls would corrupt logs and confuse screen readers; they are never meaningful in a label.
  if (/[\u0000-\u001f\u007f]/.test(name)) throw validationError("The name contains control characters.");
  return name;
}

const RESERVED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/** A hostname that is obviously local/reserved. DNS need not resolve: saving performs no network call. */
function reservedHostname(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (!name) return true;
  if (name === "localhost" || RESERVED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  const bare = name.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return !publicAddress(bare);
  // A single-label name resolves through local search domains on some hosts; refuse it.
  return !name.includes(".");
}

/** Validates a saved destination. HTTPS on port 443 only, no credentials or fragment, public host. */
export function validateEndpointUrl(value: unknown): string {
  if (typeof value !== "string") throw validationError("Enter an HTTPS URL.");
  // JavaScript trims tab/newline before parsing; an embedded control is ambiguous, not a URL.
  if (/[\u0000-\u001f\u007f]/.test(value)) throw validationError("The URL contains control characters.");
  if (Buffer.byteLength(value, "utf8") > WEBHOOK_LIMITS.urlBytes) throw validationError(`Keep the URL under ${WEBHOOK_LIMITS.urlBytes} bytes.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw validationError("Enter a complete HTTPS URL.");
  }
  if (url.protocol !== "https:") throw validationError("Webhook destinations must use HTTPS.");
  if (url.port && url.port !== "443") throw validationError("Webhook destinations must use port 443.");
  if (url.username || url.password) throw validationError("Put credentials in headers, not in the URL.");
  if (url.hash) throw validationError("A webhook URL cannot contain a fragment.");
  if (reservedHostname(url.hostname)) throw validationError("That host is local or reserved. Use a public HTTPS address.");
  // Keep the owner's exact path/query bytes; URL parsing is only validation. Credentials may be in them.
  return value.trim();
}

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FORBIDDEN_HEADERS = new Set([
  "host", "connection", "content-length", "transfer-encoding", "content-type", "accept", "accept-encoding",
  "cookie", "set-cookie", "origin", "referer", "user-agent", "expect", "trailer", "te", "upgrade",
  "forwarded", "idempotency-key",
]);
const FORBIDDEN_PREFIXES = ["proxy-", "sec-", "x-forwarded-", "x-okaychat-"];

export function headerName(value: string): string {
  const name = value.trim();
  if (!HEADER_NAME.test(name) || name.length < 1 || name.length > WEBHOOK_LIMITS.headerNameChars) {
    throw validationError("Header names must be short ASCII tokens.");
  }
  const lower = name.toLowerCase();
  if (FORBIDDEN_HEADERS.has(lower) || FORBIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    throw validationError(`The ${name} header is managed by the server and cannot be set.`);
  }
  return name;
}

/** Values are opaque secrets: controls (especially CR/LF/NUL) would split the request. */
export function headerValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw validationError("A header value cannot be empty.");
  if (Buffer.byteLength(value, "utf8") > WEBHOOK_LIMITS.headerValueBytes) {
    throw validationError(`Keep each header value under ${WEBHOOK_LIMITS.headerValueBytes} bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) throw validationError("A header value contains control characters.");
  return value;
}

/** Case-insensitive distinct names, bounded count and combined bytes. Returned sorted by name. */
export function validateHeaders(input: unknown): Array<[string, string]> {
  if (input === undefined) return [];
  if (!input || typeof input !== "object" || Array.isArray(input)) throw validationError("Headers must be an object.");
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > WEBHOOK_LIMITS.headerCount) throw validationError(`Use at most ${WEBHOOK_LIMITS.headerCount} headers.`);
  const seen = new Set<string>();
  let total = 0;
  const out: Array<[string, string]> = [];
  for (const [rawName, rawValue] of entries) {
    const name = headerName(rawName);
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw validationError("Two headers use the same name.");
    seen.add(lower);
    const value = headerValue(rawValue);
    total += Buffer.byteLength(name) + Buffer.byteLength(value);
    out.push([name, value]);
  }
  if (total > WEBHOOK_LIMITS.headerTotalBytes) throw validationError("The headers are too large.");
  return out.sort(([a], [b]) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
}

export function validateSubscriptions(input: unknown): ProductionEventType[] {
  if (!Array.isArray(input)) throw validationError("Subscriptions must be an array.");
  const set = new Set<ProductionEventType>();
  for (const value of input) {
    if (typeof value !== "string" || !(PRODUCTION_EVENT_TYPES as readonly string[]).includes(value)) {
      throw validationError("That event type cannot be subscribed to.");
    }
    set.add(value as ProductionEventType);
  }
  return [...set].sort();
}

export function validateChannelIds(input: unknown): string[] {
  if (!Array.isArray(input)) throw validationError("Channel selection must be an array.");
  const set = new Set<string>();
  for (const value of input) {
    if (typeof value !== "string" || !value || value.length > 200) throw validationError("A selected room is invalid.");
    set.add(value);
  }
  if (set.size > WEBHOOK_LIMITS.channelIds) throw validationError(`Select at most ${WEBHOOK_LIMITS.channelIds} rooms.`);
  return [...set].sort();
}

/** Applies `headerChanges` to stored values. `null` removes; a string updates or adds. */
export function applyHeaderChanges(stored: Array<[string, string]>, input: unknown): Array<[string, string]> {
  if (input === undefined) return stored;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw validationError("Header changes must be an object.");
  const map = new Map(stored.map(([name, value]) => [name.toLowerCase(), [name, value] as [string, string]]));
  const seen = new Set<string>();
  for (const [rawName, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const name = headerName(rawName);
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw validationError("Two headers use the same name.");
    seen.add(lower);
    if (rawValue === null) {
      if (!map.has(lower)) throw validationError(`The ${name} header is not saved.`);
      map.delete(lower);
      continue;
    }
    map.set(lower, [name, headerValue(rawValue)]);
  }
  if (map.size > WEBHOOK_LIMITS.headerCount) throw validationError(`Use at most ${WEBHOOK_LIMITS.headerCount} headers.`);
  let total = 0;
  for (const [name, value] of map.values()) total += Buffer.byteLength(name) + Buffer.byteLength(value);
  if (total > WEBHOOK_LIMITS.headerTotalBytes) throw validationError("The headers are too large.");
  return [...map.values()].sort(([a], [b]) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
}

/** Bounds a visible-answer projection to 8 KiB of UTF-8 without splitting a code point. */
export function textProjection(text: string | undefined, include: boolean): TextProjection | undefined {
  if (!include) return undefined;
  const source = text ?? "";
  if (Buffer.byteLength(source, "utf8") <= WEBHOOK_LIMITS.textBytes) return { value: source, truncated: false };
  let bytes = 0;
  let value = "";
  for (const codePoint of source) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > WEBHOOK_LIMITS.textBytes) break;
    bytes += size;
    value += codePoint;
  }
  return { value, truncated: true };
}

/** Visible text of a stored/model message: text parts joined with a newline, never reasoning or tools. */
export function answerText(parts: ReadonlyArray<{ type?: unknown; text?: unknown }> | undefined): string {
  if (!parts) return "";
  const pieces = parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string);
  return pieces.join("\n");
}

export function textBytes(value: string | null | undefined): number {
  return value ? Buffer.byteLength(value, "utf8") : 0;
}

/** A bounded, private cursor: createdAt + id. Parsing is strict so a forged value cannot widen a scan. */
export function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(`${createdAt}:${id}`, "utf8").toString("base64url");
}

export function decodeCursor(value: string | undefined): { createdAt: number; id: string } | null {
  if (!value) return null;
  if (value.length > 300) throw validationError("Invalid cursor.");
  const text = Buffer.from(value, "base64url").toString("utf8");
  const match = /^(\d{1,15}):([A-Za-z0-9_-]{1,200})$/.exec(text);
  if (!match) throw validationError("Invalid cursor.");
  const createdAt = Number(match[1]);
  if (!Number.isSafeInteger(createdAt)) throw validationError("Invalid cursor.");
  return { createdAt, id: match[2]! };
}
