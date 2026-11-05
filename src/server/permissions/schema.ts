import { z } from "zod";
import {
  FEATURE_KEYS,
  LIMIT_BOUNDS,
  LIMIT_KEYS,
  MAX_PROMPT_RULE_CHARS,
  validModelRef,
  type Change,
  type FeatureKey,
  type LimitKey,
  type PolicyDocument,
} from "../../shared/permissions.js";
import type { PromptKey } from "../../shared/types.js";
import { PROMPT_KEYS } from "../prompts.js";

// Strict wire and storage shapes for permission documents and admin changes. Nothing is coerced: unknown
// fields, string numbers, NaN, and duplicate JSON keys are rejected before a document reaches the store.

export class PolicyInputError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
  }
}

const finiteInt = z.number().int().refine(Number.isSafeInteger, "Must be a whole number");

const featuresShape = Object.fromEntries(FEATURE_KEYS.map((key) => [key, z.boolean().optional()])) as Record<FeatureKey, z.ZodOptional<z.ZodBoolean>>;
const limitsShape = Object.fromEntries(
  LIMIT_KEYS.map((key) => [key, finiteInt.min(LIMIT_BOUNDS[key].min).max(LIMIT_BOUNDS[key].max).nullable().optional()]),
) as Record<LimitKey, z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;

export const policyDocumentSchema = z.strictObject({
  version: z.literal(1),
  modelAllowed: z.boolean().optional(),
  features: z.strictObject(featuresShape).optional(),
  limits: z.strictObject(limitsShape).optional(),
});

export const modelRefSchema = z.string().refine(validModelRef, "Use a provider-qualified model id, such as provider/model.");
const subjectSchema = z.strictObject({ kind: z.enum(["everyone", "group", "user"]), id: z.string().max(200) })
  .refine((subject) => (subject.kind === "everyone" ? subject.id === "" : subject.id.length > 0), "Choose a subject.");
const promptKeySchema = z.string().refine((key): key is PromptKey => (PROMPT_KEYS as string[]).includes(key), "Unknown prompt");
export const promptRuleSchema = z.strictObject({
  mode: z.enum(["replace", "append"]),
  text: z.string().max(MAX_PROMPT_RULE_CHARS),
}).refine((rule) => rule.mode === "replace" || rule.text.trim().length > 0, "An appended instruction needs text.")
  // CRLF from pasted text becomes LF; every other byte is kept as written.
  .transform((rule) => ({ mode: rule.mode, text: rule.text.replace(/\r\n/g, "\n") }));

const ids = z.array(z.string().min(1).max(200)).max(10_000);
const audienceSchema = z.strictObject({ mode: z.enum(["all", "selected"]), userIds: ids, groupIds: ids });

export const changeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("policy"), subject: subjectSchema, modelRef: modelRefSchema.nullable(), document: policyDocumentSchema.nullable() }),
  z.strictObject({ kind: z.literal("prompt"), subject: subjectSchema, modelRef: modelRefSchema.nullable(), key: promptKeySchema, rule: promptRuleSchema.nullable() }),
  z.strictObject({ kind: z.literal("serverPrompt"), key: promptKeySchema, value: z.string().max(MAX_PROMPT_RULE_CHARS).nullable() }),
  z.strictObject({ kind: z.literal("providerAudience"), providerId: z.string().min(1).max(200), audience: audienceSchema }),
  z.strictObject({
    kind: z.literal("providerEntitlements"),
    providerId: z.string().min(1).max(200),
    policies: z.array(z.strictObject({ target: subjectSchema, mode: z.enum(["all", "selected"]), modelIds: z.array(z.string().min(1).max(300)).max(5000) })).max(2000),
  }),
  z.strictObject({ kind: z.literal("mcpAudience"), serverId: z.string().min(1).max(200), audience: audienceSchema }),
  z.strictObject({ kind: z.literal("groupOrder"), groupIds: z.array(z.string().min(1).max(200)).max(10_000) }),
  z.strictObject({ kind: z.literal("membership"), groupId: z.string().min(1).max(200), userIds: ids }),
]);

