import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PROMPT_BODY,
  MAX_PROMPT_BODY_BYTES,
  MAX_PROMPT_NAME,
  checkSavedPromptWrite,
  codePoints,
  parsePromptVariables,
  renderPromptTemplate,
  searchSavedPrompts,
  tokenizeTemplate,
  utf8Bytes,
  type SavedPrompt,
} from "./saved-prompts.js";

// The parser and validator are shared by the server (stored templates) and the web (preview and insertion),
// so these tests pin the grammar and the limits both sides must agree on.

const names = (body: string) => parsePromptVariables(body).map((variable) => variable.name);

test("variables keep their order of first appearance, deduplicate exactly, and stay case-sensitive", () => {
  assert.deepEqual(names("Summarize {{topic}} for {{audience}} and {{topic}} again"), ["topic", "audience"]);
  assert.deepEqual(names("{{Name}} and {{name}}"), ["Name", "name"]);
  assert.deepEqual(names("no variables here"), []);
  assert.deepEqual(parsePromptVariables("{{b}} {{a}} {{b}}"), [{ name: "b" }, { name: "a" }]);
});

test("one backslash escapes a variable, two give a literal backslash plus a literal variable", () => {
  // `\{{x}}` is the text `{{x}}`: the escape is consumed and no value is requested.
  assert.deepEqual(names("\\{{x}}"), []);
  assert.deepEqual(tokenizeTemplate("\\{{x}}"), [{ type: "text", text: "{{x}}" }]);
  assert.equal(renderPromptTemplate("\\{{x}}", { x: "V" }), "{{x}}");
  // The first backslash is literal, the second escapes, so the result is `\{{x}}` and still no variable.
  assert.deepEqual(names("\\\\{{x}}"), []);
  assert.equal(renderPromptTemplate("\\\\{{x}}", { x: "V" }), "\\{{x}}");
  // A backslash before ordinary text stays a backslash.
  assert.equal(renderPromptTemplate("a \\ b", {}), "a \\ b");
});

test("malformed braces and JSON stay literal", () => {
  for (const body of ["{x}", "{{ x }}", "{{1x}}", "{{x}", "x}}", "{{}}", "{{-x}}"]) {
    assert.deepEqual(names(body), [], body);
    assert.equal(renderPromptTemplate(body, { x: "V" }), body, body);
  }
  const json = '{"a":{"b":1}}';
  assert.deepEqual(names(json), []);
  assert.equal(renderPromptTemplate(json, {}), json);
  // A brace pair around a real variable is literal text on both sides of it.
  assert.deepEqual(names("{{{x}}}"), ["x"]);
  assert.equal(renderPromptTemplate("{{{x}}}", { x: "V" }), "{V}");
});

test("a 33-character name is not a variable", () => {
  const tooLong = `{{${"a".repeat(33)}}}`;
  assert.deepEqual(names(tooLong), []);
  assert.equal(renderPromptTemplate(tooLong, { ["a".repeat(33)]: "V" }), tooLong);
  const longest = `{{${"a".repeat(32)}}}`;
  assert.deepEqual(names(longest), ["a".repeat(32)]);
  assert.deepEqual(names(`{{${"a".repeat(32)}1}}`), [], "digits only continue a name, they never exceed it");
});

test("values are inserted verbatim: template syntax, replacement patterns, and newlines are never reparsed", () => {
  assert.equal(renderPromptTemplate("A {{x}} B", { x: "{{y}}" }), "A {{y}} B");
  assert.equal(renderPromptTemplate("A {{x}} B", { x: "$& $1 $` $$" }), "A $& $1 $` $$ B");
  assert.equal(renderPromptTemplate("A {{x}} B {{y}}", { x: "{{y}}", y: "second" }), "A {{y}} B second");
  assert.equal(renderPromptTemplate("{{x}}!", { x: "line 1\nline 2" }), "line 1\nline 2!");
  assert.equal(renderPromptTemplate("{{missing}}!", {}), "!", "an unfilled value becomes nothing");
});

