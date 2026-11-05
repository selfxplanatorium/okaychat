import {
  canonicalDocument,
  canonicalJson,
  type Change,
  type FeatureKey,
  type LimitKey,
  type PolicyDocument,
  type PolicyRow,
  type PromptRule,
  type PromptRuleValue,
  type Subject,
} from "@shared/permissions";
import type { PromptKey } from "@shared/types";

// Pure draft rules for the permissions editor. The baseline is what the server last returned; a draft is
// the local document. Reset deletes a field, so only intentional differences become `Change`s, and a
// destination whose normalized draft equals its baseline is never sent.

export interface PolicyDraft {
  baseline: PolicyDocument | null;
  draft: PolicyDocument;
}

export interface PromptDraft {
  baseline: PromptRuleValue | null;
  draft: PromptRuleValue | null;
}

export const ALL_MODELS = "";

export const selectorKey = (modelRef: string | null): string => modelRef ?? ALL_MODELS;

export const policyKey = (subject: Subject, modelRef: string | null): string => `${subject.kind}:${subject.id}|${selectorKey(modelRef)}`;

export const promptKeyOf = (subject: Subject, modelRef: string | null, key: PromptKey): string =>
  `${policyKey(subject, modelRef)}|${key}`;

export const emptyPolicy = (): PolicyDocument => ({ version: 1 });

/** The stored document for one destination, or an empty document when the row does not exist. */
export function baselinePolicy(rows: readonly PolicyRow[], subject: Subject, modelRef: string | null): PolicyDocument | null {
  const row = rows.find((item) => item.subject.kind === subject.kind && item.subject.id === subject.id && item.modelRef === modelRef);
  return row ? canonicalDocument(row.document) : null;
}

export function baselinePrompt(rows: readonly PromptRule[], subject: Subject, modelRef: string | null, key: PromptKey): PromptRuleValue | null {
  const row = rows.find(
    (item) => item.subject.kind === subject.kind && item.subject.id === subject.id && item.modelRef === modelRef && item.key === key,
  );
  return row ? { mode: row.rule.mode, text: normalizePromptText(row.rule.text) } : null;
}

/** CRLF is normalized on write; every other byte (including trailing spaces) is preserved. */
export function normalizePromptText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** `undefined` inherits (deletes the field), `true`/`false` are explicit decisions. */
export function setModelAllowed(document: PolicyDocument, value: boolean | undefined): PolicyDocument {
  const next: PolicyDocument = { ...document };
  if (value === undefined) delete next.modelAllowed;
  else next.modelAllowed = value;
  return canonicalDocument(next) ?? emptyPolicy();
}

/** `undefined` inherits; a boolean is an explicit allow/deny. */
export function setFeature(document: PolicyDocument, key: FeatureKey, value: boolean | undefined): PolicyDocument {
  const features = { ...(document.features ?? {}) };
  if (value === undefined) delete features[key];
  else features[key] = value;
  const next: PolicyDocument = { ...document, features };
  if (!Object.keys(features).length) delete next.features;
  return canonicalDocument(next) ?? emptyPolicy();
}

/** `undefined` inherits, `null` means "no additional limit", a number is an explicit ceiling. */
export function setLimit(document: PolicyDocument, key: LimitKey, value: number | null | undefined): PolicyDocument {
  const limits = { ...(document.limits ?? {}) };
  if (value === undefined) delete limits[key];
  else limits[key] = value;
  const next: PolicyDocument = { ...document, limits };
  if (!Object.keys(limits).length) delete next.limits;
  return canonicalDocument(next) ?? emptyPolicy();
}

export function samePolicy(left: PolicyDocument | null, right: PolicyDocument | null): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** A policy change only when the destination really differs. Null deletes the row. */
export function policyChange(
  subject: Subject,
  modelRef: string | null,
  draft: PolicyDocument | null,
  baseline: PolicyDocument | null,
): Change | null {
  const next = draft ? canonicalDocument(draft) : null;
  const before = baseline ? canonicalDocument(baseline) : null;
  if (samePolicy(next, before)) return null;
  return { kind: "policy", subject, modelRef, document: next };
}

export function samePrompt(left: PromptRuleValue | null, right: PromptRuleValue | null): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** A prompt rule change only when the rule really differs. Null deletes the row. */
export function promptChange(
  subject: Subject,
  modelRef: string | null,
  key: PromptKey,
  draft: PromptRuleValue | null,
  baseline: PromptRuleValue | null,
): Change | null {
  const next = draft ? { mode: draft.mode, text: normalizePromptText(draft.text) } : null;
  const before = baseline ? { mode: baseline.mode, text: normalizePromptText(baseline.text) } : null;
  if (samePrompt(next, before)) return null;
  return { kind: "prompt", subject, modelRef, key, rule: next };
}

/** Collects only changed destinations from every edited draft. */
export function collectChanges(
  policies: readonly { subject: Subject; modelRef: string | null; draft: PolicyDraft }[],
  prompts: readonly { subject: Subject; modelRef: string | null; key: PromptKey; draft: PromptDraft }[],
): Change[] {
  const changes: Change[] = [];
  for (const item of policies) {
    const change = policyChange(item.subject, item.modelRef, item.draft.draft, item.draft.baseline);
    if (change) changes.push(change);
  }
  for (const item of prompts) {
    const change = promptChange(item.subject, item.modelRef, item.key, item.draft.draft, item.draft.baseline);
    if (change) changes.push(change);
  }
  return changes;
}

/** Editing a prompt to inherit removes the override; editing back to the baseline also removes it. */
export function nextPromptDraft(baseline: PromptRuleValue | null, mode: "inherit" | "replace" | "append", text: string): PromptRuleValue | null {
  if (mode === "inherit") return null;
  return { mode, text: normalizePromptText(text) };
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Applies an ordered prompt layer the same way the server does: replace swaps, append adds a blank line. */
export function applyPromptLayer(accumulated: string, rule: PromptRuleValue | null): string {
  if (!rule) return accumulated;
  if (rule.mode === "replace") return rule.text;
  return accumulated ? `${accumulated}\n\n${rule.text}` : rule.text;
}

export interface PromptLayerRow {
  subject: Subject;
  modelRef: string | null;
  rule: PromptRuleValue;
  order: number;
}

/**
 * Recomputes the inherited prompt text client-side for the editor's "effective" tab. This mirrors the
 * server order (everyone, groups by prompt order with all-model before exact, then user), but it is a
 * display aid only: the server remains authoritative.
 */
export function inheritedPromptText(
  defaultText: string,
  serverText: string | null,
  layers: readonly PromptLayerRow[],
  subject: Subject,
  modelRef: string | null,
  groupOrder: ReadonlyMap<string, number>,
  groupIds: readonly string[],
): string {
  const rank = (kind: Subject["kind"]) => (kind === "everyone" ? 0 : kind === "group" ? 1 : 2);
  const relevant = layers
    .filter((layer) => layer.modelRef === null || layer.modelRef === modelRef)
    .filter((layer) => layer.subject.kind === "everyone" || (layer.subject.kind === "user" ? subject.kind === "user" && layer.subject.id === subject.id : groupIds.includes(layer.subject.id)))
    .sort(
      (a, b) =>
        rank(a.subject.kind) - rank(b.subject.kind) ||
        (a.subject.kind === "group" ? (groupOrder.get(a.subject.id) ?? -1) - (groupOrder.get(b.subject.id) ?? -1) : 0) ||
        Number(a.modelRef !== null) - Number(b.modelRef !== null),
    );
  let text = serverText ?? defaultText;
  for (const layer of relevant) text = applyPromptLayer(text, layer.rule);
  return text;
}
