import type { InjectionReport } from "./types.js";

// Private account tools: a Python function run in the sandbox, or a fixed-destination HTTPS request that
// needs explicit approval. Everything here is pure and shared by the server (authoritative validation),
// the workspace editor, and tests. There is no expression language, no remote schema and no generated code.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type CustomToolKind = "python" | "http";
export const CUSTOM_TOOL_ICONS = ["wrench", "code", "globe", "calculator", "database", "file-json"] as const;
export type CustomToolIcon = (typeof CUSTOM_TOOL_ICONS)[number];
export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof HTTP_METHODS)[number];

export interface StringFieldSchema {
  type: "string";
  description?: string;
  enum?: string[];
  maxLength?: number;
}
export interface NumberFieldSchema {
  type: "number" | "integer";
  description?: string;
  minimum?: number;
  maximum?: number;
}
export interface BooleanFieldSchema {
  type: "boolean";
  description?: string;
}
export interface ArrayFieldSchema {
  type: "array";
  description?: string;
  items: FieldSchema;
  maxItems: number;
}
export interface ObjectFieldSchema {
  type: "object";
  description?: string;
  properties: Record<string, FieldSchema>;
  required: string[];
  additionalProperties: false;
}
export type FieldSchema = StringFieldSchema | NumberFieldSchema | BooleanFieldSchema | ArrayFieldSchema | ObjectFieldSchema;
export type InputSchema = ObjectFieldSchema;
export type ScalarSchema = StringFieldSchema | NumberFieldSchema | BooleanFieldSchema;

export type Binding = { literal: Json } | { input: string };
export type JsonTemplate = { value: Binding } | { object: Record<string, JsonTemplate> } | { array: JsonTemplate[] };
export type Header = { name: string } & ({ value: string } | { secret: string });
export type PythonConfig = { kind: "python"; code: string; timeoutMs: number };
export interface HttpQuery {
  name: string;
  value: Binding;
}
export interface HttpConfig {
  kind: "http";
  origin: string;
  path: string;
  method: Method;
  query: HttpQuery[];
  headers: Header[];
  body: JsonTemplate | null;
  response: "json" | "text";
  timeoutMs: number;
}
export type ToolConfig = PythonConfig | HttpConfig;

export interface ToolWrite {
  name: string;
  description: string;
  icon: CustomToolIcon;
  enabled: boolean;
  inputSchema: InputSchema;
  config: ToolConfig;
}
export interface SecretPatch {
  set: Record<string, string>;
  remove: string[];
}

export interface ToolSummary {
  id: string;
  toolKey: string;
  kind: CustomToolKind;
  name: string;
  description: string;
  icon: CustomToolIcon;
  enabled: boolean;
  invalid: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
  secretNames: string[];
  lastRun: RunView | null;
  counters: { attempts: number; succeeded: number; failed: number; cancelled: number; unknown: number };
}
export interface ToolDetail extends ToolSummary {
  inputSchema: InputSchema;
  config: ToolConfig;
}
export const RUN_STATES = ["prepared", "running", "succeeded", "failed", "cancelled", "unknown", "denied", "expired"] as const;
export type RunState = (typeof RUN_STATES)[number];
export const RUN_ERROR_CODES = [
  "invalid_input", "definition_changed", "disabled", "permission_denied", "approval_required",
  "approval_expired", "approval_denied", "blocked_destination", "redirect_blocked", "rate_limited",
  "service_unavailable", "timeout", "cancelled", "response_too_large", "invalid_json", "invalid_result",
  "python_error", "http_status", "network_error", "outcome_unknown",
] as const;
export type RunErrorCode = (typeof RUN_ERROR_CODES)[number];
export interface RunError {
  code: RunErrorCode;
  message: string;
}
export interface RunView {
  id: string;
  toolId: string;
  revision: number;
  source: "chat" | "test";
  state: RunState;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  dispatched: boolean;
  inputBytes: number;
  outputBytes: number;
  httpStatus: number | null;
  result: Json | null;
  resultRetained: boolean;
  error: RunError | null;
}
export const RUN_WARNING = ["outbound", "outbound_destructive"] as const;
export interface ReviewHeader {
  name: string;
  value: string | null;
  secretName: string | null;
}
export interface TestReview {
  runId: string;
  toolId: string;
  revision: number;
  expiresAt: number;
  token: string;
  method: Method;
  url: string;
  headers: ReviewHeader[];
  body: string | null;
  warning: "outbound" | "outbound_destructive";
}
export type ChatReview = Omit<TestReview, "token">;
export interface ToolResult {
  toolId: string;
  name: string;
  revision: number;
  runId: string;
  ok: boolean;
  value: Json | null;
  error: RunError | null;
  durationMs: number;
  httpStatus: number | null;
  injection?: InjectionReport;
}
export interface CleanupItem {
  id: string;
  name: string;
  revision: number;
}

// ---------------------------------------------------------------------------
// Limits and identifiers

export const CUSTOM_LIMITS = {
  nameChars: 80,
  nameBytes: 320,
  descriptionBytes: 2_000,
  codeBytes: 64 * 1024,
  schemaBytes: 16 * 1024,
  schemaNodes: 128,
  schemaDepth: 6,
  objectProperties: 32,
  totalProperties: 64,
  enumValues: 50,
  enumValueBytes: 256,
  maxLengthMax: 8_192,
  maxItemsMax: 100,
  inputBytes: 16 * 1024,
  outputBytes: 32 * 1024,
  templateBytes: 16 * 1024,
  templateNodes: 256,
  templateDepth: 6,
  queryItems: 32,
  headers: 16,
  headerNameBytes: 64,
  headerValueBytes: 2_048,
  requestHeadersBytes: 8 * 1024,
  bodyBytes: 32 * 1024,
  pathBytes: 1_024,
  urlBytes: 4_096,
  secrets: 8,
  secretValueBytes: 2_048,
  secretsBytes: 8 * 1024,
  pythonTimeoutMin: 1_000,
  pythonTimeoutMax: 30_000,
  httpTimeoutMin: 1_000,
  httpTimeoutMax: 20_000,
  definitions: 50,
  enabledDefinitions: 20,
  customKeys: 24,
  revisionMax: 2_147_483_647,
  attemptsPerReply: 10,
  attemptsPerMinute: 30,
  preparedRuns: 10,
  visibleRuns: 20,
  tombstones: 100,
  resultReservation: 128 * 1024,
  approvalTtlMs: 10 * 60_000,
  runTtlMs: 7 * 24 * 60 * 60_000,
  dedupeTtlMs: 24 * 60 * 60_000,
} as const;