test("length limits count Unicode code points, and the body byte limit is a second guard", () => {
  assert.equal(codePoints("😀é"), 2);
  assert.equal(utf8Bytes("😀"), 4);
  // Exactly MAX_PROMPT_BODY emoji pass the code-point rule and still fit under the byte limit.
  const fullBody = "😀".repeat(MAX_PROMPT_BODY);
  assert.equal(codePoints(fullBody), MAX_PROMPT_BODY);
  assert.ok(utf8Bytes(fullBody) <= MAX_PROMPT_BODY_BYTES);
  assert.deepEqual(checkSavedPromptWrite({ name: "Name", shortcut: "shortcut", body: fullBody }), {
    ok: true,
    value: { name: "Name", shortcut: "shortcut", body: fullBody },
  });
  assert.deepEqual(checkSavedPromptWrite({ name: "Name", shortcut: "shortcut", body: `${fullBody}😀` }), { ok: false, problem: "bodyTooLong" });
  const fullName = "😀".repeat(MAX_PROMPT_NAME);
  assert.equal(checkSavedPromptWrite({ name: fullName, shortcut: "shortcut", body: "text" }).ok, true);
  assert.deepEqual(checkSavedPromptWrite({ name: `${fullName}😀`, shortcut: "shortcut", body: "text" }), { ok: false, problem: "nameTooLong" });
});

test("20 distinct variables pass and 21 do not", () => {
  const many = (count: number) => Array.from({ length: count }, (_, i) => `{{v${i}}}`).join(" ");
  assert.equal(checkSavedPromptWrite({ name: "n", shortcut: "s", body: many(20) }).ok, true);
  assert.deepEqual(checkSavedPromptWrite({ name: "n", shortcut: "s", body: many(21) }), { ok: false, problem: "tooManyVariables" });
  // Repeating one variable never counts twice.
  assert.equal(checkSavedPromptWrite({ name: "n", shortcut: "s", body: Array.from({ length: 40 }, () => "{{same}}").join(" ") }).ok, true);
});

test("a write is normalized: trimmed name, lowercase shortcut, body untouched", () => {
  assert.deepEqual(checkSavedPromptWrite({ name: "  Hello  ", shortcut: "  /Hello-World ", body: "  keep\n\n me  " }), {
    ok: true,
    value: { name: "Hello", shortcut: "hello-world", body: "  keep\n\n me  " },
  });
  assert.deepEqual(checkSavedPromptWrite({ name: "   ", shortcut: "s", body: "text" }), { ok: false, problem: "nameRequired" });
  assert.deepEqual(checkSavedPromptWrite({ name: "n", shortcut: "hello world", body: "text" }), { ok: false, problem: "invalidShortcut" });
  assert.deepEqual(checkSavedPromptWrite({ name: "n", shortcut: "hello_world", body: "text" }), { ok: false, problem: "invalidShortcut" });
  assert.deepEqual(checkSavedPromptWrite({ name: "n", shortcut: "s".repeat(33), body: "text" }), { ok: false, problem: "invalidShortcut" });
  assert.deepEqual(checkSavedPromptWrite({ name: "n", shortcut: "s", body: " \n\t " }), { ok: false, problem: "bodyRequired" });
});

test("search puts shortcut-prefix matches first, then name matches, each by name and id", () => {
  const prompt = (id: string, name: string, shortcut: string): SavedPrompt => ({ id, name, shortcut, body: "", revision: 1, createdAt: 1, updatedAt: 1 });
  const prompts = [
    prompt("sp_2", "Bravo", "sum-b"),
    prompt("sp_1", "Alpha", "summarize"),
    prompt("sp_3", "Resume summary", "other"),
    prompt("sp_4", "Zeta", "zzz"),
    prompt("sp_5", "Alpha", "alpha"),
  ];
  const compare = (a: string, b: string) => a.localeCompare(b);
  const ids = (query: string) => searchSavedPrompts(prompts, query, compare).map((p) => p.id);
  assert.deepEqual(ids("sum"), ["sp_1", "sp_2", "sp_3"], "prefix matches first, then a name match");
  assert.deepEqual(ids("/SUM"), ["sp_1", "sp_2", "sp_3"], "the leading slash and case do not matter");
  assert.deepEqual(ids("zzz"), ["sp_4"]);
  assert.deepEqual(ids("nothing"), []);
  assert.deepEqual(ids(""), ["sp_1", "sp_5", "sp_2", "sp_3", "sp_4"], "an empty query is the whole library by name, then id");
});
