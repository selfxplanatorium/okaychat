import { HTTPException } from "hono/http-exception";
import { applyPromptRule, type PromptRuleValue } from "../shared/permissions.js";
import type { PromptKey } from "../shared/types.js";
import { db, tx } from "./db.js";
import { policyInvalidError } from "./permissions/guard.js";
import { promptLayersFor } from "./permissions/store.js";
import { compiledPrompt, fillPrompt, serverOverride } from "./prompts.js";
import { assertStorage } from "./quota.js";
import { getSettings } from "./settings.js";

// Context-aware prompt resolution (docs/implementation/granular-permissions.md). Each PromptKey resolves on
// its own: compiled default, the server-wide override, then admin rules for everyone/model, the user's
// groups in prompt order (all-model before exact), and the user (all, then model). Personal instructions
// are a separate, lower layer the account owner edits; they never share storage with admin rules.

export interface PromptActor {
  userId: string;
  modelRef: string;
}

export interface PromptSource {
  kind: "compiled" | "server" | "everyone" | "group" | "user";
  subjectId?: string;
  modelRef: string | null;
  mode: "replace" | "append" | "default";
  text: string;
  order: number;
  applied: boolean;
}

export interface ResolvedPrompt {
  key: PromptKey;
  template: string;
  text: string;
  layers: PromptSource[];
}

/** The resolved template (placeholders unfilled) and every layer that produced it. */
export function resolvePromptTemplate(key: PromptKey, actor: PromptActor): { template: string; layers: PromptSource[] } {
  const layers: PromptSource[] = [{ kind: "compiled", modelRef: null, mode: "default", text: compiledPrompt(key), order: 0, applied: true }];
  let template = compiledPrompt(key);
  const server = serverOverride(key);
  if (server !== null) {
    layers.push({ kind: "server", modelRef: null, mode: "replace", text: server, order: 0, applied: true });
    template = server;
  }
  const { layers: rules, invalid } = promptLayersFor(actor.userId, actor.modelRef, key);
  if (invalid) throw policyInvalidError();
  for (const row of rules) {
    template = applyPromptRule(template, row.rule);
    layers.push({
      kind: row.subject.kind,
      ...(row.subject.kind === "everyone" ? {} : { subjectId: row.subject.id }),
      modelRef: row.modelRef,
      mode: row.rule.mode,
      text: row.rule.text,
      order: row.order,
      applied: true,
    });
  }
  // A later replace hides everything before it; mark those layers as overridden in the trace.
  const lastReplace = layers.findLastIndex((layer) => layer.mode === "replace");
  for (let index = 0; index < lastReplace; index++) layers[index]!.applied = false;
  return { template, layers };
}

/** The prompt this actor's model receives for `key`, with known placeholders filled. */
export function resolvePrompt(key: PromptKey, actor: PromptActor, values: Record<string, string | number> = {}): string {
  return fillPrompt(key, resolvePromptTemplate(key, actor).template, values);
}

export function resolvePromptDetail(key: PromptKey, actor: PromptActor, values: Record<string, string | number> = {}): ResolvedPrompt {
  const { template, layers } = resolvePromptTemplate(key, actor);
  return { key, template, text: fillPrompt(key, template, values), layers };
}

// Personal per-model instructions -----------------------------------------------------------------------

export interface ModelInstruction {
  modelRef: string;
  revision: number;
  mode: "inherit" | "replace" | "append";
  text: string;
  accountText: string;
  effectivePersonalText: string;
}

/** One revision for every personal instruction write (account text and per-model rules) so reset cannot ABA. */
export function instructionsRevision(userId: string): number {
  return getSettings(userId).instructionsRevision ?? 0;
}

export function bumpInstructionsRevision(userId: string): number {
  const settings = getSettings(userId);
  const next = (settings.instructionsRevision ?? 0) + 1;
  db.prepare("INSERT INTO user_settings (user_id, json) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET json = excluded.json")
    .run(userId, JSON.stringify({ ...settings, instructionsRevision: next }));
  return next;
}


function modelRule(userId: string, modelRef: string): PromptRuleValue | null {
  const row = db.prepare("SELECT mode, text FROM user_model_instructions WHERE user_id = ? AND model_ref = ?").get(userId, modelRef) as
    | { mode: "replace" | "append"; text: string }
    | undefined;
  return row ? { mode: row.mode, text: row.text } : null;
}

/** The account owner's own instructions for this model: account text, then the per-model rule. */
export function personalInstructions(userId: string, modelRef: string, accountText = getSettings(userId).systemPrompt): string {
  const rule = modelRule(userId, modelRef);
  return rule ? applyPromptRule(accountText, rule) : accountText;
}

export function getModelInstruction(userId: string, modelRef: string): ModelInstruction {
  const rule = modelRule(userId, modelRef);
  const accountText = getSettings(userId).systemPrompt;
  return {
    modelRef,
    revision: instructionsRevision(userId),
    mode: rule?.mode ?? "inherit",
    text: rule?.text ?? "",
    accountText,
    effectivePersonalText: personalInstructions(userId, modelRef, accountText),
  };
}

/** Compare-and-set on the account instruction revision; a stale tab gets 409 rather than overwriting. */
export function setModelInstruction(userId: string, modelRef: string, baseRevision: number, rule: PromptRuleValue | null): ModelInstruction {
  tx(() => {
    if (instructionsRevision(userId) !== baseRevision) throw new HTTPException(409, { message: "Your instructions changed in another tab. Reload and try again." });
    const before = modelRule(userId, modelRef);
    if (JSON.stringify(before) === JSON.stringify(rule)) return;
    if (rule) assertStorage(userId, Buffer.byteLength(rule.text) - Buffer.byteLength(before?.text ?? ""));
    if (!rule) db.prepare("DELETE FROM user_model_instructions WHERE user_id = ? AND model_ref = ?").run(userId, modelRef);
    else {
      const revision = bumpInstructionsRevision(userId);
      db.prepare(
        `INSERT INTO user_model_instructions (user_id, model_ref, mode, text, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, model_ref) DO UPDATE SET mode = excluded.mode, text = excluded.text, revision = excluded.revision, updated_at = excluded.updated_at`,
      ).run(userId, modelRef, rule.mode, rule.text, revision, Date.now());
      return;
    }
    bumpInstructionsRevision(userId);
  });
  return getModelInstruction(userId, modelRef);
}

/** Model refs with a personal rule, so the account page can list them. */
export function listModelInstructionRefs(userId: string): string[] {
  return (db.prepare("SELECT model_ref FROM user_model_instructions WHERE user_id = ? ORDER BY model_ref").all(userId) as Array<{ model_ref: string }>)
    .map((row) => row.model_ref);
}
