import {
  canonicalDocument,
  canonicalJson,
  type PolicyDocument,
  type PolicyLayer,
  type PolicyRow,
  type PromptRule,
  type PromptRuleValue,
  type Subject,
} from "../../shared/permissions.js";
import type { PromptKey } from "../../shared/types.js";
import { db } from "../db.js";
import { PROMPT_KEYS } from "../prompts.js";
import { parseStoredDocument } from "./schema.js";

// Storage of permission documents and admin prompt rules. Readers join live users, groups, and memberships,
// so a row left behind by a missed cleanup can never apply to a deleted subject.

type SqlRow = { subject_kind: Subject["kind"]; subject_id: string; model_ref: string; document: string; updated_at: number; updated_by: string | null };

const fromSql = (ref: string): string | null => (ref === "" ? null : ref);
const toSql = (ref: string | null): string => ref ?? "";

export interface UserLayers {
  layers: PolicyLayer[];
  groupIds: string[];
  /** Ids of rows whose stored document failed validation. Resolution fails closed when any applies. */
  invalid: string[];
}

/** Every policy row that can apply to the user, for one model (exact rows of other models excluded). */
export function layersFor(userId: string, modelRef: string | null): UserLayers {
  const groupIds = (db
    .prepare("SELECT m.group_id AS id FROM user_group_members m JOIN user_groups g ON g.id = m.group_id WHERE m.user_id = ? ORDER BY m.group_id")
    .all(userId) as Array<{ id: string }>).map((row) => row.id);
  const rows = db
    .prepare(
      `SELECT p.subject_kind, p.subject_id, p.model_ref, p.document, p.updated_at, p.updated_by FROM permission_policies p
       WHERE (p.model_ref = '' OR p.model_ref = ?) AND (
         p.subject_kind = 'everyone'
         OR (p.subject_kind = 'user' AND p.subject_id = ? AND EXISTS (SELECT 1 FROM users u WHERE u.id = p.subject_id))
         OR (p.subject_kind = 'group' AND EXISTS (
           SELECT 1 FROM user_group_members m JOIN user_groups g ON g.id = m.group_id WHERE m.group_id = p.subject_id AND m.user_id = ?)))`,
    )
    .all(modelRef ?? "", userId, userId) as SqlRow[];
  const layers: PolicyLayer[] = [];
  const invalid: string[] = [];
  for (const row of rows) {
    try {
      layers.push({ subject: { kind: row.subject_kind, id: row.subject_id }, modelRef: fromSql(row.model_ref), document: parseStoredDocument(row.document) });
    } catch {
      invalid.push(`${row.subject_kind}:${row.subject_id}:${row.model_ref}`);
    }
  }
  return { layers, groupIds, invalid };
}

export function listPolicies(subject: Subject): PolicyRow[] {
  const rows = db
    .prepare("SELECT subject_kind, subject_id, model_ref, document, updated_at, updated_by FROM permission_policies WHERE subject_kind = ? AND subject_id = ? ORDER BY model_ref")
    .all(subject.kind, subject.id) as SqlRow[];
  return rows.flatMap((row) => {
    try {
      return [{ subject, modelRef: fromSql(row.model_ref), document: parseStoredDocument(row.document), updatedAt: row.updated_at, updatedBy: row.updated_by }];
    } catch {
      return [];
    }
  });
}

export function getPolicy(subject: Subject, modelRef: string | null): PolicyDocument | null {
  const row = db.prepare("SELECT document FROM permission_policies WHERE subject_kind = ? AND subject_id = ? AND model_ref = ?")
    .get(subject.kind, subject.id, toSql(modelRef)) as { document: string } | undefined;
  if (!row) return null;
  try {
    return parseStoredDocument(row.document);
  } catch {
    return null;
  }
}