export const PYTHON_SAMPLE = `def main(input):
    values = input.get("values", [])
    return {"total": sum(values)}
`;

export const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);
const TOOL_KEY_RE = /^custom_[a-f0-9]{24}_r(\d{1,10})$/;

export function baseKeyFor(id: string, digest: string): string {
  return `custom_${digest.slice(0, CUSTOM_LIMITS.customKeys)}`;
}
export function toolKeyFor(baseKey: string, revision: number): string {
  return `${baseKey}_r${revision}`;
}
export function parseToolKey(key: string): { revision: number } | null {
  const match = TOOL_KEY_RE.exec(key);
  if (!match) return null;
  const revision = Number(match[1]);
  return revision >= 1 && revision <= CUSTOM_LIMITS.revisionMax ? { revision } : null;
}
export const isCustomToolKey = (key: string): boolean => TOOL_KEY_RE.test(key);

export function utf8Bytes(value: string): number {
  return BufferLike.byteLength(value);
}
/** Byte length that works in both Node and the browser without importing node:buffer. */
const BufferLike = {
  byteLength(value: string): number {
    let bytes = 0;
    for (const ch of value) {
      const code = ch.codePointAt(0)!;
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    }
    return bytes;
  },
};
export const codePoints = (value: string): number => [...value].length;

// ---------------------------------------------------------------------------
// Validation reasons and results

export type ValidationReason =
  | "invalid_json" | "duplicate_key" | "reserved_key" | "unsupported_keyword" | "wrong_type"
  | "required" | "unknown_property" | "too_large" | "too_deep" | "too_many_nodes"
  | "out_of_range" | "invalid_reference" | "invalid_destination" | "invalid_header"
  | "invalid_schema";

export interface ValidationIssue {
  /** JSON pointer into the submitted value, e.g. `/values/0`. Never contains a submitted value. */
  path: string;
  reason: ValidationReason;
}
export interface ValidationOk<T> {
  ok: true;
  value: T;
}
export interface ValidationError {
  ok: false;
  issues: ValidationIssue[];
}
export type ValidationResult<T> = ValidationOk<T> | ValidationError;

const MAX_ISSUES = 20;

class Issues {
  readonly list: ValidationIssue[] = [];
  add(path: string, reason: ValidationReason): false {
    if (this.list.length < MAX_ISSUES) this.list.push({ path, reason });
    return false;
  }
  get full(): boolean {
    return this.list.length >= MAX_ISSUES;
  }
}

