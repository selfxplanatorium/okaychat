// Personal saved prompts: account-wide templates the user inserts into the composer. Only the expanded text the
// user then sends becomes conversation content; templates never reach a model by themselves.
// See docs/implementation/saved-prompts.md.

export interface SavedPrompt {
  id: string;
  name: string;
  shortcut: string;
  body: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface SavedPromptWrite {
  name: string;
  shortcut: string;
  body: string;
}

export interface PromptVariable {
  name: string;
}

export const MAX_SAVED_PROMPTS = 200;
export const MAX_PROMPT_NAME = 80;
export const MAX_PROMPT_BODY = 20_000;
export const MAX_PROMPT_BODY_BYTES = 80 * 1024;
export const MAX_PROMPT_VARIABLES = 20;
export const MAX_EXPANDED_PROMPT = 100_000;
export const MAX_EXPANDED_PROMPT_BYTES = 400 * 1024;
/** HTTP body cap for a create/update, checked before JSON parsing. */
export const SAVED_PROMPT_BODY_LIMIT = 96 * 1024;

export const SHORTCUT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const VARIABLE = /\{\{([A-Za-z][A-Za-z0-9_]{0,31})\}\}/y;

/** Unicode code points, the unit every length limit here uses, so emoji and CJK count as one each. */
export function codePoints(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/** Lowercase ASCII without a leading slash. The result still has to pass `SHORTCUT_PATTERN`. */
export const normalizeShortcut = (input: string) => input.trim().replace(/^\//, "").toLowerCase();

export type TemplateSegment = { type: "text"; text: string } | { type: "variable"; name: string };

/**
 * One linear pass over a template. Only `{{name}}` is a variable; `\{{name}}` is the literal text `{{name}}`
 * (one backslash, consumed). Every other brace or backslash is literal, so JSON and code examples stay usable.
 */
export function tokenizeTemplate(body: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let text = "";
  let i = 0;
  const variableAt = (at: number) => {
    if (body.charCodeAt(at) !== 123 || body.charCodeAt(at + 1) !== 123) return null;
    VARIABLE.lastIndex = at;
    return VARIABLE.exec(body);
  };
  while (i < body.length) {
    if (body[i] === "\\") {
      const escaped = variableAt(i + 1);
      if (escaped) {
        text += escaped[0];
        i += 1 + escaped[0].length;
        continue;
      }
    }
    const match = variableAt(i);
    if (match) {
      if (text) segments.push({ type: "text", text });
      text = "";
      segments.push({ type: "variable", name: match[1]! });
      i += match[0].length;
      continue;
    }
    text += body[i];
    i++;
  }
  if (text) segments.push({ type: "text", text });
  return segments;
}

/** Distinct variables in order of first appearance. Names are case-sensitive. */
export function parsePromptVariables(body: string): PromptVariable[] {
  const seen = new Set<string>();
  for (const segment of tokenizeTemplate(body)) if (segment.type === "variable") seen.add(segment.name);
  return [...seen].map((name) => ({ name }));
}

/**
 * Substitutes values in one pass. Values are inserted verbatim: braces or `$&` inside a value are never parsed
 * again or treated as replacement syntax.
 */
export function renderPromptTemplate(body: string, values: Readonly<Record<string, string>>): string {
  return tokenizeTemplate(body)
    .map((segment) => (segment.type === "text" ? segment.text : (Object.hasOwn(values, segment.name) ? values[segment.name]! : "")))
    .join("");
}

export type SavedPromptProblem = "nameRequired" | "nameTooLong" | "invalidShortcut" | "bodyRequired" | "bodyTooLong" | "tooManyVariables";

/** Normalizes a write (trimmed name, normalized shortcut, body kept as typed) or names the first problem. */
export function checkSavedPromptWrite(input: SavedPromptWrite): { ok: true; value: SavedPromptWrite } | { ok: false; problem: SavedPromptProblem } {
  const name = input.name.trim();
  const shortcut = normalizeShortcut(input.shortcut);
  const body = input.body;
  if (!name) return { ok: false, problem: "nameRequired" };
  if (codePoints(name) > MAX_PROMPT_NAME) return { ok: false, problem: "nameTooLong" };
  if (!SHORTCUT_PATTERN.test(shortcut)) return { ok: false, problem: "invalidShortcut" };
  if (!body.trim()) return { ok: false, problem: "bodyRequired" };
  if (codePoints(body) > MAX_PROMPT_BODY || utf8Bytes(body) > MAX_PROMPT_BODY_BYTES) return { ok: false, problem: "bodyTooLong" };
  if (parsePromptVariables(body).length > MAX_PROMPT_VARIABLES) return { ok: false, problem: "tooManyVariables" };
  return { ok: true, value: { name, shortcut, body } };
}

/** Whether an expanded prompt fits the insertion caps. */
export const expandedWithinLimits = (text: string) => codePoints(text) <= MAX_EXPANDED_PROMPT && utf8Bytes(text) <= MAX_EXPANDED_PROMPT_BYTES;

/** Shortcut prefix matches first, then name substring matches; each group by name, then id. */
export function searchSavedPrompts(prompts: readonly SavedPrompt[], query: string, compare: (a: string, b: string) => number): SavedPrompt[] {
  const q = query.trim().replace(/^\//, "").toLowerCase();
  const byName = (a: SavedPrompt, b: SavedPrompt) => compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (!q) return [...prompts].sort(byName);
  const prefix = prompts.filter((p) => p.shortcut.startsWith(q)).sort(byName);
  const rest = prompts.filter((p) => !p.shortcut.startsWith(q) && p.name.toLowerCase().includes(q)).sort(byName);
  return [...prefix, ...rest];
}