/** Writes or deletes one document. Returns whether anything changed (no-op writes do not bump the revision). */
export function writePolicy(subject: Subject, modelRef: string | null, document: PolicyDocument | null, actorId: string | null): boolean {
  const canonical = document ? canonicalDocument(document) : null;
  const before = getPolicy(subject, modelRef);
  if (canonicalJson(before) === canonicalJson(canonical)) return false;
  if (!canonical) {
    db.prepare("DELETE FROM permission_policies WHERE subject_kind = ? AND subject_id = ? AND model_ref = ?").run(subject.kind, subject.id, toSql(modelRef));
  } else {
    db.prepare(
      `INSERT INTO permission_policies (subject_kind, subject_id, model_ref, document, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (subject_kind, subject_id, model_ref) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(subject.kind, subject.id, toSql(modelRef), canonicalJson(canonical), Date.now(), actorId);
  }
  return true;
}

type RuleSql = { subject_kind: Subject["kind"]; subject_id: string; model_ref: string; prompt_key: string; mode: "replace" | "append"; text: string; updated_at: number };

const isPromptKey = (key: string): key is PromptKey => (PROMPT_KEYS as string[]).includes(key);

/** A subject's prompt rules. Rules for keys this build no longer knows stay stored but dormant. */
export function listPromptRules(subject: Subject): PromptRule[] {
  const rows = db
    .prepare("SELECT subject_kind, subject_id, model_ref, prompt_key, mode, text, updated_at FROM prompt_rules WHERE subject_kind = ? AND subject_id = ? ORDER BY prompt_key, model_ref")
    .all(subject.kind, subject.id) as RuleSql[];
  return rows.filter((row) => isPromptKey(row.prompt_key)).map((row) => ({
    subject,
    modelRef: fromSql(row.model_ref),
    key: row.prompt_key as PromptKey,
    rule: { mode: row.mode, text: row.text },
    updatedAt: row.updated_at,
  }));
}

export function getPromptRule(subject: Subject, modelRef: string | null, key: PromptKey): PromptRuleValue | null {
  const row = db.prepare("SELECT mode, text FROM prompt_rules WHERE subject_kind = ? AND subject_id = ? AND model_ref = ? AND prompt_key = ?")
    .get(subject.kind, subject.id, toSql(modelRef), key) as { mode: "replace" | "append"; text: string } | undefined;
  return row ? { mode: row.mode, text: row.text } : null;
}

export function writePromptRule(subject: Subject, modelRef: string | null, key: PromptKey, rule: PromptRuleValue | null, actorId: string | null): boolean {
  const before = getPromptRule(subject, modelRef, key);
  if (canonicalJson(before) === canonicalJson(rule)) return false;
  if (!rule) {
    db.prepare("DELETE FROM prompt_rules WHERE subject_kind = ? AND subject_id = ? AND model_ref = ? AND prompt_key = ?").run(subject.kind, subject.id, toSql(modelRef), key);
  } else {
    db.prepare(
      `INSERT INTO prompt_rules (subject_kind, subject_id, model_ref, prompt_key, mode, text, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (subject_kind, subject_id, model_ref, prompt_key) DO UPDATE SET mode = excluded.mode, text = excluded.text,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(subject.kind, subject.id, toSql(modelRef), key, rule.mode, rule.text, Date.now(), actorId);
  }
  return true;
}

export interface PromptLayerRow {
  subject: Subject;
  modelRef: string | null;
  rule: PromptRuleValue;
  /** Group prompt order; 0 for everyone and user rows. */
  order: number;
}

/**
 * Admin prompt rules applying to the user for one key and model, in application order: everyone/model,
 * groups by ascending prompt order (all-model before exact), then user/all and user/model. A group with an
 * unexpected missing order makes the result invalid rather than choosing an arbitrary sequence.
 */
export function promptLayersFor(userId: string, modelRef: string, key: PromptKey): { layers: PromptLayerRow[]; invalid: boolean } {
  const rows = db
    .prepare(
      `SELECT r.subject_kind, r.subject_id, r.model_ref, r.mode, r.text, g.prompt_order AS group_order FROM prompt_rules r
       LEFT JOIN user_groups g ON r.subject_kind = 'group' AND g.id = r.subject_id
       WHERE r.prompt_key = ? AND (r.model_ref = '' OR r.model_ref = ?) AND (
         r.subject_kind = 'everyone'
         OR (r.subject_kind = 'user' AND r.subject_id = ? AND EXISTS (SELECT 1 FROM users u WHERE u.id = r.subject_id))
         OR (r.subject_kind = 'group' AND EXISTS (SELECT 1 FROM user_group_members m WHERE m.group_id = r.subject_id AND m.user_id = ?)))`,
    )
    .all(key, modelRef, userId, userId) as Array<{
      subject_kind: Subject["kind"];
      subject_id: string;
      model_ref: string;
      mode: "replace" | "append";
      text: string;
      group_order: number | null;
    }>;
  let invalid = false;
  const rank = (kind: Subject["kind"]) => (kind === "everyone" ? 0 : kind === "group" ? 1 : 2);
  const layers = rows.map((row) => {
    if (row.subject_kind === "group" && (row.group_order === null || !Number.isSafeInteger(row.group_order))) invalid = true;
    return {
      subject: { kind: row.subject_kind, id: row.subject_id },
      modelRef: fromSql(row.model_ref),
      rule: { mode: row.mode, text: row.text },
      order: row.subject_kind === "group" ? row.group_order ?? 0 : 0,
    };
  });
  layers.sort((a, b) =>
    rank(a.subject.kind) - rank(b.subject.kind)
    || a.order - b.order
    || Number(a.modelRef !== null) - Number(b.modelRef !== null));
  return { layers, invalid };
}

/** Removes every polymorphic row of a deleted subject. Call inside the deletion's transaction. */
export function deleteSubjectRows(subject: Subject): number {
  const policies = db.prepare("DELETE FROM permission_policies WHERE subject_kind = ? AND subject_id = ?").run(subject.kind, subject.id).changes;
  const prompts = db.prepare("DELETE FROM prompt_rules WHERE subject_kind = ? AND subject_id = ?").run(subject.kind, subject.id).changes;
  return Number(policies) + Number(prompts);
}

/** Every stored exact-model selector, so editors can show dormant rows for models missing from the catalog. */
export function storedModelRefs(): string[] {
  return (db.prepare("SELECT model_ref FROM permission_policies WHERE model_ref <> '' UNION SELECT model_ref FROM prompt_rules WHERE model_ref <> '' ORDER BY 1")
    .all() as Array<{ model_ref: string }>).map((row) => row.model_ref);
}
