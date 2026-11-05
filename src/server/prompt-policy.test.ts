import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "okaychat-prompt-policy-"));
process.env.OKAYCHAT_DATA_DIR = directory;
process.env.OKAYCHAT_SECRET = "prompt-policy-test-secret-only-not-for-production";
const { db } = await import("./db.js");
const { writePromptRule } = await import("./permissions/store.js");
const { resolvePrompt, personalInstructions, setModelInstruction } = await import("./prompt-policy.js");
const { updateSettings } = await import("./settings.js");
const { serverPrompt } = await import("./prompts.js");
after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
db.exec("INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES ('u','u@test.invalid','User','unused','user',1)");
const actor = { userId: "u", modelRef: "provider/model/with/slashes" };

test("scoped prompts preserve default bytes and deterministic group order, including all and exact rules", () => {
  assert.equal(resolvePrompt("chat", actor), serverPrompt("chat"));
  db.exec("INSERT INTO user_groups (id,name,created_at,prompt_order) VALUES ('a','A',1,20),('z','Z',1,10)");
  db.exec("INSERT INTO user_group_members (user_id,group_id) VALUES ('u','a'),('u','z')");
  writePromptRule({ kind: "everyone", id: "" }, actor.modelRef, "chat", { mode: "replace", text: "base" }, null);
  writePromptRule({ kind: "group", id: "z" }, null, "chat", { mode: "append", text: "first" }, null);
  writePromptRule({ kind: "group", id: "z" }, actor.modelRef, "chat", { mode: "append", text: "exact" }, null);
  writePromptRule({ kind: "group", id: "a" }, null, "chat", { mode: "append", text: "last" }, null);
  assert.equal(resolvePrompt("chat", actor), "base\n\nfirst\n\nexact\n\nlast");
  writePromptRule({ kind: "user", id: "u" }, null, "chat", { mode: "replace", text: "" }, null);
  assert.equal(resolvePrompt("chat", actor), "");
  writePromptRule({ kind: "user", id: "u" }, actor.modelRef, "chat", { mode: "append", text: "  {unknown}  " }, null);
  assert.equal(resolvePrompt("chat", actor), "  {unknown}  ");
  assert.equal(resolvePrompt("chat", { ...actor, modelRef: "other/model" }), "");
});

test("personal instructions have independent storage, preserve whitespace, and reset cannot ABA", () => {
  const settings = updateSettings("u", { systemPrompt: "  personal  " });
  const revision = settings.instructionsRevision!;
  const saved = setModelInstruction("u", actor.modelRef, revision, { mode: "append", text: "model" });
  assert.equal(personalInstructions("u", actor.modelRef), "  personal  \n\nmodel");
  assert.equal(resolvePrompt("chat", actor), "  {unknown}  ");
  const reset = setModelInstruction("u", actor.modelRef, saved.revision, null);
  assert.ok(reset.revision > saved.revision);
  assert.throws(() => setModelInstruction("u", actor.modelRef, revision, { mode: "replace", text: "stale" }), /changed/);
});

test("placeholder filling preserves unknown tokens and document page syntax", () => {
  writePromptRule({ kind: "user", id: "u" }, null, "modelIdentity", { mode: "replace", text: "{name} / {unknown} / {page}" }, null);
  assert.equal(resolvePrompt("modelIdentity", actor, { name: "Actual" }), "Actual / {unknown} / {page}");
});
