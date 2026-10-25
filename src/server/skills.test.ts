import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { ToolSet } from "ai";
import { strToU8, zipSync } from "fflate";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-skills-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "skills-test-secret-only-not-for-production";
const { db } = await import("./db.js");
const { requireUser } = await import("./auth.js");
const { decrypt, sha256 } = await import("./crypto.js");
const {
  parseSkillMd,
  parseSourceUrl,
  folderPaths,
  validateSkillFileName,
  skillPreferences,
  skillIndexSection,
  setSkillPreferences,
  turnSkills,
  saveSkill,
  saveSource,
  skillRoutes,
} = await import("./skills.js");
const app = new Hono().use(requireUser).route("/skills", skillRoutes);
for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
}
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => {
  db.exec("DELETE FROM skills; DELETE FROM skill_files; DELETE FROM skill_sources; DELETE FROM skill_preferences;");
});

const D = "Does a thing. Use when the user asks for that thing.";

const SKILL_MD = `---
name: python-upgrade
description: "Runs the team's Python dependency upgrade checklist. Use when upgrading packages."
---
# Upgrade checklist

1. Pin the versions.
2. Run the test suite.
`;

const request = (method: string, route = "", body?: unknown, user = "alice") => app.request(`http://app/skills${route}`, {
  method, headers: { cookie: `okaychat_session=${user}`, "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const insertRawSkill = (userId: string, name: string, description: string) =>
  db.prepare("INSERT INTO skills (id, user_id, name, description, body, enabled, origin, source_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'B', 1, 'manual', NULL, 1, 1)").run(`skl-${userId}-${name}`, userId, name, description);

async function execute(tools: ToolSet, name: string, input: unknown = {}): Promise<any> {
  const run = tools[name]?.execute;
  assert.ok(run, `${name} should be available`);
  return run(input, { toolCallId: `test-${name}`, messages: [] });
}

// ---------------------------------------------------------------- parsing

test("parseSkillMd reads plain and quoted frontmatter and trims the body", () => {
  const parsed = parseSkillMd(SKILL_MD);
  assert.equal(parsed.name, "python-upgrade");
  assert.equal(parsed.description, "Runs the team's Python dependency upgrade checklist. Use when upgrading packages.");
  assert.ok(parsed.body.startsWith("# Upgrade checklist"));
  const quoted = parseSkillMd('---\nname: "quoted-name"\ndescription: Single\n---\nBody only.');
  assert.equal(quoted.name, "quoted-name");
});

test("parseSkillMd rejects malformed frontmatter, bad names, and oversized content", () => {
  for (const text of ["no frontmatter", "---\nname: only-name\n---\nBody", "---\ndescription: only-desc\n---\nBody", "---\nname:\ndescription: x\n---\nBody"]) {
    assert.throws(() => parseSkillMd(text), /frontmatter|needs `name`/, `should reject: ${text.slice(0, 30)}`);
  }
  assert.throws(() => parseSkillMd("---\nname: UPPERCASE\ndescription: x\n---\nBody"), /kebab-case/);
  assert.throws(() => parseSkillMd(`---\nname: ${"a".repeat(65)}\ndescription: x\n---\nBody`), /kebab-case/);
  assert.throws(() => parseSkillMd("---\nname: ok-name\ndescription: x\n---\n" + "b".repeat(65_000)), /longer than/);
});

test("file names must be relative and free of traversal", () => {
  assert.equal(validateSkillFileName("references/api.md"), "references/api.md");
  assert.equal(validateSkillFileName("a\\b.md"), "a/b.md");
  for (const bad of ["../escape.md", "a/../../b", "/abs.md", ".hidden", "a/", "", "a//b.md"]) {
    assert.throws(() => validateSkillFileName(bad), /Invalid file name|1–160/, `should reject: ${bad}`);
  }
});

test("folderPaths keeps the skill's own files but not nested skills", () => {
  const tree = ["SKILL.md", "notes.md", "skills/python/SKILL.md", "skills/python/deps.md", "skills/python/nested/SKILL.md", "skills/rust/SKILL.md", "skills/rust/tool.md", "readme.md"];
  assert.deepEqual(folderPaths(tree, "skills/python/SKILL.md", ""), ["skills/python/deps.md"]);
  // A source whose skills live at the root keeps only the loose root files.
  assert.deepEqual(folderPaths(tree, "SKILL.md", ""), ["notes.md", "readme.md"]);
});

test("parseSourceUrl understands repos, tree URLs, and raw files", () => {
  assert.deepEqual(parseSourceUrl("https://github.com/anthropics/skills"), {
    kind: "github", github: { owner: "anthropics", repo: "skills", branch: null, subpath: "" },
  });
  assert.deepEqual(parseSourceUrl("https://github.com/anthropics/skills/tree/main/artifacts-builder"), {
    kind: "github", github: { owner: "anthropics", repo: "skills", branch: "main", subpath: "artifacts-builder" },
  });
  assert.equal(parseSourceUrl("https://example.com/pack.zip").kind, "raw");
  assert.equal(parseSourceUrl("https://raw.githubusercontent.com/anthropics/skills/main/x/SKILL.md").kind, "raw");
  for (const bad of ["not a url", "ftp://example.com/x.md", "https://example.com/folder"]) {
    assert.throws(() => parseSourceUrl(bad), /valid URL|HTTP or HTTPS|GitHub repo|\.zip/, `should reject ${bad}`);
  }
});

// ---------------------------------------------------------------- REST + storage

test("creating, listing, viewing, editing, and deleting are account-scoped and validated", async () => {
  const created = await (await request("POST", "", { name: "python-upgrade", description: D, body: "Steps here." })).json();
  assert.equal(created.name, "python-upgrade");
  assert.equal(created.origin, "manual");
  for (const body of [
    { name: "Bad Name!", description: D, body: "x" },
    { name: "other-name", description: D, body: "x", files: [{ name: "../escape", content: "x" }] },
    { name: "big-name", description: D, body: "b".repeat(65_000) },
    { name: "dupe-file", description: D, body: "x", files: [{ name: "a.md", content: "x" }, { name: "a.md", content: "y" }] },
  ]) {
    assert.equal((await request("POST", "", body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  // bob cannot see, change, or delete alice's skill.
  assert.equal((await (await request("GET", "", undefined, "bob")).json()).length, 0);
  assert.equal((await request("GET", `/${created.id}`, undefined, "bob")).status, 404);
  for (const [method, body] of [
    ["PUT", { name: "steal-name", description: D, body: "x" }],
    ["PATCH", { enabled: true }],
    ["DELETE", undefined],
  ] as const) {
    const res = await request(method, `/${created.id}`, body, "bob");
    assert.equal(res.status, 404, `${method} as bob`);
  }
  // Updates keep origin and can add files; renaming to an existing name conflicts.
  const updated = await (await request("PUT", `/${created.id}`, { name: "python-upgrade", description: D, body: "Better steps.", files: [{ name: "references/deps.md", content: "pin it" }] })).json();
  assert.equal(updated.body, "Better steps.");
  assert.equal(updated.origin, "manual");
  assert.deepEqual(updated.files, [{ name: "references/deps.md", chars: "pin it".length }]);
  assert.equal(updated.fileContents[0].content, "pin it");
  await request("POST", "", { name: "other-name", description: D, body: "x" });
  assert.equal((await request("PUT", `/${created.id}`, { name: "other-name", description: D, body: "x" })).status, 409);
  // Upsert by name: creating the same name again updates instead of duplicating.
  await request("POST", "", { name: "python-upgrade", description: "New sentence.", body: "New body." });
  const list = await (await request("GET", "")).json();
  assert.equal(list.length, 2);
  assert.equal(list.find((s: { name: string }) => s.name === "python-upgrade").description, "New sentence.");
  assert.equal((await request("DELETE", `/${created.id}`)).status, 200);
  assert.equal((await (await request("GET", "")).json()).length, 1);
  // Unauthenticated requests get 401 like every other API call.
  assert.equal((await app.request("http://app/skills")).status, 401);
});

test("per-skill file and size bounds are enforced", async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `f${i}.md`, content: "x" }));
  assert.equal((await request("POST", "", { name: "many-files", description: D, body: "x", files: many })).status, 400);
  const big = "x".repeat(100_001);
  assert.equal((await request("POST", "", { name: "big-file", description: D, body: "x", files: [{ name: "a.md", content: big }] })).status, 400);
  assert.throws(() => saveSkill("alice", { name: "over-total", description: D, body: "x", files: [{ name: "a.md", content: "x".repeat(300_000) }] }), /limited to/);
});

test("the enable toggle is per skill and the prompt index follows preferences", async () => {
  const alpha = await (await request("POST", "", { name: "alpha", description: "Alpha skill", body: "A" })).json();
  const two = await (await request("POST", "", { name: "beta", description: "Beta skill", body: "B" })).json();
  assert.ok(alpha.id && two.id);
  assert.deepEqual(skillPreferences("alice"), { enabled: false, revision: 0 });
  assert.equal(skillIndexSection("alice", 0), "", "nothing before account opt-in");
  const prefs = await (await request("PATCH", "/prefs", { enabled: true })).json();
  assert.deepEqual(prefs, { enabled: true, revision: 1 });
  assert.equal(skillIndexSection("alice", 0), "", "a stale revision yields nothing");
  let section = skillIndexSection("alice", prefs.revision);
  assert.match(section, /- `alpha`: Alpha skill/);
  assert.match(section, /- `beta`: Beta skill/);
  const disabled = await (await request("PATCH", `/${two.id}`, { enabled: false })).json();
  assert.equal(disabled.enabled, false);
  section = skillIndexSection("alice", prefs.revision);
  assert.ok(section.includes("`alpha`"));
  assert.ok(!section.includes("`beta`"), "disabled skills stay off the index");
  insertRawSkill("bob", "bobskill", "Bob skill");
  assert.ok(!skillIndexSection("alice", prefs.revision).includes("bobskill"), "other accounts never leak");
  assert.equal((await request("PATCH", "/prefs", { enabled: "yes" })).status, 400);
  await request("PATCH", "/prefs", { enabled: false });
  assert.equal(skillIndexSection("alice", prefs.revision), "", "turning skills off clears the index");
  setSkillPreferences("alice", { enabled: true });
  const reEnabled = skillIndexSection("alice", skillPreferences("alice").revision);
  assert.ok(reEnabled.includes("`alpha`"));
  assert.ok(!reEnabled.includes("`beta`"));
});

// ---------------------------------------------------------------- turn tools

const enable = async (user = "alice") => (await request("PATCH", "/prefs", { enabled: true }, user)).status === 200;

test("turn tools expose mutators only in the main set and require approval", async () => {
  await enable();
  const turn = turnSkills("alice", { temporary: false, canCallTools: true });
  for (const name of ["load_skill", "read_skill_file", "search_skill_sources", "install_skill", "create_skill"]) {
    assert.ok(turn.tools[name], name);
    assert.ok(!turn.subTools[name] || ["load_skill", "read_skill_file"].includes(name), `${name} is read-only-gated for delegates`);
  }
  assert.equal(turn.context, "", "no installed skills means no index");
  assert.deepEqual(Object.keys(turn.subTools).sort(), ["load_skill", "read_skill_file"], "delegates get read-only tools only");
  assert.equal(turn.tools.install_skill!.needsApproval, true);
  assert.equal(turn.tools.create_skill!.needsApproval, true);
  assert.notEqual(turn.tools.load_skill!.needsApproval, true);
  // Temporary chats and tool-less models get nothing even when the preference is on.
  assert.deepEqual(turnSkills("alice", { temporary: true, canCallTools: true }), { context: "", tools: {}, subTools: {} });
  assert.deepEqual(turnSkills("alice", { temporary: false, canCallTools: false }), { context: "", tools: {}, subTools: {} });
  assert.deepEqual(turnSkills("ghost-user", { temporary: false, canCallTools: true }), { context: "", tools: {}, subTools: {} });
});

test("load_skill and read_skill_file serve enabled skills of the owning user only", async () => {
  await enable();
  const mine = await (await request("POST", "", { name: "alpha", description: "Alpha", body: "Body A", files: [{ name: "notes.md", content: "N" }] })).json();
  insertRawSkill("bob", "alpha", "Bob alpha");
  setSkillPreferences("bob", { enabled: true });
  const turn = turnSkills("alice", { temporary: false, canCallTools: true });
  const loaded = await execute(turn.subTools, "load_skill", { name: "alpha" });
  assert.equal(loaded.name, "alpha");
  assert.equal(loaded.instructions, "Body A");
  assert.deepEqual(loaded.files, ["notes.md"]);
  const bobTurn = turnSkills("bob", { temporary: false, canCallTools: true });
  assert.equal((await execute(bobTurn.subTools, "load_skill", { name: "alpha" })).instructions, "B", "same name in another account stays separate");
  assert.equal((await execute(turn.subTools, "read_skill_file", { name: "alpha", file: "notes.md" })).content, "N");
  await assert.rejects(() => execute(turn.subTools, "load_skill", { name: "missing" }), /No enabled skill/);
  await assert.rejects(() => execute(turn.subTools, "read_skill_file", { name: "alpha", file: "nope.md" }), /has no file/);
  await assert.rejects(() => execute(turn.subTools, "read_skill_file", { name: "alpha", file: "../../secret.md" }), /Invalid file name/);
  // A disabled skill is not loadable.
  await request("PATCH", `/${mine.id}`, { enabled: false });
  await assert.rejects(() => execute(turn.subTools, "load_skill", { name: "alpha" }), /No enabled skill/);
});

test("create_skill stores content as a conversation skill and upserts by name", async () => {
  await enable();
  const turn = turnSkills("alice", { temporary: false, canCallTools: true });
  const first = await execute(turn.tools, "create_skill", { name: "from-chat", description: "Drafted from chat", instructions: "Keep it going.", files: [{ name: "template.md", content: "T" }] });
  assert.equal(first.name, "from-chat");
  assert.deepEqual(first.files, ["template.md"]);
  const row = db.prepare("SELECT origin FROM skills WHERE name = 'from-chat'").get() as { origin: string };
  assert.equal(row.origin, "conversation");
  await execute(turn.tools, "create_skill", { name: "from-chat", description: "Updated draft", instructions: "New body." });
  const list = await (await request("GET", "")).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].description, "Updated draft");
  assert.equal(list[0].files.length, 0, "an update without files clears old ones");
  for (const bad of [{ name: "Bad", description: D, instructions: "x" }, { name: "x", description: D, instructions: "" }]) {
    await assert.rejects(() => execute(turn.tools, "create_skill", bad), /kebab-case|Too small/);
    assert.equal((await (await request("GET", "")).json()).length, 1, "failed drafts stay out");
  }
});

test("turning skills off immediately revokes tools a running model still holds", async () => {
  await enable();
  saveSkill("alice", { name: "alpha", description: "Alpha", body: "Body" }, "manual");
  const turn = turnSkills("alice", { temporary: false, canCallTools: true });
  assert.ok((await execute(turn.tools, "load_skill", { name: "alpha" })).instructions);
  await request("PATCH", "/prefs", { enabled: false });
  for (const [name, input] of [["load_skill", { name: "alpha" }], ["install_skill", { source: "s", skill: "x" }]] as const) {
    await assert.rejects(() => execute(turn.tools, name, input), /Skills were disabled/, name);
  }
  // Re-enabling bumps the revision, so a tool captured before the off period is dead for good.
  await enable();
  await assert.rejects(() => execute(turn.tools, "load_skill", { name: "alpha" }), /Skills were disabled/);
  const fresh = turnSkills("alice", { temporary: false, canCallTools: true });
  assert.ok((await execute(fresh.tools, "load_skill", { name: "alpha" })).instructions);
});

// ---------------------------------------------------------------- sources & import

test("source records validate URLs, dedupe names, and keep tokens encrypted", () => {
  const source = saveSource("alice", { url: "https://github.com/anthropics/skills/tree/main/artifacts-builder" });
  assert.equal(source.name, "anthropics/skills");
  assert.equal(source.branch, "main");
  assert.equal(source.subpath, "artifacts-builder");
  assert.equal(source.hasToken, false);
  assert.throws(() => saveSource("alice", { url: "https://github.com/anthropics/skills" }), /name exists/, "auto name collides");
  const named = saveSource("alice", { name: "my-source", url: "https://github.com/anthropics/skills", token: "gh-test-token" });
  const before = (db.prepare("SELECT token_enc FROM skill_sources WHERE id = ?").get(named.id) as { token_enc: string }).token_enc;
  assert.ok(!before.includes("gh-test-token"), "token is stored encrypted");
  assert.equal(decrypt(before), "gh-test-token");
  const masked = saveSource("alice", { name: "my-source", url: "https://github.com/anthropics/skills", token: "••••••" }, named.id);
  const afterMask = (db.prepare("SELECT token_enc FROM skill_sources WHERE id = ?").get(named.id) as { token_enc: string }).token_enc;
  assert.equal(afterMask, before, "a masked token keeps the stored one");
  assert.equal(masked.hasToken, true);
  const cleared = saveSource("alice", { name: "my-source", url: "https://github.com/anthropics/skills", token: "" }, named.id);
  assert.equal(cleared.hasToken, false);
  for (const bad of [{ url: "https://example.com/folder" }, { url: "ftp://x/y.md" }]) {
    assert.throws(() => saveSource("alice", bad), /GitHub repo|\.zip|HTTP or HTTPS/, JSON.stringify(bad));
  }
});

test("uploading a .md or .zip installs skills with validation and binary skipping", async () => {
  const zip = zipSync({
    "skills/alpha/SKILL.md": strToU8(SKILL_MD),
    "skills/alpha/references/deps.md": strToU8("pin the deps"),
    "skills/alpha/bin.md": new Uint8Array([0, 1, 2]),
    "skills/beta/SKILL.md": strToU8("---\nname: beta-thing\ndescription: Beta skill\n---\nBeta body."),
    "skills/bad/SKILL.md": strToU8("no frontmatter"),
  });
  const form = new FormData();
  form.append("file", new Blob([zip], { type: "application/zip" }), "pack.zip");
  const res = await app.request("http://app/skills/import", { method: "POST", headers: { cookie: "okaychat_session=alice" }, body: form });
  assert.equal(res.status, 200);
  const { installed, skipped } = await res.json();
  assert.deepEqual(installed.map((s: { name: string }) => s.name).sort(), ["beta-thing", "python-upgrade"]);
  const alpha = installed.find((s: { name: string }) => s.name === "python-upgrade");
  assert.deepEqual(alpha.files, [{ name: "references/deps.md", chars: "pin the deps".length }], "binary file inside the skill folder is skipped");
  assert.ok(skipped.some((note: string) => note.includes("frontmatter")), skipped.join("|"));
  assert.ok(skipped.some((note: string) => note.includes("bin.md")), skipped.join("|"));
  // A SKILL.md upload imports one skill directly.
  const mdForm = new FormData();
  mdForm.append("file", new Blob([SKILL_MD], { type: "text/markdown" }), "SKILL.md");
  const mdRes = await app.request("http://app/skills/import", { method: "POST", headers: { cookie: "okaychat_session=alice" }, body: mdForm });
  assert.equal(mdRes.status, 200);
  assert.equal((await mdRes.json()).installed.length, 1);
  // Imports stay per-account.
  assert.equal((await (await request("GET", "", undefined, "bob")).json()).length, 0);
});

test("uploading a .zip whose SKILL.md files all fail imports nothing and says why", async () => {
  const zip = zipSync({ "a/SKILL.md": strToU8("no frontmatter"), "b/SKILL.md": strToU8("---\nname: BAD NAME\ndescription: x\n---\nBody") });
  const form = new FormData();
  form.append("file", new Blob([zip], { type: "application/zip" }), "pack.zip");
  const res = await app.request("http://app/skills/import", { method: "POST", headers: { cookie: "okaychat_session=alice" }, body: form });
  assert.equal(res.status, 400);
  assert.equal(db.prepare("SELECT count(*) AS n FROM skills WHERE user_id = 'alice'").get().n, 0);
});

test("unreachable sources report errors without throwing for listings", async () => {
  const { listSkillsInSource, listSources } = await import("./skills.js");
  saveSource("alice", { name: "dead", url: "https://127.0.0.1/pack.zip" });
  const listing = await listSkillsInSource("alice", listSources("alice")[0]!);
  assert.equal(listing.entries.length, 0);
  assert.equal(listing.errors.length, 1, `errors: ${listing.errors.join("; ")}`);
  assert.equal(listing.source.name, "dead");
});

test("static routes are not shadowed by /:id (Hono matches in registration order)", async () => {
  assert.deepEqual(await (await request("GET", "/prefs")).json(), { enabled: false, revision: 0 });
  assert.deepEqual(await (await request("GET", "/sources")).json(), []);
  const form = new FormData();
  form.append("file", new Blob(["---\nname: import-me\ndescription: Imported\n---\nBody."], { type: "text/markdown" }), "SKILL.md");
  const imported = await app.request("http://app/skills/import", { method: "POST", headers: { cookie: "okaychat_session=alice" }, body: form });
  assert.equal(imported.status, 200);
});

test("renaming edits the same skill, preserves its origin, and does not leave a duplicate", async () => {
  const original = saveSkill("alice", { name: "old-name", description: D, body: "Instructions", files: [{ name: "x.md", content: "Reference" }] }, "conversation");
  const response = await request("PUT", `/${original.id}`, { name: "new-name", description: D, body: "Revised", files: [{ name: "a\\b.md", content: "New reference" }] });
  assert.equal(response.status, 200);
  const edited = await response.json();
  assert.equal(edited.id, original.id);
  assert.equal(edited.name, "new-name");
  assert.equal(edited.origin, "conversation");
  assert.equal(edited.fileContents[0].name, "a/b.md");
  assert.equal((await (await request("GET")).json()).length, 1);
});

test("skill bodies, metadata, and references count UTF-8 bytes and deleting a skill frees quota", async () => {
  const { storageUsed } = await import("./quota.js");
  const draft = { name: "utf-skill", description: "é", body: "猫", files: [{ name: "ref.md", content: "🦊" }] };
  const bytes = Buffer.byteLength(draft.name + draft.description + draft.body + draft.files[0]!.name + draft.files[0]!.content);
  db.prepare("UPDATE users SET storage_limit = ? WHERE id = 'alice'").run(bytes);
  const skill = saveSkill("alice", draft, "manual");
  assert.equal(storageUsed("alice"), bytes);
  // Replacing the same bytes is allowed at quota; growth is rejected atomically.
  assert.equal(saveSkill("alice", draft, "manual").id, skill.id);
  const rejected = await request("PUT", `/${skill.id}`, { ...draft, body: "猫x" });
  assert.equal(rejected.status, 413);
  assert.equal((await (await request("GET", `/${skill.id}`)).json()).body, "猫");
  await enable();
  await assert.rejects(() => execute(turnSkills("alice", { temporary: false, canCallTools: true }).tools, "create_skill", { name: "new-skill", description: D, instructions: "Body" }), /Storage quota exceeded/);
  await request("DELETE", `/${skill.id}`);
  assert.equal(storageUsed("alice"), 0);
  db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'alice'").run();
});

test("ZIP imports enforce expanded-size bounds before decompressing and keep nested skills separate", async () => {
  const importZip = (entries: Record<string, Uint8Array>) => {
    const form = new FormData();
    form.set("file", new File([zipSync(entries)], "pack.zip"));
    return app.request("http://app/skills/import", { method: "POST", headers: { cookie: "okaychat_session=alice" }, body: form });
  };
  const bomb = await importZip({ "SKILL.md": strToU8(SKILL_MD), "bomb.txt": new Uint8Array(21 * 1024 * 1024) });
  assert.equal(bomb.status, 400);
  assert.match(await bomb.text(), /expanded size/);
  const response = await importZip({
    "SKILL.md": strToU8(SKILL_MD),
    "root.md": strToU8("root"),
    "nested/SKILL.md": strToU8("---\nname: nested\ndescription: Nested\n---\nBody"),
    "nested/secret.md": strToU8("child reference"),
    "../escape/SKILL.md": strToU8(SKILL_MD),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  const root = result.installed.find((s: { name: string }) => s.name === "python-upgrade");
  assert.deepEqual(root.files.map((f: { name: string }) => f.name), ["root.md"]);
  assert.ok(result.skipped.some((s: string) => s.includes("invalid path")));
});

test("a multi-skill import rolls back every write on a quota failure", async () => {
  db.prepare("UPDATE users SET storage_limit = 70 WHERE id = 'alice'").run();
  const form = new FormData();
  form.set("file", new File([zipSync({
    "a/SKILL.md": strToU8("---\nname: first\ndescription: First\n---\n" + "a".repeat(30)),
    "b/SKILL.md": strToU8("---\nname: second\ndescription: Second\n---\n" + "b".repeat(30)),
  })], "pack.zip"));
  const response = await app.request("http://app/skills/import", { method: "POST", headers: { cookie: "okaychat_session=alice" }, body: form });
  assert.equal(response.status, 413);
  assert.equal((await (await request("GET")).json()).length, 0);
  db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'alice'").run();
});

test("changing a source origin clears its saved token", () => {
  const first = saveSource("alice", { name: "source", url: "https://first.example/SKILL.md", token: "private-token" });
  const next = saveSource("alice", { name: "source", url: "https://other.example/SKILL.md" }, first.id);
  assert.equal(next.hasToken, false);
});

test("remote installs enforce quota and recheck approval revocation after downloading", async (t) => {
  const https = (await import("node:https")).default;
  const dns = (await import("node:dns/promises")).default;
  const { EventEmitter } = await import("node:events");
  const { Readable } = await import("node:stream");
  const { installSkillFromSource } = await import("./skills.js");
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  let revoke = false;
  t.mock.method(https, "request", (_url: URL, options: any, done: (response: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => options.lookup("skills.example", { all: true }, (error: Error | null) => {
      if (error) { req.emit("error", error); return; }
      if (revoke) setSkillPreferences("alice", { enabled: false });
      const response = Readable.from([Buffer.from(SKILL_MD)]);
      Object.assign(response, { statusCode: 200, headers: { "content-length": String(Buffer.byteLength(SKILL_MD)) } });
      done(response);
    });
    return req;
  });
  const source = saveSource("alice", { url: "https://skills.example/SKILL.md" });
  db.prepare("UPDATE users SET storage_limit = 1 WHERE id = 'alice'").run();
  await assert.rejects(installSkillFromSource("alice", source.id, "python-upgrade"), /Storage quota exceeded/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM skills").get()!.n, 0);
  db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'alice'").run();
  await enable();
  const tools = turnSkills("alice", { temporary: false, canCallTools: true }).tools;
  revoke = true;
  await assert.rejects(execute(tools, "install_skill", { source: source.id, skill: "python-upgrade" }), /Skills were disabled/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM skills").get()!.n, 0);
  revoke = false;
  const { skill } = await installSkillFromSource("alice", source.id, "python-upgrade");
  assert.equal(skill.name, "python-upgrade");
});

test("forged ZIP uncompressed-size headers cannot bypass the actual inflate limit", async () => {
  const zip = Buffer.from(zipSync({ "SKILL.md": strToU8(SKILL_MD), "forged.txt": new Uint8Array(2 * 1024 * 1024) }));
  // Forge both local and central-directory sizes; the actual deflate stream still expands to 2 MiB.
  for (let offset = 0; offset < zip.length - 46; offset++) {
    const signature = zip.readUInt32LE(offset);
    if (signature === 0x04034b50) zip.writeUInt32LE(1, offset + 22);
    if (signature === 0x02014b50) zip.writeUInt32LE(1, offset + 24);
  }
  const form = new FormData();
  form.set("file", new File([zip], "forged.zip"));
  const response = await app.request("http://app/skills/import", { method: "POST", headers: { cookie: "okaychat_session=alice" }, body: form });
  assert.equal(response.status, 400);
  assert.equal(db.prepare("SELECT count(*) AS n FROM skills").get()!.n, 0);
});

test("folded and literal YAML descriptions import as useful index text", () => {
  const folded = parseSkillMd("---\nname: folded\ndescription: >-\n  First sentence.\n  Use when needed.\n---\nInstructions.");
  assert.equal(folded.description, "First sentence. Use when needed.");
  const literal = parseSkillMd("---\nname: literal\ndescription: |\n  First sentence.\n  Use when needed.\n---\nInstructions.");
  assert.equal(literal.description, "First sentence.\nUse when needed.");
});

test("removing a source leaves installed skills editable and loadable", async () => {
  const source = saveSource("alice", { url: "https://example.com/SKILL.md" });
  const skill = saveSkill("alice", { name: "source-skill", description: D, body: "Instructions" }, "source", source.id);
  assert.equal((await request("DELETE", `/sources/${source.id}`)).status, 200);
  const response = await request("PUT", `/${skill.id}`, { name: "source-skill", description: D, body: "Edited" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sourceId, null);
  await enable();
  const loaded = await execute(turnSkills("alice", { temporary: false, canCallTools: true }).tools, "load_skill", { name: "source-skill" });
  assert.equal(loaded.instructions, "Edited");
});
