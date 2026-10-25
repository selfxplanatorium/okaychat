import { generateId } from "ai";
import type { McpElicitation, McpElicitationField } from "../../shared/types.js";

// MCP elicitation (form mode): a server asks the user for structured input in the middle of a tool call.
// The request waits here until the user answers in the chat, declines, stops the turn, or the wait expires.
// Only flat objects of primitive fields are allowed by the spec, which is all the form renders.

/** A form left open longer than this is cancelled, so a forgotten tab does not hold the call forever. */
const WAIT_MS = 10 * 60_000;

export type ElicitAction = "accept" | "decline" | "cancel";
export interface ElicitAnswer {
  action: ElicitAction;
  content?: Record<string, string | number | boolean | string[]>;
}

interface Pending {
  userId: string;
  fields: McpElicitationField[];
  resolve: (answer: ElicitAnswer) => void;
}

const pending = new Map<string, Pending>();

type JsonSchema = Record<string, unknown>;

/** Reads the requested schema into form fields. Unsupported property types make the request invalid. */
export function parseRequestedSchema(schema: unknown): McpElicitationField[] {
  const s = (schema ?? {}) as { properties?: Record<string, JsonSchema>; required?: unknown };
  const required = new Set(Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === "string") : []);
  return Object.entries(s.properties ?? {}).map(([name, p]): McpElicitationField => {
    const base = {
      name,
      title: typeof p.title === "string" ? p.title : undefined,
      description: typeof p.description === "string" ? p.description : undefined,
      required: required.has(name),
    };
    const options = enumOptions(p);
    if (p.type === "array") {
      const items = enumOptions((p.items ?? {}) as JsonSchema);
      if (!items) throw new Error(`Field "${name}": only multi-select lists of fixed options are supported.`);
      return { ...base, type: "multiselect", options: items, default: Array.isArray(p.default) ? p.default.filter((d): d is string => typeof d === "string") : undefined };
    }
    if (p.type === "string" && options) return { ...base, type: "select", options, default: typeof p.default === "string" ? p.default : undefined };
    if (p.type === "string") {
      return {
        ...base,
        type: "string",
        format: typeof p.format === "string" ? p.format : undefined,
        minLength: typeof p.minLength === "number" ? p.minLength : undefined,
        maxLength: typeof p.maxLength === "number" ? p.maxLength : undefined,
        default: typeof p.default === "string" ? p.default : undefined,
      };
    }
    if (p.type === "number" || p.type === "integer") {
      return {
        ...base,
        type: p.type,
        minimum: typeof p.minimum === "number" ? p.minimum : undefined,
        maximum: typeof p.maximum === "number" ? p.maximum : undefined,
        default: typeof p.default === "number" ? p.default : undefined,
      };
    }
    if (p.type === "boolean") return { ...base, type: "boolean", default: typeof p.default === "boolean" ? p.default : undefined };
    throw new Error(`Field "${name}" has an unsupported type.`);
  });
}

/** `enum` (+ legacy `enumNames`) or `oneOf`/`anyOf` of `{ const, title }`. */
function enumOptions(p: JsonSchema): Array<{ value: string; label: string }> | undefined {
  if (Array.isArray(p.enum)) {
    const names = Array.isArray(p.enumNames) ? p.enumNames : [];
    return p.enum.filter((v): v is string => typeof v === "string").map((value, i) => ({ value, label: typeof names[i] === "string" ? names[i] : value }));
  }
  const list = (Array.isArray(p.oneOf) ? p.oneOf : Array.isArray(p.anyOf) ? p.anyOf : null) as Array<{ const?: unknown; title?: unknown }> | null;
  if (!list) return undefined;
  return list.filter((o) => typeof o.const === "string").map((o) => ({ value: o.const as string, label: typeof o.title === "string" ? o.title : (o.const as string) }));
}

/**
 * Registers a request and returns what the chat shows plus a promise for the answer. Stopping the turn
 * cancels it. Invalid schemas are declined before anything is shown.
 */
export function openElicitation(userId: string, server: string, message: string, schema: unknown, signal?: AbortSignal): { view: McpElicitation; answer: Promise<ElicitAnswer> } | null {
  let fields: McpElicitationField[];
  try {
    fields = parseRequestedSchema(schema);
  } catch {
    return null;
  }
  const id = generateId();
  const answer = new Promise<ElicitAnswer>((resolve) => {
    const finish = (result: ElicitAnswer) => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ action: "cancel" });
    const timer = setTimeout(() => finish({ action: "cancel" }), WAIT_MS);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(id, { userId, fields, resolve: finish });
  });
  return { view: { id, server, message: message.slice(0, 2000), fields }, answer };
}

/** Validates the user's answer against the fields and resumes the waiting call. False when unknown or not theirs. */
export function answerElicitation(userId: string, id: string, answer: ElicitAnswer): boolean {
  const entry = pending.get(id);
  if (!entry || entry.userId !== userId) return false;
  if (answer.action !== "accept") {
    entry.resolve({ action: answer.action });
    return true;
  }
  entry.resolve({ action: "accept", content: validContent(entry.fields, answer.content ?? {}) });
  return true;
}

/** Keeps only declared fields, coerced and checked. Throws with a message the form shows. */
export function validContent(fields: McpElicitationField[], content: Record<string, unknown>): NonNullable<ElicitAnswer["content"]> {
  const out: NonNullable<ElicitAnswer["content"]> = {};
  for (const field of fields) {
    const value = content[field.name];
    const label = field.title ?? field.name;
    if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) {
      if (field.required) throw new Error(`${label} is required.`);
      continue;
    }
    switch (field.type) {
      case "string": {
        if (typeof value !== "string") throw new Error(`${label} must be text.`);
        if (field.minLength !== undefined && value.length < field.minLength) throw new Error(`${label} needs at least ${field.minLength} characters.`);
        if (value.length > (field.maxLength ?? 20_000)) throw new Error(`${label} is too long.`);
        out[field.name] = value;
        break;
      }
      case "number":
      case "integer": {
        const n = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(n) || (field.type === "integer" && !Number.isInteger(n))) throw new Error(`${label} must be a${field.type === "integer" ? " whole" : ""} number.`);
        if ((field.minimum !== undefined && n < field.minimum) || (field.maximum !== undefined && n > field.maximum)) throw new Error(`${label} is out of range.`);
        out[field.name] = n;
        break;
      }
      case "boolean":
        if (typeof value !== "boolean") throw new Error(`${label} must be yes or no.`);
        out[field.name] = value;
        break;
      case "select":
        if (typeof value !== "string" || !field.options.some((o) => o.value === value)) throw new Error(`Pick an option for ${label}.`);
        out[field.name] = value;
        break;
      case "multiselect":
        if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && field.options.some((o) => o.value === v))) throw new Error(`Pick options for ${label}.`);
        out[field.name] = value as string[];
        break;
    }
  }
  return out;
}