export const MAX_CHANGES = 500;
export const changesSchema = z.array(changeSchema).min(1).max(MAX_CHANGES);

/** The destination a change writes; two changes with the same destination are rejected. */
export function changeDestination(change: Change): string {
  const subject = "subject" in change ? `${change.subject.kind}:${change.subject.id}` : "";
  switch (change.kind) {
    case "policy": return `policy|${subject}|${change.modelRef ?? ""}`;
    case "prompt": return `prompt|${subject}|${change.modelRef ?? ""}|${change.key}`;
    case "serverPrompt": return `serverPrompt|${change.key}`;
    case "providerAudience": return `providerAudience|${change.providerId}`;
    case "providerEntitlements": return `providerEntitlements|${change.providerId}`;
    case "mcpAudience": return `mcpAudience|${change.serverId}`;
    case "groupOrder": return "groupOrder";
    case "membership": return `membership|${change.groupId}`;
  }
}

/**
 * Parses JSON and rejects duplicate object keys, which JSON.parse silently resolves to the last value.
 * Bounded by the input length; strings and escapes follow RFC 8259.
 */
export function parseStrictJson(text: string, maxDepth = 64): unknown {
  let index = 0;
  const fail = (message: string): never => {
    throw new PolicyInputError(`${message} at position ${index}`);
  };
  const ws = () => {
    while (index < text.length && " \t\n\r".includes(text[index]!)) index++;
  };
  const parseString = (): string => {
    const start = index;
    index++;
    while (index < text.length) {
      const char = text[index]!;
      if (char === "\\") index += 2;
      else if (char === '"') {
        index++;
        return JSON.parse(text.slice(start, index)) as string;
      } else if (char < " ") fail("Control character in string");
      else index++;
    }
    return fail("Unterminated string");
  };
  const parseValue = (depth: number): unknown => {
    if (depth > maxDepth) fail("Nested too deeply");
    ws();
    const char = text[index];
    if (char === "{") {
      index++;
      const out: Record<string, unknown> = {};
      const seen = new Set<string>();
      ws();
      if (text[index] === "}") {
        index++;
        return out;
      }
      for (;;) {
        ws();
        if (text[index] !== '"') fail("Expected a key");
        const key = parseString();
        if (seen.has(key)) fail(`Duplicate key ${JSON.stringify(key)}`);
        seen.add(key);
        ws();
        if (text[index] !== ":") fail("Expected ':'");
        index++;
        Object.defineProperty(out, key, { value: parseValue(depth + 1), enumerable: true, writable: true, configurable: true });
        ws();
        if (text[index] === ",") {
          index++;
          continue;
        }
        if (text[index] === "}") {
          index++;
          return out;
        }
        fail("Expected ',' or '}'");
      }
    }
    if (char === "[") {
      index++;
      const out: unknown[] = [];
      ws();
      if (text[index] === "]") {
        index++;
        return out;
      }
      for (;;) {
        out.push(parseValue(depth + 1));
        ws();
        if (text[index] === ",") {
          index++;
          continue;
        }
        if (text[index] === "]") {
          index++;
          return out;
        }
        fail("Expected ',' or ']'");
      }
    }
    if (char === '"') return parseString();
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index, index + 400));
    if (!literal) return fail("Unexpected token");
    index += literal[0].length;
    return JSON.parse(literal[0]);
  };
  const value = parseValue(0);
  ws();
  if (index !== text.length) fail("Trailing content");
  return value;
}

/** A stored document; malformed or unknown versions throw so the resolver can fail closed. */
export function parseStoredDocument(raw: string): PolicyDocument {
  const parsed = policyDocumentSchema.safeParse(parseStrictJson(raw));
  if (!parsed.success) throw new PolicyInputError("Stored policy is invalid");
  return parsed.data as PolicyDocument;
}

/** Reads a request body as strict JSON within a byte limit. */
export async function readStrictBody(request: Request, maxBytes: number): Promise<unknown> {
  const text = await request.text();
  if (Buffer.byteLength(text) > maxBytes) throw new PolicyInputError("Request body is too large", "body");
  return parseStrictJson(text);
}