const pointer = (base: string, key: string) => `${base}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
const failure = (issues: Issues): ValidationError => ({ ok: false, issues: issues.list });

// ---------------------------------------------------------------------------
// Bounded strict JSON parser

export interface JsonLimits {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
}

export const INPUT_JSON_LIMITS: JsonLimits = {
  maxBytes: CUSTOM_LIMITS.inputBytes,
  maxDepth: 16,
  maxNodes: 4_096,
};
export const OUTPUT_JSON_LIMITS: JsonLimits = {
  maxBytes: CUSTOM_LIMITS.outputBytes,
  maxDepth: 16,
  maxNodes: 4_096,
};

class JsonReader {
  private index = 0;
  private nodes = 0;
  /** Objects use a null prototype, so a submitted `__proto__` key can never mutate one. */
  private readonly keysSeen: Array<Set<string>> = [];

  constructor(private readonly text: string) {}

  parse(limits: JsonLimits): ValidationResult<Json> {
    if (utf8Bytes(this.text) > limits.maxBytes) return { ok: false, issues: [{ path: "", reason: "too_large" }] };
    try {
      const value = this.parseValue(0, limits, "");
      this.skipSpace();
      if (this.index !== this.text.length) throw new ParseIssue("invalid_json", "");
      return { ok: true, value };
    } catch (error) {
      if (error instanceof ParseIssue) return { ok: false, issues: [{ path: error.path, reason: error.reason }] };
      return { ok: false, issues: [{ path: "", reason: "invalid_json" }] };
    }
  }

  private parseValue(depth: number, limits: JsonLimits, path: string): Json {
    if (depth > limits.maxDepth) throw new ParseIssue("too_deep", path);
    if (++this.nodes > limits.maxNodes) throw new ParseIssue("too_many_nodes", path);
    this.skipSpace();
    const char = this.text[this.index];
    if (char === "{") return this.parseObject(depth, limits, path);
    if (char === "[") return this.parseArray(depth, limits, path);
    if (char === '"') return this.parseString();
    if (char === "t" && this.text.startsWith("true", this.index)) { this.index += 4; return true; }
    if (char === "f" && this.text.startsWith("false", this.index)) { this.index += 5; return false; }
    if (char === "n" && this.text.startsWith("null", this.index)) { this.index += 4; return null; }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.index));
    if (!match) throw new ParseIssue("invalid_json", path);
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new ParseIssue("out_of_range", path);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new ParseIssue("out_of_range", path);
    return value;
  }

  private parseObject(depth: number, limits: JsonLimits, path: string): Json {
    this.index++;
    this.keysSeen.push(new Set());
    const result: { [key: string]: Json } = Object.create(null) as { [key: string]: Json };
    this.skipSpace();
    if (this.text[this.index] === "}") { this.index++; this.keysSeen.pop(); return result; }
    for (;;) {
      this.skipSpace();
      if (this.text[this.index] !== '"') throw new ParseIssue("invalid_json", path);
      const key = this.parseString();
      if (RESERVED_KEYS.has(key)) throw new ParseIssue("reserved_key", pointer(path, key));
      const seen = this.keysSeen.at(-1)!;
      if (seen.has(key)) throw new ParseIssue("duplicate_key", pointer(path, key));
      seen.add(key);
      this.skipSpace();
      if (this.text[this.index] !== ":") throw new ParseIssue("invalid_json", pointer(path, key));
      this.index++;
      result[key] = this.parseValue(depth + 1, limits, pointer(path, key));
      this.skipSpace();
      if (this.text[this.index] === ",") { this.index++; continue; }
      if (this.text[this.index] === "}") { this.index++; break; }
      throw new ParseIssue("invalid_json", path);
    }
    this.keysSeen.pop();
    return result;
  }

  private parseArray(depth: number, limits: JsonLimits, path: string): Json {
    this.index++;
    const result: Json[] = [];
    this.skipSpace();
    if (this.text[this.index] === "]") { this.index++; return result; }
    for (;;) {
      this.skipSpace();
      result.push(this.parseValue(depth + 1, limits, `${path}/${result.length}`));
      this.skipSpace();
      if (this.text[this.index] === ",") { this.index++; continue; }
      if (this.text[this.index] === "]") { this.index++; break; }
      throw new ParseIssue("invalid_json", path);
    }
    return result;
  }

  private parseString(): string {
    this.index++;
    let out = "";
    for (;;) {
      const char = this.text[this.index];
      if (char === undefined) throw new ParseIssue("invalid_json", "");
      this.index++;
      if (char === '"') return out;
      if (char === "\\") {
        const escape = this.text[this.index++];
        switch (escape) {
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "/": out += "/"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "n": out += "\n"; break;
          case "r": out += "\r"; break;
          case "t": out += "\t"; break;
          case "u": {
            const hex = this.text.slice(this.index, this.index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ParseIssue("invalid_json", "");
            out += String.fromCharCode(parseInt(hex, 16));
            this.index += 4;
            break;
          }
          default: throw new ParseIssue("invalid_json", "");
        }
        continue;
      }
      if (char.charCodeAt(0) < 0x20) throw new ParseIssue("invalid_json", "");
      out += char;
    }
  }

  private skipSpace(): void {
    while (/\s/.test(this.text[this.index] ?? "")) this.index++;
  }
}

class ParseIssue {
  constructor(readonly reason: ValidationReason, readonly path: string) {}
}

export function parseToolJson(text: string, limits: JsonLimits): ValidationResult<Json> {
  return new JsonReader(text).parse(limits);
}

/** A JSON value that the editor submitted directly (not parsed text) still has to pass the same rules. */
export function validateJsonValue(value: unknown, limits: JsonLimits): ValidationResult<Json> {
  let handled = true;
  const issues = new Issues();
  let nodes = 0;
  const walk = (item: unknown, depth: number, path: string): item is Json => {
    if (depth > limits.maxDepth) { issues.add(path, "too_deep"); return false; }
    if (++nodes > limits.maxNodes) { issues.add(path, "too_many_nodes"); return false; }
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) {
        issues.add(path, "out_of_range");
        return false;
      }
      return true;
    }
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) walk(item[i], depth + 1, `${path}/${i}`);
      return true;
    }
    if (typeof item !== "object") { issues.add(path, "wrong_type"); return false; }
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (RESERVED_KEYS.has(key)) { issues.add(pointer(path, key), "reserved_key"); handled = false; continue; }
      walk(child, depth + 1, pointer(path, key));
    }
    return true;
  };
  walk(value, 0, "");
  if (issues.list.length) return failure(issues);
  if (utf8Bytes(JSON.stringify(value)) > limits.maxBytes) return { ok: false, issues: [{ path: "", reason: "too_large" }] };
  return { ok: true, value: value as Json };
}

/** Deterministic canonical JSON: object keys sorted at every level. */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** Root object check shared by the schema parser and the executor. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const isScalarSchema = (schema: FieldSchema): schema is ScalarSchema =>
  schema.type === "string" || schema.type === "number" || schema.type === "integer" || schema.type === "boolean";

// ---------------------------------------------------------------------------
// Schema subset validation

const PROPERTY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SCHEMA_ALLOWED = new Set(["type", "description", "enum", "maxLength", "minimum", "maximum", "items", "maxItems", "properties", "required", "additionalProperties"]);

function checkDescription(value: unknown, path: string, issues: Issues): void {
  if (value === undefined) return;
  if (typeof value !== "string") { issues.add(path, "invalid_schema"); return; }
  if (utf8Bytes(value) > 512) issues.add(path, "too_large");
}

function checkNumber(value: unknown, path: string, issues: Issues): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) { issues.add(path, "invalid_schema"); return undefined; }
  return value;
}

function validateFieldSchema(raw: unknown, path: string, depth: number, state: { nodes: number; properties: number }, issues: Issues): FieldSchema | undefined {
  if (depth > CUSTOM_LIMITS.schemaDepth) { issues.add(path, "too_deep"); return undefined; }
  if (++state.nodes > CUSTOM_LIMITS.schemaNodes) { issues.add(path, "too_many_nodes"); return undefined; }
  if (!isPlainObject(raw)) { issues.add(path, "invalid_schema"); return undefined; }
  for (const key of Object.keys(raw)) {
    if (!SCHEMA_ALLOWED.has(key)) issues.add(path, "unsupported_keyword");
  }
  checkDescription(raw.description, pointer(path, "description"), issues);
  const type = raw.type;
  if (type === "string") {
    const out: StringFieldSchema = { type: "string" };
    if (raw.description !== undefined) out.description = raw.description as string;
    if (raw.maxLength !== undefined) {
      if (typeof raw.maxLength !== "number" || !Number.isInteger(raw.maxLength) || raw.maxLength < 1 || raw.maxLength > CUSTOM_LIMITS.maxLengthMax) {
        issues.add(pointer(path, "maxLength"), "out_of_range");
      } else out.maxLength = raw.maxLength;
    }
    if (raw.enum !== undefined) {
      if (!Array.isArray(raw.enum) || raw.enum.length < 1 || raw.enum.length > CUSTOM_LIMITS.enumValues) {
        issues.add(pointer(path, "enum"), "invalid_schema");
      } else {
        const values: string[] = [];
        for (let i = 0; i < raw.enum.length; i++) {
          const item = raw.enum[i];
          if (typeof item !== "string" || utf8Bytes(item) > CUSTOM_LIMITS.enumValueBytes) {
            issues.add(`${pointer(path, "enum")}/${i}`, "invalid_schema");
            continue;
          }
          if (values.includes(item)) { issues.add(`${pointer(path, "enum")}/${i}`, "invalid_schema"); continue; }
          values.push(item);
        }
        if (values.length) out.enum = values;
      }
    }
    return out;
  }
  if (type === "number" || type === "integer") {
    const out: NumberFieldSchema = { type };
    if (raw.description !== undefined) out.description = raw.description as string;
    const minimum = checkNumber(raw.minimum, pointer(path, "minimum"), issues);
    const maximum = checkNumber(raw.maximum, pointer(path, "maximum"), issues);
    if (minimum !== undefined) out.minimum = minimum;
    if (maximum !== undefined) out.maximum = maximum;
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) issues.add(path, "invalid_schema");
    return out;
  }
  if (type === "boolean") {
    return { type: "boolean", ...(raw.description !== undefined ? { description: raw.description as string } : {}) };
  }
  if (type === "array") {
    if (!isPlainObject(raw.items)) { issues.add(pointer(path, "items"), "invalid_schema"); return undefined; }
    if (typeof raw.maxItems !== "number" || !Number.isInteger(raw.maxItems) || raw.maxItems < 1 || raw.maxItems > CUSTOM_LIMITS.maxItemsMax) {
      issues.add(pointer(path, "maxItems"), "out_of_range");
      return undefined;
    }
    const items = validateFieldSchema(raw.items, pointer(path, "items"), depth + 1, state, issues);
    if (!items) return undefined;
    return { type: "array", ...(raw.description !== undefined ? { description: raw.description as string } : {}), items, maxItems: raw.maxItems };
  }
  if (type === "object") {
    if (!isPlainObject(raw.properties)) { issues.add(pointer(path, "properties"), "invalid_schema"); return undefined; }
    if (raw.additionalProperties !== false) { issues.add(pointer(path, "additionalProperties"), "invalid_schema"); return undefined; }
    const properties: Record<string, FieldSchema> = Object.create(null) as Record<string, FieldSchema>;
    const propertyNames = Object.keys(raw.properties);
    if (propertyNames.length > CUSTOM_LIMITS.objectProperties) issues.add(pointer(path, "properties"), "too_large");
    for (const name of propertyNames) {
      if (!PROPERTY_RE.test(name) || RESERVED_KEYS.has(name)) { issues.add(pointer(pointer(path, "properties"), name), "invalid_schema"); continue; }
      if (++state.properties > CUSTOM_LIMITS.totalProperties) { issues.add(path, "too_large"); continue; }
      const child = validateFieldSchema(raw.properties[name], pointer(pointer(path, "properties"), name), depth + 1, state, issues);
      if (child) properties[name] = child;
    }
    const requiredRaw = raw.required ?? [];
    if (!Array.isArray(requiredRaw)) { issues.add(pointer(path, "required"), "invalid_schema"); return undefined; }
    const required: string[] = [];
    for (const name of requiredRaw) {
      if (typeof name !== "string" || !Object.hasOwn(properties, name)) { issues.add(pointer(path, "required"), "invalid_schema"); continue; }
      if (required.includes(name)) { issues.add(pointer(path, "required"), "invalid_schema"); continue; }
      required.push(name);
    }
    return {
      type: "object",
      ...(raw.description !== undefined ? { description: raw.description as string } : {}),
      properties,
      required,
      additionalProperties: false,
    };
  }
  issues.add(pointer(path, "type"), "invalid_schema");
  return undefined;
}

export function validateInputSchema(raw: unknown): ValidationResult<InputSchema> {
  const issues = new Issues();
  const state = { nodes: 0, properties: 0 };
  const schema = validateFieldSchema(raw, "", 0, state, issues);
  if (issues.list.length) return failure(issues);
  if (!schema || schema.type !== "object") {
    issues.add(pointer("", "type"), "invalid_schema");
    return failure(issues);
  }
  if (utf8Bytes(JSON.stringify(schema)) > CUSTOM_LIMITS.schemaBytes) {
    issues.add("", "too_large");
    return failure(issues);
  }
  return { ok: true, value: schema };
}

/** Runtime validation of a (already strict-parsed) input object against the stored subset. */
export function validateInput(schema: InputSchema, input: Json): ValidationResult<Json> {
  const issues = new Issues();
  const walk = (field: FieldSchema, value: Json, path: string): boolean => {
    switch (field.type) {
      case "string":
        if (typeof value !== "string") return issues.add(path, "wrong_type");
        if (field.enum && !field.enum.includes(value)) return issues.add(path, "out_of_range");
        if (codePoints(value) > (field.maxLength ?? CUSTOM_LIMITS.maxLengthMax)) return issues.add(path, "too_large");
        return true;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) return issues.add(path, "wrong_type");
        return true;
      case "integer":
        if (typeof value !== "number" || !Number.isFinite(value)) return issues.add(path, "wrong_type");
        if (!Number.isInteger(value) || !Number.isSafeInteger(value)) return issues.add(path, "wrong_type");
        return true;
      case "boolean":
        return typeof value === "boolean" || issues.add(path, "wrong_type");
      case "array":
        if (!Array.isArray(value)) return issues.add(path, "wrong_type");
        if (value.length > field.maxItems) return issues.add(path, "too_large");
        return value.every((item, index) => walk(field.items, item, `${path}/${index}`));
      case "object": {
        if (!isPlainObject(value)) return issues.add(path, "wrong_type");
        const record = value as Record<string, Json>;
        for (const key of Object.keys(record)) {
          if (!Object.hasOwn(field.properties, key)) issues.add(pointer(path, key), "unknown_property");
        }
        for (const key of field.required) {
          if (!Object.hasOwn(record, key)) issues.add(pointer(path, key), "required");
        }
        for (const [key, child] of Object.entries(field.properties)) {
          if (Object.hasOwn(record, key)) walk(child, record[key]!, pointer(path, key));
        }
        return true;
      }
    }
  };
  if (!isPlainObject(input)) return { ok: false, issues: [{ path: "", reason: "wrong_type" }] };
  // Numeric bounds are checked by their own type so the message can stay fixed.
  const bounds = (field: FieldSchema, value: Json, path: string): void => {
    if ((field.type === "number" || field.type === "integer") && typeof value === "number") {
      if (field.minimum !== undefined && value < field.minimum) issues.add(path, "out_of_range");
      if (field.maximum !== undefined && value > field.maximum) issues.add(path, "out_of_range");
    }
    if (field.type === "array" && Array.isArray(value)) {
      value.forEach((item, index) => bounds(field.items, item, `${path}/${index}`));
    }
    if (field.type === "object" && isPlainObject(value)) {
      for (const [key, child] of Object.entries(field.properties)) {
        if (Object.hasOwn(value, key)) bounds(child, value[key] as Json, pointer(path, key));
      }
    }
  };
  walk(schema, input, "");
  bounds(schema, input, "");
  return issues.list.length ? failure(issues) : { ok: true, value: input };
}

// ---------------------------------------------------------------------------
// Definition validation

export function normalizeOrigin(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string") return { ok: false, issues: [{ path: "/origin", reason: "invalid_destination" }] };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, issues: [{ path: "/origin", reason: "invalid_destination" }] };
  }
  const host = url.hostname;
  const bare = host.replace(/^\[|\]$/g, "");
  const ipLike = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(bare) || bare.includes(":");
  const valid =
    raw === url.origin &&
    url.protocol === "https:" &&
    url.port === "" &&
    !url.username && !url.password &&
    url.pathname === "/" && !url.search && !url.hash &&
    !ipLike && !url.hostname.endsWith(".") && url.hostname.length > 0;
  return valid ? { ok: true, value: url.origin } : { ok: false, issues: [{ path: "/origin", reason: "invalid_destination" }] };
}

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g;
const BAD_PATH_BYTE = /[?#\\\u0000-\u001f\u007f]/;
const ENCODED_TRAVERSAL = /%(?:2e|2f|5c|00|0[0-9a-f]|1[0-9a-f]|7f)/i;

export function validatePath(raw: unknown, schema: InputSchema, issues: Issues): string | undefined {
  if (typeof raw !== "string") { issues.add("/path", "invalid_destination"); return undefined; }
  if (utf8Bytes(raw) > CUSTOM_LIMITS.pathBytes || !raw.startsWith("/") || raw.startsWith("//")) {
    issues.add("/path", "invalid_destination");
    return undefined;
  }
  if (BAD_PATH_BYTE.test(raw) || ENCODED_TRAVERSAL.test(raw)) { issues.add("/path", "invalid_destination"); return undefined; }
  if (raw.includes("{{") && raw.includes("{{{")) { issues.add("/path", "invalid_destination"); return undefined; }
  for (const segment of raw.split("/").slice(1)) {
    if (segment === "." || segment === "..") { issues.add("/path", "invalid_destination"); continue; }
    const withoutPlaceholders = segment.replace(PLACEHOLDER, "");
    if (withoutPlaceholders.includes("{") || withoutPlaceholders.includes("}")) {
      issues.add("/path", "invalid_destination");
      continue;
    }
    for (const match of segment.matchAll(PLACEHOLDER)) {
      const binding = match[1]!;
      if (!pathBindingValid(schema, binding)) issues.add("/path", "invalid_reference");
    }
  }
  // Every placeholder must be a whole segment.
  for (const segment of raw.split("/").slice(1)) {
    if (segment.includes("{{") && !/^\{\{[A-Za-z][A-Za-z0-9_]{0,63}\}\}$/.test(segment)) {
      issues.add("/path", "invalid_destination");
    }
  }
  return raw;
}

function requiredScalar(schema: InputSchema, name: string): ScalarSchema | undefined {
  if (!schema.required.includes(name)) return undefined;
  const field = schema.properties[name];
  return field && isScalarSchema(field) ? field : undefined;
}
function pathBindingValid(schema: InputSchema, name: string): boolean {
  return !!requiredScalar(schema, name);
}

export function resolvePath(template: string, schema: InputSchema, input: Json): ValidationResult<string> {
  const issues = new Issues();
  const record = input as Record<string, Json>;
  const resolved = template.split("/").map((segment, index) => {
    if (index === 0) return "";
    const match = /^\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}$/.exec(segment);
    if (!match) return segment;
    const field = requiredScalar(schema, match[1]!);
    if (!field || !Object.hasOwn(record, match[1]!)) { issues.add("/path", "invalid_reference"); return ""; }
    const value = String(record[match[1]!]);
    if (value === "." || value === ".." || /[\/\\%\u0000-\u001f\u007f]/.test(value)) {
      issues.add("/path", "invalid_destination");
      return "";
    }
    return encodeURIComponent(value);
  });
  return issues.list.length ? failure(issues) : { ok: true, value: resolved.join("/") || "/" };
}

const QUERY_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function validateBinding(raw: unknown, schema: InputSchema, path: string, issues: Issues, scalarOnly: boolean): Binding | undefined {
  if (!isPlainObject(raw)) { issues.add(path, "invalid_reference"); return undefined; }
  const keys = Object.keys(raw);
  if (keys.length !== 1 || (keys[0] !== "literal" && keys[0] !== "input")) { issues.add(path, "invalid_reference"); return undefined; }
  if (keys[0] === "literal") {
    const literal = validateJsonValue(raw.literal, { maxBytes: CUSTOM_LIMITS.templateBytes, maxDepth: CUSTOM_LIMITS.templateDepth, maxNodes: CUSTOM_LIMITS.templateNodes });
    if (!literal.ok) { issues.add(path, literal.issues[0]!.reason); return undefined; }
    if (scalarOnly && Array.isArray(literal.value)) { issues.add(path, "invalid_reference"); return undefined; }
    if (scalarOnly && isPlainObject(literal.value)) { issues.add(path, "invalid_reference"); return undefined; }
    return { literal: literal.value };
  }
  if (typeof raw.input !== "string" || !requiredScalar(schema, raw.input)) { issues.add(path, "invalid_reference"); return undefined; }
  if (scalarOnly && !requiredScalar(schema, raw.input)) { issues.add(path, "invalid_reference"); return undefined; }
  return { input: raw.input };
}

export function resolveBinding(binding: Binding, input: Json): Json {
  if ("literal" in binding) return binding.literal;
  const record = input as Record<string, Json>;
  return Object.hasOwn(record, binding.input) ? record[binding.input]! : null;
}

const HEADER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DENIED_HEADERS = new Set([
  "host", "content-length", "transfer-encoding", "connection", "cookie", "proxy-authorization",
  "proxy-authenticate", "referer", "origin", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
  "x-real-ip", "x-http-method-override", "x-method-override",
]);
const SECRET_HEADER_WORDS = /token|secret|auth|credential/;
const SECRET_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export const headerNeedsSecret = (name: string): boolean =>
  name === "authorization" || name === "x-api-key" || SECRET_HEADER_WORDS.test(name);

function validHeaderName(name: string): boolean {
  return HEADER_NAME_RE.test(name) && !DENIED_HEADERS.has(name) && !name.startsWith("x-forwarded-");
}

function validateHeaders(raw: unknown, schema: InputSchema, issues: Issues): Header[] | undefined {
  if (!Array.isArray(raw)) { issues.add("/headers", "invalid_header"); return undefined; }
  if (raw.length > CUSTOM_LIMITS.headers) { issues.add("/headers", "too_large"); return undefined; }
  const out: Header[] = [];
  const seen = new Set<string>();
  let resolvedBytes = 0;
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const path = `/headers/${i}`;
    if (!isPlainObject(item)) { issues.add(path, "invalid_header"); continue; }
    const name = typeof item.name === "string" ? item.name : "";
    if (!validHeaderName(name)) { issues.add(path, "invalid_header"); continue; }
    if (utf8Bytes(name) > CUSTOM_LIMITS.headerNameBytes) { issues.add(path, "invalid_header"); continue; }
    if (seen.has(name)) { issues.add(path, "invalid_header"); continue; }
    seen.add(name);
    if (Object.hasOwn(item, "value") && Object.hasOwn(item, "secret")) { issues.add(path, "invalid_header"); continue; }
    if (typeof item.value === "string") {
      if (headerNeedsSecret(name)) { issues.add(path, "invalid_header"); continue; }
      if (item.value === "" || utf8Bytes(item.value) > CUSTOM_LIMITS.headerValueBytes || CONTROL.test(item.value)) {
        issues.add(path, "invalid_header");
        continue;
      }
      resolvedBytes += utf8Bytes(name) + utf8Bytes(item.value) + 4;
      out.push({ name, value: item.value });
      continue;
    }
    if (typeof item.secret === "string") {
      if (!SECRET_NAME_RE.test(item.secret)) { issues.add(path, "invalid_header"); continue; }
      out.push({ name, secret: item.secret });
      continue;
    }
    issues.add(path, "invalid_header");
  }
  if (resolvedBytes > CUSTOM_LIMITS.requestHeadersBytes) issues.add("/headers", "too_large");
  return out;
}

function validateTemplate(raw: unknown, schema: InputSchema, path: string, depth: number, state: { nodes: number }, issues: Issues): JsonTemplate | undefined {
  if (depth > CUSTOM_LIMITS.templateDepth) { issues.add(path, "too_deep"); return undefined; }
  if (++state.nodes > CUSTOM_LIMITS.templateNodes) { issues.add(path, "too_many_nodes"); return undefined; }
  if (!isPlainObject(raw)) { issues.add(path, "invalid_reference"); return undefined; }
  const keys = Object.keys(raw);
  if (keys.length !== 1) { issues.add(path, "invalid_reference"); return undefined; }
  if (keys[0] === "value") {
    const binding = validateBinding(raw.value, schema, path, issues, false);
    return binding ? { value: binding } : undefined;
  }
  if (keys[0] === "object") {
    if (!isPlainObject(raw.object)) { issues.add(path, "invalid_reference"); return undefined; }
    const object: Record<string, JsonTemplate> = Object.create(null) as Record<string, JsonTemplate>;
    for (const [key, child] of Object.entries(raw.object)) {
      if (RESERVED_KEYS.has(key)) { issues.add(path, "reserved_key"); continue; }
      const template = validateTemplate(child, schema, pointer(path, key), depth + 1, state, issues);
      if (template) object[key] = template;
    }
    return { object };
  }
  if (keys[0] === "array") {
    if (!Array.isArray(raw.array)) { issues.add(path, "invalid_reference"); return undefined; }
    const array: JsonTemplate[] = [];
    for (let i = 0; i < raw.array.length; i++) {
      const template = validateTemplate(raw.array[i], schema, `${path}/${i}`, depth + 1, state, issues);
      if (template) array.push(template);
    }
    return { array };
  }
  issues.add(path, "invalid_reference");
  return undefined;
}

export function resolveTemplate(template: JsonTemplate, input: Json): Json {
  if ("value" in template) return resolveBinding(template.value, input);
  if ("array" in template) return template.array.map((child) => resolveTemplate(child, input));
  const object: { [key: string]: Json } = Object.create(null) as { [key: string]: Json };
  for (const [key, child] of Object.entries(template.object)) object[key] = resolveTemplate(child, input);
  return object;
}

function validateQuery(raw: unknown, schema: InputSchema, issues: Issues): HttpQuery[] | undefined {
  if (!Array.isArray(raw)) { issues.add("/query", "invalid_reference"); return undefined; }
  if (raw.length > CUSTOM_LIMITS.queryItems) { issues.add("/query", "too_large"); return undefined; }
  const out: HttpQuery[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const path = `/query/${i}`;
    const item = raw[i];
    if (!isPlainObject(item) || typeof item.name !== "string" || !QUERY_NAME_RE.test(item.name) || seen.has(item.name)) {
      issues.add(path, "invalid_reference");
      continue;
    }
    seen.add(item.name);
    const binding = validateBinding(item.value, schema, path, issues, true);
    if (binding) out.push({ name: item.name, value: binding });
  }
  return out;
}

function validateConfig(raw: unknown, schema: InputSchema, issues: Issues): ToolConfig | undefined {
  if (!isPlainObject(raw)) { issues.add("/config", "invalid_schema"); return undefined; }
  const kind = raw.kind;
  if (kind === "python") {
    const code = raw.code;
    if (typeof code !== "string" || utf8Bytes(code) < 1 || utf8Bytes(code) > CUSTOM_LIMITS.codeBytes || code.includes("\u0000")) {
      issues.add("/config/code", "invalid_schema");
    }
    const timeout = raw.timeoutMs;
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < CUSTOM_LIMITS.pythonTimeoutMin || timeout > CUSTOM_LIMITS.pythonTimeoutMax) {
      issues.add("/config/timeoutMs", "out_of_range");
    }
    for (const key of Object.keys(raw)) if (!["kind", "code", "timeoutMs"].includes(key)) issues.add("/config", "invalid_schema");
    if (issues.list.length) return undefined;
    return { kind: "python", code: code as string, timeoutMs: timeout as number };
  }
  if (kind !== "http") { issues.add("/config/kind", "invalid_schema"); return undefined; }
  for (const key of Object.keys(raw)) {
    if (!["kind", "origin", "path", "method", "query", "headers", "body", "response", "timeoutMs"].includes(key)) issues.add("/config", "invalid_schema");
  }
  const origin = normalizeOrigin(raw.origin);
  if (!origin.ok) issues.add("/config/origin", "invalid_destination");
  const path = validatePath(raw.path, schema, issues);
  const method = raw.method;
  if (typeof method !== "string" || !(HTTP_METHODS as readonly string[]).includes(method)) issues.add("/config/method", "invalid_schema");
  const query = validateQuery(raw.query ?? [], schema, issues);
  const headers = validateHeaders(raw.headers ?? [], schema, issues);
  const response = raw.response;
  if (response !== "json" && response !== "text") issues.add("/config/response", "invalid_schema");
  const timeout = raw.timeoutMs;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < CUSTOM_LIMITS.httpTimeoutMin || timeout > CUSTOM_LIMITS.httpTimeoutMax) {
    issues.add("/config/timeoutMs", "out_of_range");
  }
  const bodyRaw = raw.body === undefined ? null : raw.body;
  let body: JsonTemplate | null = null;
  if (bodyRaw !== null) {
    if (method === "GET" || method === "HEAD") issues.add("/config/body", "invalid_schema");
    body = validateTemplate(bodyRaw, schema, "/config/body", 0, { nodes: 0 }, issues) ?? null;
    if (body && utf8Bytes(JSON.stringify(body)) > CUSTOM_LIMITS.templateBytes) issues.add("/config/body", "too_large");
  }
  // System headers: the only configurable duplicates are the exact values it already sets.
  for (const header of headers ?? []) {
    if (header.name === "accept" && "value" in header && header.value !== (response === "json" ? "application/json" : "text/plain")) {
      issues.add("/config/headers", "invalid_header");
    }
    if (header.name === "content-type" && "value" in header && header.value !== "application/json") {
      issues.add("/config/headers", "invalid_header");
    }
  }
  if (issues.list.length || !origin.ok || !path || !query || !headers) return undefined;
  return {
    kind: "http",
    origin: origin.value,
    path,
    method: method as Method,
    query,
    headers,
    body,
    response: response as "json" | "text",
    timeoutMs: timeout as number,
  };
}

/** Secret map validation independent of the header merge (the store checks references after merging). */
export function validateSecretMap(raw: unknown): ValidationResult<Record<string, string>> {
  const issues = new Issues();
  if (!isPlainObject(raw)) return { ok: false, issues: [{ path: "", reason: "invalid_header" }] };
  const names = Object.keys(raw);
  if (names.length > CUSTOM_LIMITS.secrets) issues.add("", "too_large");
  let bytes = 0;
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of names) {
    if (!SECRET_NAME_RE.test(name)) { issues.add(pointer("", name), "invalid_header"); continue; }
    const value = raw[name];
    if (typeof value !== "string" || utf8Bytes(value) < 1 || utf8Bytes(value) > CUSTOM_LIMITS.secretValueBytes || CONTROL.test(value)) {
      issues.add(pointer("", name), "invalid_header");
      continue;
    }
    bytes += utf8Bytes(value);
    out[name] = value;
  }
  if (bytes > CUSTOM_LIMITS.secretsBytes) issues.add("", "too_large");
  return issues.list.length ? failure(issues) : { ok: true, value: out };
}

export function validateSecretPatch(raw: unknown): ValidationResult<SecretPatch> {
  const issues = new Issues();
  if (!isPlainObject(raw)) return { ok: false, issues: [{ path: "", reason: "invalid_header" }] };
  for (const key of Object.keys(raw)) if (key !== "set" && key !== "remove") issues.add("", "invalid_schema");
  const set = validateSecretMap(raw.set ?? {});
  if (!set.ok) return set;
  const remove = raw.remove ?? [];
  if (!Array.isArray(remove) || remove.some((name) => typeof name !== "string" || !SECRET_NAME_RE.test(name))) {
    issues.add("/remove", "invalid_header");
    return failure(issues);
  }
  if (new Set(remove).size !== remove.length) { issues.add("/remove", "invalid_header"); return failure(issues); }
  for (const name of remove) {
    if (Object.hasOwn(set.value, name)) { issues.add("/remove", "invalid_header"); return failure(issues); }
  }
  return { ok: true, value: { set: set.value, remove: remove as string[] } };
}

/** Every stored secret is referenced by a header, and every header secret exists. */
export function validateSecretReferences(headers: readonly Header[], secrets: Record<string, string>): ValidationIssue[] {
  const referenced = new Set(headers.flatMap((header) => ("secret" in header ? [header.secret] : [])));
  const issues: ValidationIssue[] = [];
  for (const name of Object.keys(secrets)) if (!referenced.has(name)) issues.push({ path: "/secrets", reason: "invalid_header" });
  for (const name of referenced) if (!Object.hasOwn(secrets, name)) issues.push({ path: "/headers", reason: "invalid_reference" });
  return issues.slice(0, MAX_ISSUES);
}

export function validateToolWrite(raw: unknown): ValidationResult<ToolWrite> {
  const issues = new Issues();
  if (!isPlainObject(raw)) return { ok: false, issues: [{ path: "", reason: "invalid_schema" }] };
  for (const key of Object.keys(raw)) {
    if (!["name", "description", "icon", "enabled", "inputSchema", "config"].includes(key)) issues.add("", "invalid_schema");
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (codePoints(name) < 1 || codePoints(name) > CUSTOM_LIMITS.nameChars || utf8Bytes(name) > CUSTOM_LIMITS.nameBytes) {
    issues.add("/name", "out_of_range");
  }
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (utf8Bytes(description) < 1 || utf8Bytes(description) > CUSTOM_LIMITS.descriptionBytes) issues.add("/description", "out_of_range");
  const icon = raw.icon;
  if (typeof icon !== "string" || !(CUSTOM_TOOL_ICONS as readonly string[]).includes(icon)) issues.add("/icon", "invalid_schema");
  if (typeof raw.enabled !== "boolean") issues.add("/enabled", "invalid_schema");
  const schema = validateInputSchema(raw.inputSchema);
  if (!schema.ok) return schema;
  const config = validateConfig(raw.config, schema.value, issues);
  if (issues.list.length || !config) return failure(issues);
  return {
    ok: true,
    value: {
      name,
      description,
      icon: icon as CustomToolIcon,
      enabled: raw.enabled as boolean,
      inputSchema: schema.value,
      config,
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP request expansion

export interface ResolvedRequest {
  method: Method;
  url: string;
  /** System headers first, then configured headers in editor order. Secret values are never present. */
  headers: Header[];
  /** Exact serialized JSON bytes, or null. */
  body: string | null;
  warning: "outbound" | "outbound_destructive";
}

export function resolveHttpRequest(config: HttpConfig, schema: InputSchema, input: Json): ValidationResult<ResolvedRequest> {
  const issues = new Issues();
  const path = resolvePath(config.path, schema, input);
  if (!path.ok) return path;
  const url = new URL(config.origin);
  url.pathname = path.value;
  const search = new URLSearchParams();
  for (const item of config.query) {
    const value = resolveBinding(item.value, input);
    if (value === null || typeof value === "object") {
      issues.add("/config/query", "out_of_range");
      continue;
    }
    search.append(item.name, String(value));
  }
  const withQuery = search.size ? `${url.href}${url.search ? "&" : "?"}${search.toString()}` : url.href;
  if (utf8Bytes(withQuery) > CUSTOM_LIMITS.urlBytes) issues.add("/config/path", "too_large");
  if (issues.list.length) return failure(issues);
  const systemAccept = config.response === "json" ? "application/json" : "text/plain";
  const headers: Header[] = [{ name: "accept", value: systemAccept }];
  if (config.body !== null) headers.push({ name: "content-type", value: "application/json" });
  for (const header of config.headers) {
    if (header.name === "accept" || header.name === "content-type") continue;
    headers.push(header);
  }
  let body: string | null = null;
  if (config.body !== null) {
    const value = resolveTemplate(config.body, input);
    body = canonicalJson(value);
    if (utf8Bytes(body) > CUSTOM_LIMITS.bodyBytes) issues.add("/config/body", "too_large");
  }
  let headerBytes = 0;
  for (const header of headers) {
    const value = "value" in header ? header.value : "";
    headerBytes += utf8Bytes(header.name) + utf8Bytes(value) + 4;
  }
  if (headerBytes > CUSTOM_LIMITS.requestHeadersBytes) issues.add("/config/headers", "too_large");
  if (issues.list.length) return failure(issues);
  return {
    ok: true,
    value: {
      method: config.method,
      url: withQuery,
      headers,
      body,
      warning: config.method === "GET" || config.method === "HEAD" ? "outbound" : "outbound_destructive",
    },
  };
}

/** Review rows expose public values and secret names, never a secret value. */
export function reviewHeaders(headers: readonly Header[]): ReviewHeader[] {
  return headers.map((header) => ("value" in header
    ? { name: header.name, value: header.value, secretName: null }
    : { name: header.name, value: null, secretName: header.secret }));
}

/** Plain header record for dispatch. Only callers that have decrypted secrets may use the secret branches. */
export function headerValues(headers: readonly Header[], secrets: Record<string, string>): ValidationResult<Record<string, string>> {
  const issues = new Issues();
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const header of headers) {
    if ("value" in header) {
      out[header.name] = header.value;
      continue;
    }
    const value = secrets[header.secret];
    if (typeof value !== "string" || !value) { issues.add("/headers", "invalid_reference"); continue; }
    out[header.name] = value;
  }
  return issues.list.length ? failure(issues) : { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Safe result and redaction

const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Authorization\s*[:=]\s*)(Bearer|Basic)\s+[A-Za-z0-9+/=._~-]{8,}/gi, "$1$2 [redacted]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._~-]{20,}/g, "$1 [redacted]"],
  [/\b(sk|pk|rk|ghp|gho|glpat)[-_][A-Za-z0-9_-]{12,}/g, "[redacted]"],
  [/((?:api[_-]?key|access[_-]?token|token|secret|password|auth)[=:]\s*)[A-Za-z0-9+/=._~-]{8,}/gi, "$1[redacted]"],
];

function redactString(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function redactResult(value: Json, secrets: readonly string[]): ValidationResult<Json> {
  const issues = new Issues();
  let nodes = 0;
  const walk = (item: Json, path: string, depth: number): Json => {
    if (depth > OUTPUT_JSON_LIMITS.maxDepth) { issues.add(path, "too_deep"); return null; }
    if (++nodes > OUTPUT_JSON_LIMITS.maxNodes) { issues.add(path, "too_many_nodes"); return null; }
    if (typeof item === "string") return redactString(item, secrets);
    if (item === null || typeof item === "boolean" || typeof item === "number") return item;
    if (Array.isArray(item)) return item.map((child, index) => walk(child, `${path}/${index}`, depth + 1));
    const out: { [key: string]: Json } = Object.create(null) as { [key: string]: Json };
    for (const [key, child] of Object.entries(item)) {
      let safeKey = key;
      for (const secret of secrets) {
        if (secret.length >= 4 && key.includes(secret)) { issues.add(path, "reserved_key"); safeKey = key; }
      }
      safeKey = redactString(safeKey, secrets);
      if (RESERVED_KEYS.has(safeKey)) { issues.add(path, "duplicate_key"); continue; }
      if (Object.hasOwn(out, safeKey)) { issues.add(path, "duplicate_key"); continue; }
      out[safeKey] = walk(child, pointer(path, safeKey), depth + 1);
    }
    return out;
  };
  const redacted = walk(value, "", 0);
  if (issues.list.length) return failure(issues);
  if (utf8Bytes(canonicalJson(redacted)) > CUSTOM_LIMITS.outputBytes) return { ok: false, issues: [{ path: "", reason: "too_large" }] };
  return { ok: true, value: redacted };
}

/** A fixed English message per error code. Never raw upstream, worker or exception text. */
export const RUN_ERROR_MESSAGES: Record<RunErrorCode, string> = {
  invalid_input: "The input does not match this tool's schema.",
  definition_changed: "The tool changed. Review its current revision before running it.",
  disabled: "This tool is not enabled in chats.",
  permission_denied: "This account is not allowed to run this tool.",
  approval_required: "This HTTP request needs explicit approval.",
  approval_expired: "This approval expired. Review the request again.",
  approval_denied: "The request was denied.",
  blocked_destination: "The destination is not a public HTTPS host.",
  redirect_blocked: "The destination answered with a redirect, which is never followed.",
  rate_limited: "Too many tool executions. Try again shortly.",
  service_unavailable: "The sandbox is unavailable, so the function did not run.",
  timeout: "The execution reached its time limit.",
  cancelled: "The execution was cancelled.",
  response_too_large: "The response was larger than the allowed limit.",
  invalid_json: "The result was not one valid JSON value.",
  invalid_result: "The result could not be safely returned.",
  python_error: "The function raised an error.",
  http_status: "The destination returned a non-success status.",
  network_error: "The request could not reach the destination.",
  outcome_unknown: "The remote service may have received this request. Check before trying again.",
};

export const runError = (code: RunErrorCode): RunError => ({ code, message: RUN_ERROR_MESSAGES[code] });

export const warningFor = (method: Method): "outbound" | "outbound_destructive" =>
  method === "GET" || method === "HEAD" ? "outbound" : "outbound_destructive";

/** UUIDv7 for workspace test request ids: the embedded timestamp gives the 24 h freshness bound. */
export function newRequestId(random: (bytes: number) => Uint8Array, now = Date.now()): string {
  const bytes = random(10);
  const rand = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const time = now.toString(16).padStart(12, "0");
  const variant = (8 + (bytes[0]! % 4)).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${time.slice(12, 15)}-${variant}${rand.slice(0, 3)}-${rand.slice(3, 15)}`;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validRequestId(value: unknown, now = Date.now()): value is string {
  if (typeof value !== "string" || !UUID_V7.test(value)) return false;
  const timestamp = parseInt(value.replaceAll("-", "").slice(0, 12), 16);
  return Number.isFinite(timestamp) && timestamp <= now + 60_000 && timestamp >= now - CUSTOM_LIMITS.dedupeTtlMs;
}
