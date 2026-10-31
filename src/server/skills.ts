import { Unzip, type UnzipDecoder, type AsyncFlateStreamHandler } from "fflate";
import { inflateRawSync } from "node:zlib";
import { tool, type ToolSet } from "ai";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Skill, SkillDetail, SkillFile, SkillOrigin, SkillPreferences, SkillSource, SkillSourceEntry, SkillSourceKind, SkillSourceListing } from "../shared/skills.js";
import type { AppEnv } from "./auth.js";
import { decrypt, encrypt, newId } from "./crypto.js";
import { db, tx } from "./db.js";
import { riskMetadata, scanForInjection, wrapUntrusted } from "./prompt-injection.js";
import { assertStorage } from "./quota.js";
import { fetchSkillSource, skillSourceUrl } from "./skill-fetch.js";

// Agent Skills (anthropic.dev/agent-skills) as per-account instruction packages: a SKILL.md with
// `name` + `description` frontmatter and a Markdown body, plus optional reference files. The model
// sees only the index until it calls load_skill (progressive disclosure). Sources are remote folders
// the user links; the server fetches their text verbatim and never executes any of it.

const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const MAX_BODY_CHARS = 64_000;
const MAX_FILE_CHARS = 100_000;
const MAX_FILES = 24;
/** Body + all reference files of one skill. */
const MAX_SKILL_CHARS = 300_000;
/** Everything a single account may store. */
const MAX_USER_CHARS = 2_000_000;
const MAX_SKILLS = 200;
const MAX_SOURCES = 20;
const MAX_SOURCE_ENTRIES = 40;
/** A SKILL.md is small; anything bigger is not following the format. */
const MAX_MD_BYTES = 128_000;
/** One download cap for source fetching (zips can hold many skills). */
const MAX_FETCH_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FILE_RE = /^[A-Za-z0-9][\w ./@+()'-]*$/;
const MASKED = "••••••";

const invalidConst = (message: string, status: 400 | 404 | 409): never => { throw new HTTPException(status, { message }); };
/** A function declaration so TypeScript treats thrown calls as definite exits when narrowing. */
function invalid(message: string, status: 400 | 404 | 409 | undefined = 400): never { return invalidConst(message, status); }

// ---------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------

export interface SkillMd {
  name: string;
  description: string;
  body: string;
}

/** Parses an Agent Skills `SKILL.md`: a `---` frontmatter block with `name` and `description`, then the body. */
export function parseSkillMd(text: string): SkillMd {
  const trimmed = text.trimStart();
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(trimmed);
  if (!match) invalid("This SKILL.md has no `---` frontmatter block.");
  const fields: Record<string, string> = Object.create(null);
  const lines = match![1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // Only scalar frontmatter fields are consumed; optional nested metadata is ignored.
    const m = /^([\w-]+?)\s*:\s*(.*)$/.exec(lines[i]!);
    if (!m || !m[2]!.trim()) continue;
    const value = m[2]!.trim();
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) block.push(lines[++i]!.trim());
      fields[m[1]!] = block.join(value.startsWith(">") ? " " : "\n").trim();
    } else {
      try { fields[m[1]!] = value.startsWith('"') ? JSON.parse(value) as string : value.replace(/^'(.*)'$/, "$1").replaceAll("''", "'"); }
      catch { invalid("Invalid quoted frontmatter value."); }
    }
  }
  if (!fields.name || !fields.description) invalid("This SKILL.md frontmatter needs `name` and `description`.");
  const body = trimmed.slice(match![0]!.length).trim();
  return validateSkill(fields.name, fields.description, body);
}

function validateSkill(name: string, description: string, body: string): SkillMd {
  if (description === undefined || body === undefined) invalid("A skill needs a description and instructions.");
  if (!NAME_RE.test(name) || name.length > MAX_NAME) {
    invalid(`Skill name \`${name.slice(0, 40)}\` must be lowercase kebab-case (letters, digits, dashes), at most ${MAX_NAME} characters.`);
  }
  description = description.trim();
  if (!description) invalid("A skill needs a description.");
  if (description.length > MAX_DESCRIPTION) invalid(`Skill description is longer than ${MAX_DESCRIPTION} characters.`);
  if (!body.trim()) invalid("A skill needs instructions.");
  if (body.length > MAX_BODY_CHARS) invalid(`Skill instructions are longer than ${MAX_BODY_CHARS.toLocaleString()} characters.`);
  return { name, description, body };
}

/** Relative paths only: no `..`, backslashes, or leading dots — files are text the model reads. */
export function validateSkillFileName(name: string): string {
  const path = name.replaceAll("\\", "/").trim();
  if (!path || path.length > 160) invalid("File names must be 1–160 characters.");
  if (!FILE_RE.test(path) || path.split("/").some((part) => part === ".." || part.startsWith(".") || !part)) {
    invalid(`Invalid file name \`${path.slice(0, 40)}\`. Use relative paths like \`references/api.md\`.`);
  }
  return path;
}

const fileInput = z.object({ name: z.string().min(1).max(160), content: z.string().min(1).max(MAX_FILE_CHARS) });
const skillInput = z.object({
  name: z.string().trim().min(1).max(MAX_NAME),
  description: z.string().trim().min(1).max(MAX_DESCRIPTION),
  body: z.string().trim().min(1).max(MAX_BODY_CHARS),
  files: z.array(fileInput).max(MAX_FILES).default([]),
});

/** Shared by the REST API and the model's create_skill tool. Returns the validated draft. */
export function parseSkillInput(input: unknown): { name: string; description: string; body: string; files: Array<{ name: string; content: string }> } {
  const parsed = skillInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    invalid(`${where}${issue?.message ?? "Invalid skill."}`);
  }
  const { name, description, body } = validateSkill(parsed.data.name, parsed.data.description, parsed.data.body);
  const files = parsed.data.files.map((file) => ({ name: validateSkillFileName(file.name), content: file.content }));
  if (new Set(files.map((file) => file.name)).size !== files.length) invalid("Duplicate file names in one skill.");
  return { name, description, body, files };
}

/** Binary check: skill files are text (md, json, py, sh); anything with NUL bytes is dropped. */
function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  return new TextDecoder("utf-8").decode(bytes);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function skillPreferences(userId: string): SkillPreferences {
  const row = db.prepare("SELECT enabled, revision FROM skill_preferences WHERE user_id = ?").get(userId) as { enabled: number; revision: number } | undefined;
  return { enabled: !!row?.enabled, revision: row?.revision ?? 0 };
}

export function setSkillPreferences(userId: string, patch: { enabled: boolean }): SkillPreferences {
  db.prepare(`INSERT INTO skill_preferences (user_id, enabled, revision) VALUES (?, ?, 1)
    ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, revision = revision + 1`).run(userId, Number(patch.enabled));
  return skillPreferences(userId);
}

function filesOf(skillId: string): SkillFile[] {
  return (db.prepare("SELECT name, length(content) AS chars FROM skill_files WHERE skill_id = ? ORDER BY name").all(skillId) as
    Array<{ name: string; chars: number }>).map((row) => ({ name: row.name, chars: row.chars }));
}

function toSkill(row: Record<string, unknown>, includeBody = false): Skill | SkillDetail {
  const files = filesOf(row.id as string);
  const base: Skill = {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    enabled: !!(row.enabled as number),
    origin: row.origin as SkillOrigin,
    sourceId: (row.source_id as string | null) ?? null,
    files,
    chars: (row.body as string).length + files.reduce((n, file) => n + file.chars, 0),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
  if (!includeBody) return base;
  const fileContents = db.prepare("SELECT name, content FROM skill_files WHERE skill_id = ? ORDER BY name").all(row.id as string) as
    Array<{ name: string; content: string }>;
  return { ...base, body: row.body as string, fileContents };
}

export function listSkills(userId: string): Skill[] {
  const rows = db.prepare("SELECT * FROM skills WHERE user_id = ? ORDER BY name COLLATE NOCASE").all(userId) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => toSkill(row) as Skill);
}

export function getSkill(userId: string, id: string): SkillDetail {
  const row = db.prepare("SELECT * FROM skills WHERE user_id = ? AND id = ?").get(userId, id) as Record<string, unknown> | undefined;
  if (!row) invalid("Skill not found", 404);
  return toSkill(row, true) as SkillDetail;
}

function totalChars(userId: string): number {
  const body = db.prepare("SELECT coalesce(sum(length(body)), 0) AS n FROM skills WHERE user_id = ?").get(userId) as { n: number };
  const files = db.prepare(`SELECT coalesce(sum(length(f.content)), 0) AS n FROM skill_files f
    JOIN skills s ON f.skill_id = s.id WHERE s.user_id = ?`).get(userId) as { n: number };
  return body.n + files.n;
}

interface SkillDraft {
  name: string;
  description: string;
  body: string;
  files?: Array<{ name: string; content: string }>;
}

export function saveSkill(userId: string, draft: SkillDraft, origin: SkillOrigin, sourceId?: string | null, existingId?: string): SkillDetail {
  const { name, description, body } = validateSkill(draft.name, draft.description, draft.body);
  const files = (draft.files ?? []).map((f) => ({ ...f, name: validateSkillFileName(f.name) }));
  if (files.length > MAX_FILES) invalid(`A skill can hold up to ${MAX_FILES} files.`);
  const seen = new Set<string>();
  for (const file of files) {
    const path = validateSkillFileName(file.name);
    if (seen.has(path)) invalid(`Duplicate file name \`${path}\`.`);
    seen.add(path);
  }
  const own = body.length + files.reduce((n, file) => n + file.content.length, 0);
  if (own > MAX_SKILL_CHARS) invalid(`Skills are limited to ${MAX_SKILL_CHARS.toLocaleString()} characters.`);
  const previous = existingId ? getSkill(userId, existingId) :
    (db.prepare("SELECT id FROM skills WHERE user_id = ? AND name = ?").get(userId, name) as { id: string } | undefined);
  const prev = previous ? getSkill(userId, previous.id) : undefined;
  const exists = !!prev;
  if (!prev && sourceId && !db.prepare("SELECT 1 FROM skill_sources WHERE user_id = ? AND id = ?").get(userId, sourceId)) invalid("Skill source not found", 404);
  const count = db.prepare("SELECT count(*) AS n FROM skills WHERE user_id = ?").get(userId) as { n: number };
  if (!exists && count.n >= MAX_SKILLS) {
    invalid(`You have the maximum of ${MAX_SKILLS} skills. Delete one first.`, 409);
  }
  if (files.some((file) => !file.content || file.content.length > MAX_FILE_CHARS)) invalid("Skill files must contain at most 100000 characters.");
  const released = prev ? prev.body.length + prev.fileContents.reduce((n, f) => n + f.content.length, 0) : 0;
  if (totalChars(userId) - released + own > MAX_USER_CHARS) invalid("Skill storage is full. Delete or shorten existing skills.", 409);
  const byteSize = (skill: SkillDraft) => Buffer.byteLength(skill.name + skill.description + skill.body) +
    (skill.files ?? []).reduce((n, f) => n + Buffer.byteLength(f.name + f.content), 0);
  assertStorage(userId, byteSize({ name, description, body, files }) - (prev ? byteSize({ ...prev, files: prev.fileContents }) : 0));
  const now = Date.now();
  const id = tx(() => {
    const rowId = prev?.id ?? newId("skl");
    if (prev) {
      // origin/sourceId survive updates so corrections never rewrite the provenance.
      db.prepare("UPDATE skills SET name = ?, description = ?, body = ?, updated_at = ? WHERE id = ? AND user_id = ?")
        .run(name, description, body, now, rowId, userId);
    } else {
      db.prepare(`INSERT INTO skills (id, user_id, name, description, body, enabled, origin, source_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(rowId, userId, name, description, body, origin, sourceId ?? null, now, now);
    }
    db.prepare("DELETE FROM skill_files WHERE skill_id = ?").run(rowId);
    const insert = db.prepare("INSERT INTO skill_files (skill_id, name, content) VALUES (?, ?, ?)");
    for (const file of files) insert.run(rowId, file.name, file.content);
    return rowId;
  });
  return getSkill(userId, id);
}

export function deleteSkill(userId: string, id: string): void {
  const result = db.prepare("DELETE FROM skills WHERE user_id = ? AND id = ?").run(userId, id);
  if (!result.changes) invalid("Skill not found", 404);
}

export function setSkillEnabled(userId: string, id: string, enabled: boolean): SkillDetail {
  db.prepare("UPDATE skills SET enabled = ?, updated_at = ? WHERE user_id = ? AND id = ?").run(Number(enabled), Date.now(), userId, id);
  return getSkill(userId, id);
}

/** Current-turn context section: only the index, never the full bodies (progressive disclosure). */
export function skillIndexSection(userId: string, revision: number): string {
  const prefs = skillPreferences(userId);
  if (!prefs.enabled || prefs.revision !== revision) return "";
  const rows = db.prepare("SELECT name, description FROM skills WHERE user_id = ? AND enabled = 1 ORDER BY name COLLATE NOCASE").all(userId) as
    Array<{ name: string; description: string }>;
  if (!rows.length) return "";
  const list = rows.map((row) => `- \`${row.name}\`: ${row.description}`).join("\n");
  return `# Skills\nInstalled skills are reusable instruction packages for this account. When the user's task matches one, call load_skill for it before starting and follow its instructions. Install a new one from a linked source or create one from this chat only when the user asks.\n${wrapUntrusted(list, { kind: "skill", name: "skill index" }).text}`;
}

// ---------------------------------------------------------------------------
// Source fetching. Everything is bound-checked text download; nothing fetched is ever executed.
// ---------------------------------------------------------------------------

const fetchBounded = fetchSkillSource;

async function readBounded(res: Response, max = MAX_FETCH_BYTES): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) { await res.body?.cancel(); throw new Error(`That download is ${(declared / 1024 / 1024).toFixed(0)} MB; the limit is ${(max / 1024 / 1024).toFixed(0)} MB.`); }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`That download exceeds the ${(max / 1024 / 1024).toFixed(0)} MB limit.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

interface GitHubRef {
  owner: string;
  repo: string;
  branch: string | null;
  subpath: string;
}

export function parseSourceUrl(url: string): { kind: SkillSourceKind; github: GitHubRef | null } {
  let parsed: URL;
  try { parsed = skillSourceUrl(url); } catch (error) { invalid((error as Error).message); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") invalid("Skill source URLs must be HTTP or HTTPS.");
  if (parsed.hostname === "github.com" || parsed.hostname === "www.github.com") {
    const [owner, rawRepo, ...rest] = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/").filter(Boolean);
    if (!owner || !rawRepo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(rawRepo) || owner === ".." || rawRepo === "..") invalid("GitHub URLs look like https://github.com/owner/repo.");
    let branch: string | null = null;
    let subpath = "";
    if (rest[0] === "tree" || rest[0] === "blob") {
      branch = rest[1] ?? null; // Branch names with slashes must be put in the form's branch field.
      subpath = rest.slice(2).join("/");
    }
    return { kind: "github", github: { owner, repo: rawRepo, branch, subpath } };
  }
  if (/\.md$/i.test(parsed.pathname) || (/\.zip$/i.test(parsed.pathname) && !/(^|\.)github\.com$/.test(parsed.hostname))) {
    return { kind: "raw", github: null };
  }
  invalid("Use a GitHub repo, a URL to a SKILL.md, or a URL to a .zip.");
}

const ghApi = (ref: GitHubRef, suffix: string) => `https://api.github.com/repos/${ref.owner}/${ref.repo}${suffix}`;
const ghRaw = (ref: GitHubRef, branch: string, path: string) => `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${branch.split("/").map(encodeURIComponent).join("/")}/${path.split("/").map(encodeURIComponent).join("/")}`;

/**
 * Skill folder files sit next to the SKILL.md; nested folders and other skills' files stay out.
 * A nested folder that holds its own SKILL.md is another skill, so its whole subtree is excluded.
 */
export function folderPaths(paths: string[], mdPath: string, subpath: string): string[] {
  const dir = mdPath.slice(0, mdPath.lastIndexOf("/") + 1);
  const base = (path: string) => path.split("/").pop()!.toLowerCase();
  const nestedSkillDirs = new Set(
    paths.filter((path) => path !== mdPath && base(path) === "skill.md").map((path) => path.slice(0, path.lastIndexOf("/"))),
  );
  const underNestedSkill = (path: string) => {
    let acc = "";
    for (const part of path.slice(dir.length).split("/").slice(0, -1)) {
      acc += `${acc ? "/" : ""}${part}`;
      if (nestedSkillDirs.has(`${dir}${acc}`)) return true;
    }
    return false;
  };
  return paths
    .filter((path) => path !== mdPath && base(path) !== "skill.md" && path.startsWith(dir) && path !== subpath && !underNestedSkill(path))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, MAX_FILES);
}

/** Reads one SKILL.md folder's extra files via `readText`, honoring every per-skill bound. */
async function collectSkillFiles(readText: (path: string) => Promise<string | null>, paths: string[], md: SkillMd): Promise<{ files: Array<{ name: string; content: string }>; skipped: string[] }> {
  const files: Array<{ name: string; content: string }> = [];
  const skipped: string[] = [];
  let total = md.body.length;
  for (const path of paths) {
    if (files.length >= MAX_FILES) { skipped.push(`${path} (file limit)`); continue; }
    const text = await readText(path);
    if (text === null || text.length > MAX_FILE_CHARS) { skipped.push(`${path} (binary or too large)`); continue; }
    if (total + text.length > MAX_SKILL_CHARS) { skipped.push(`${path} (skill size limit)`); continue; }
    total += text.length;
    files.push({ name: path, content: text });
  }
  return { files, skipped };
}

interface GithubListing {
  branch: string;
  tree: string[];
  entries: SkillSourceEntry[];
  errors: string[];
}

async function githubListing(ref: GitHubRef, token: string | null, signal?: AbortSignal): Promise<GithubListing> {
  let branch = ref.branch;
  if (!branch) {
    const repoRes = await fetchBounded(ghApi(ref, ""), token, signal);
    branch = (JSON.parse(new TextDecoder().decode(await readBounded(repoRes))) as { default_branch?: string }).default_branch ?? "main";
  }
  const treeRes = await fetchBounded(ghApi(ref, `/git/trees/${encodeURIComponent(branch)}?recursive=1`), token, signal);
  const parsed = JSON.parse(new TextDecoder().decode(await readBounded(treeRes))) as
    { tree?: Array<{ path: string; type: string; size?: number }>; truncated?: boolean };
  const tree = (parsed.tree ?? []).filter((node) => node.type === "blob").map((node) => node.path);
  const sizes = new Map((parsed.tree ?? []).map((node) => [node.path, node.size ?? 0]));
  const inScope = (path: string) => !ref.subpath || path === ref.subpath || path.startsWith(`${ref.subpath}/`);
  const manifests = tree
    .filter((path) => /(^|\/)SKILL\.md$/i.test(path) && inScope(path) && (sizes.get(path) ?? MAX_MD_BYTES) <= MAX_MD_BYTES)
    .slice(0, MAX_SOURCE_ENTRIES);
  const errors: string[] = [];
  if (parsed.truncated) errors.push("The repository is very large; some paths may not have been listed.");
  const gh: GitHubRef = { ...ref, branch };
  const readManifest = async (path: string): Promise<SkillMd> => {
    const res = await fetchBounded(ghRaw(gh, branch, path), token, signal);
    const text = decodeText(await readBounded(res, MAX_MD_BYTES));
    if (text === null) throw new Error(`${path} is not text`);
    return parseTextOrThrow(text, path);
  };
  const entries: SkillSourceEntry[] = [];
  const batch = 5;
  for (let i = 0; i < manifests.length; i += batch) {
    const slice = manifests.slice(i, i + batch);
    const results = await Promise.allSettled(slice.map(readManifest));
    results.forEach((result, j) => {
      if (result.status === "rejected") {
        errors.push(String((result.reason as Error).message).replace(/^(\w+Exception|Error): /, ""));
        return;
      }
      entries.push({ name: result.value.name, description: result.value.description, path: slice[j]! });
    });
  }
  return { branch, tree, entries, errors };
}

function parseTextOrThrow(text: string, path: string): SkillMd {
  try {
    return parseSkillMd(text);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Drafts from downloaded bytes (raw SKILL.md URLs and .zip sources)
// ---------------------------------------------------------------------------

interface ZippedDraft extends SkillDraft {
  path: string;
  skipped?: string[];
}

// fflate's default synchronous decoder trusts ZIP size headers. zlib also limits actual output,
// so a malicious archive cannot bypass expansion limits by lying about its uncompressed sizes.
class BoundedSkillInflate implements UnzipDecoder {
  static compression = 8;
  ondata!: AsyncFlateStreamHandler;
  private chunks: Uint8Array[] = [];
  constructor(private readonly name: string) {}
  push(chunk: Uint8Array, final: boolean) {
    this.chunks.push(chunk);
    if (!final) return;
    let data: Uint8Array<ArrayBuffer>;
    try { data = inflateRawSync(Buffer.concat(this.chunks), { maxOutputLength: /(^|\/)SKILL\.md$/i.test(this.name) ? MAX_MD_BYTES : MAX_FILE_CHARS * 4 }); }
    catch { invalid("ZIP exceeds a file expansion limit or is corrupt."); }
    this.chunks = [];
    this.ondata(null, data, true);
  }
}

function unpackSkillZip(bytes: Uint8Array, skipped: string[]): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = Object.create(null);
  let expanded = 0;
  let declared = 0;
  let count = 0;
  const archive = new Unzip((file) => {
    if (++count > 2000 || (declared += file.originalSize ?? 0) > MAX_FETCH_BYTES) invalid("ZIP exceeds the 20 MB expanded size or 2000 entry limit.");
    if (file.name.endsWith("/")) return;
    try { validateSkillFileName(file.name); } catch { skipped.push(`${file.name.slice(0, 160)} (invalid path)`); return; }
    const max = /(^|\/)SKILL\.md$/i.test(file.name) ? MAX_MD_BYTES : MAX_FILE_CHARS * 4;
    if ((file.originalSize ?? 0) > max) { skipped.push(`${file.name} (too large)`); return; }
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (error) invalid(error.message);
      size += chunk.length;
      expanded += chunk.length;
      if (size > max || expanded > MAX_FETCH_BYTES) invalid("ZIP exceeds its expanded size limit.");
      chunks.push(chunk);
      if (final) entries[file.name] = Buffer.concat(chunks, size);
    };
    file.start();
  });
  archive.register(BoundedSkillInflate);
  archive.push(bytes, true);
  return entries;
}

async function draftsFromBytes(bytes: Uint8Array, filename: string): Promise<{ drafts: ZippedDraft[]; skipped: string[] }> {
  const skipped: string[] = [];
  if (/\.zip$/i.test(filename)) {
    let entries: Record<string, Uint8Array> = {};
    try { entries = unpackSkillZip(bytes, skipped); }
    catch (error) {
      if (error instanceof HTTPException) throw error;
      invalid("That .zip could not be unpacked.");
    }
    const names = Object.keys(entries);
    const manifests = names.filter((name) => /(^|\/)SKILL\.md$/i.test(name) && entries[name]!.length <= MAX_MD_BYTES).slice(0, MAX_SOURCE_ENTRIES);
    if (!manifests.length) invalid("No SKILL.md found in this .zip.");
    const drafts: ZippedDraft[] = [];
    for (const manifest of manifests) {
      const text = decodeText(entries[manifest]!);
      if (text === null) { skipped.push(`${manifest} (binary)`); continue; }
      let md: SkillMd;
      try {
        md = parseSkillMd(text);
      } catch (error) {
        skipped.push(String((error as Error).message));
        continue;
      }
      const dir = manifest.replace(/SKILL\.md$/i, "");
      const paths = folderPaths(names, manifest, "");
      const { files, skipped: fileNotes } = await collectZipFiles(entries, paths, md);
      skipped.push(...fileNotes);
      drafts.push({ ...md, files: files.map((f) => ({ ...f, name: f.name.slice(dir.length) })), path: manifest });
    }
    if (!drafts.length) invalid("This .zip has SKILL.md files, but none of them parse.");
    return { drafts, skipped };
  }
  const text = decodeText(bytes);
  if (text === null) invalid("That file is not readable text.");
  return { drafts: [{ ...parseSkillMd(text), files: [], path: "SKILL.md" }], skipped };
}

/** Shared file-collection for the zip path (same rules as the GitHub install path). */
function collectZipFiles(
  entries: Record<string, Uint8Array>,
  paths: string[],
  md: SkillMd,
): Promise<{ files: Array<{ name: string; content: string }>; skipped: string[] }> {
  return collectSkillFiles(async (path) => decodeText(entries[path]!), paths, md);
}

// ---------------------------------------------------------------------------
// Source records
// ---------------------------------------------------------------------------

interface SourceRow {
  id: string;
  user_id: string;
  name: string;
  kind: SkillSourceKind;
  url: string;
  branch: string | null;
  subpath: string | null;
  token_enc: string | null;
  created_at: number;
}

const toSource = (row: SourceRow): SkillSource => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  url: row.url,
  branch: row.branch,
  subpath: row.subpath,
  hasToken: !!row.token_enc,
  createdAt: row.created_at,
});

function refOf(source: Pick<SkillSource, "url" | "kind" | "branch" | "subpath">): GitHubRef {
  if (source.kind !== "github") invalid("That source is not a GitHub repository.");
  const { github } = parseSourceUrl(source.url);
  return {
    owner: github!.owner,
    repo: github!.repo,
    branch: source.branch ?? github!.branch,
    subpath: source.subpath ?? github!.subpath ?? "",
  };
}

export function listSources(userId: string): SkillSource[] {
  return (db.prepare("SELECT * FROM skill_sources WHERE user_id = ? ORDER BY created_at").all(userId) as unknown as SourceRow[]).map(toSource);
}

/** `ref` is a source id or its (case-insensitive) name. */
function findSource(userId: string, ref: string): SourceRow {
  const row = db.prepare("SELECT * FROM skill_sources WHERE user_id = ? AND (id = ? OR lower(name) = lower(?))").get(userId, ref, ref) as SourceRow | undefined;
  if (!row) invalid("Skill source not found", 404);
  return row;
}

const tokenOf = (row: SourceRow) => (row.token_enc ? decrypt(row.token_enc) : null);

const sourceInput = z.object({
  name: z.string().trim().max(40).regex(/^[\w .-]+$/, "Letters, numbers, spaces, dot, dash").optional(),
  url: z.string().trim().min(1).max(2000),
  branch: z.string().trim().max(120).optional(),
  subpath: z.string().trim().max(300).optional(),
  token: z.string().trim().max(200).optional(),
});

/**
 * Creates or updates a source. For GitHub URLs, branch/subpath in the URL fill the defaults and
 * the explicit fields win. An omitted or masked token keeps the stored one, an empty one clears it.
 */
export function saveSource(userId: string, input: unknown, id?: string): SkillSource {
  const parsed = sourceInput.safeParse(input);
  if (!parsed.success) invalid(parsed.error.issues[0]?.message ?? "Invalid skill source.");
  let { name, url, branch, subpath, token } = parsed.data;
  const { kind, github } = parseSourceUrl(url.trim());
  url = url.trim();
  if (token && token !== MASKED && new URL(url).protocol !== "https:") invalid("Tokens require an HTTPS skill source.");
  const branchFinal = kind === "github" ? ((branch ?? "") || github!.branch) || null : null;
  const subpathFinal = kind === "github" ? ((subpath ?? "") || github!.subpath) || null : null;
  if (kind === "github") {
    name = name || `${github!.owner}/${github!.repo}`;
  } else {
    name = name || `${new URL(url).hostname.replace(/^www\./, "")}/${new URL(url).pathname.split("/").pop() ?? ""}`.replace(/\.(zip|md)$/i, "");
  }
  if (!name) invalid("Give the source a name.");
  const dup = db.prepare("SELECT id FROM skill_sources WHERE user_id = ? AND name = ?").get(userId, name) as { id: string } | undefined;
  if (dup && dup.id !== id) invalid("A source with that name exists.", 409);
  const subpathStored = subpathFinal ? subpathFinal.replace(/^\/+|\/+$/g, "") : null;
  if (id) {
    if (!db.prepare("SELECT 1 FROM skill_sources WHERE user_id = ? AND id = ?").get(userId, id)) invalid("Skill source not found", 404);
    const stored = db.prepare("SELECT token_enc, url FROM skill_sources WHERE id = ? AND user_id = ?").get(id, userId) as { token_enc: string | null; url: string };
    const keep = (token === undefined || token === MASKED) && new URL(stored.url).origin === new URL(url).origin;
    db.prepare("UPDATE skill_sources SET name = ?, kind = ?, url = ?, branch = ?, subpath = ?, token_enc = ? WHERE id = ? AND user_id = ?")
      .run(name, kind, url, branchFinal, subpathStored, keep ? stored.token_enc : (token && token !== MASKED ? encrypt(token) : null), id, userId);
  } else {
    if (listSources(userId).length >= MAX_SOURCES) invalid(`You have the maximum of ${MAX_SOURCES} skill sources. Remove one first.`, 409);
    db.prepare("INSERT INTO skill_sources (id, user_id, name, kind, url, branch, subpath, token_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(newId("skls"), userId, name, kind, url, branchFinal, subpathStored, token ? encrypt(token) : null, Date.now());
  }
  return toSource(findSource(userId, name));
}

export function deleteSource(userId: string, id: string): void {
  tx(() => {
    const result = db.prepare("DELETE FROM skill_sources WHERE user_id = ? AND id = ?").run(userId, id);
    if (!result.changes) invalid("Skill source not found", 404);
    db.prepare("UPDATE skills SET source_id = NULL WHERE user_id = ? AND source_id = ?").run(userId, id);
  });
}

/** Lists every installable skill of one stored source without installing anything. */
export async function listSkillsInSource(userId: string, source: SkillSource, signal?: AbortSignal): Promise<SkillSourceListing> {
  const row = findSource(userId, source.id);
  const token = tokenOf(row);
  try {
    if (row.kind === "github") {
      const listing = await githubListing(refOf(toSource(row)), token, signal);
      return { source, entries: listing.entries, errors: listing.errors };
    }
    const res = await fetchBounded(row.url, token, signal);
    const bytes = await readBounded(res);
    const { drafts } = await draftsFromBytes(bytes, new URL(row.url).pathname);
    return { source, entries: drafts.map(({ name, description, path }) => ({ name, description, path })), errors: [] };
  } catch (error) {
    return { source, entries: [], errors: [(error as Error).message] };
  }
}

/**
 * Fetches one skill folder from a stored source and upserts it under its SKILL.md name.
 * This is the shared path of the model's install_skill tool and the Skills page install button.
 */
export async function installSkillFromSource(userId: string, sourceRef: string, entryName: string, signal?: AbortSignal, beforeSave?: () => void): Promise<{ skill: SkillDetail; skipped: string[] }> {
  const row = findSource(userId, sourceRef);
  const source = toSource(row);
  const token = tokenOf(row);
  let draft: SkillDraft;
  let skipped: string[] = [];
  if (source.kind === "github") {
    const ref = refOf(source);
    const listing = await githubListing(ref, token, signal);
    const hit = listing.entries.find((entry) => entry.name.toLowerCase() === entryName.toLowerCase());
    if (!hit) invalid(`\`${entryName}\` is not in this source. Refresh its list first.`, 404);
    const gh: GitHubRef = { ...ref, branch: listing.branch };
    const res = await fetchBounded(ghRaw(gh, listing.branch, hit.path), token, signal);
    const md = parseTextOrThrow(decodeText(await readBounded(res, MAX_MD_BYTES)) ?? "", hit.path);
    const { files, skipped: notes } = await collectSkillFiles(
      async (path) => {
        try { return decodeText(await readBounded(await fetchBounded(ghRaw(gh, listing.branch, path), token, signal), MAX_FILE_CHARS * 4)); }
        catch (error) { if (signal?.aborted) throw error; return null; }
      },
      folderPaths(listing.tree, hit.path, ref.subpath),
      md,
    );
    skipped = notes;
    const dir = hit.path.slice(0, hit.path.lastIndexOf("/") + 1);
    draft = { ...md, files: files.map((f) => ({ ...f, name: f.name.slice(dir.length) })) };
  } else {
    const res = await fetchBounded(row.url, token, signal);
    const { drafts, skipped: notes } = await draftsFromBytes(await readBounded(res), new URL(source.url).pathname);
    skipped = notes;
    draft = drafts.find((candidate) => candidate.name.toLowerCase() === entryName.toLowerCase())
      ?? (drafts.length === 1 ? drafts[0]! : invalid(`\`${entryName}\` is not in this source. Refresh its list first.`, 404));
  }
  const existing = db.prepare("SELECT origin, source_id FROM skills WHERE user_id = ? AND lower(name) = lower(?)").get(userId, draft.name) as
    { origin: SkillOrigin; source_id: string | null } | undefined;
  beforeSave?.();
  const skill = saveSkill(userId, draft, existing?.origin ?? "source", existing?.source_id ?? source.id);
  return { skill, skipped };
}

// ---------------------------------------------------------------------------
// Model tools
// ---------------------------------------------------------------------------

interface TurnSkills {
  /** Dynamic index injected near the latest user message, never into the system prefix. */
  context: string;
  tools: ToolSet;
  /** Read-only subset handed to delegates; empty unless skills are on. */
  subTools: ToolSet;
}

const EMPTY_TURN: TurnSkills = { context: "", tools: {}, subTools: {} };

/**
 * Builds everything a turn needs from skills. Temporary chats (`temporary`) and models that
 * cannot call tools get nothing. Mutating tools are offered only in the main set; delegates only
 * receive the read-only pair. Every execution re-checks the preferences, so turning skills off
 * revokes tools a running model still holds.
 */
export function turnSkills(userId: string, opts: { temporary: boolean; canCallTools: boolean }): TurnSkills {
  if (opts.temporary || !opts.canCallTools) return EMPTY_TURN;
  const prefs = skillPreferences(userId);
  if (!prefs.enabled) return EMPTY_TURN;
  const indexRevision = prefs.revision;
  const allowed = () => {
    const current = skillPreferences(userId);
    return current.enabled && current.revision === indexRevision;
  };
  const canUse = () => { if (!allowed()) invalid("Skills were disabled. Continue without them until the next reply.", 409); };
  const enabledByName = (name: string): SkillDetail | undefined => {
    const row = db.prepare("SELECT * FROM skills WHERE user_id = ? AND lower(name) = lower(?) AND enabled = 1").get(userId, name) as Record<string, unknown> | undefined;
    return row ? (toSkill(row, true) as SkillDetail) : undefined;
  };

  const readTools: ToolSet = {
    load_skill: tool({
      description: "Load one of the user's installed skills by name. Returns the skill's full instructions and its list of extra files. Load a skill before doing a task it matches; the skill index in this conversation lists the names that exist.",
      inputSchema: z.object({ name: z.string().min(1).max(80) }),
      execute: async ({ name }) => {
        canUse();
        const skill = enabledByName(name);
        if (!skill) invalid(`No enabled skill named \`${name}\`. Check the skill index for the exact names.`, 404);
        const output = {
          name: skill!.name,
          description: skill!.description,
          instructions: skill!.body,
          files: skill!.files.map((file) => file.name),
          hint: skill!.files.length ? `Call read_skill_file with name "${skill!.name}" to read one of these files.` : undefined,
        };
        const injection = scanForInjection(JSON.stringify(output));
        return { ...output, ...(injection.flagged ? { injection } : {}) };
      },
      // A skill is user-installed guidance, but its body and file names are still third-party text. The
      // whole useful object (including the hint) is quoted in one envelope, so names cannot add lines.
      toModelOutput: ({ output }) => ({
        type: "text",
        value: wrapUntrusted(
          JSON.stringify({ name: output.name, description: output.description, instructions: output.instructions, files: output.files, hint: output.hint }),
          { kind: "skill", name: output.name },
        ).text,
      }),
    }),
    read_skill_file: tool({
      description: "Read one extra file inside an installed skill (a path returned by load_skill).",
      inputSchema: z.object({ name: z.string().min(1).max(80), file: z.string().min(1).max(160) }),
      execute: async ({ name, file }) => {
        canUse();
        const skill = enabledByName(name);
        if (!skill) invalid(`No enabled skill named \`${name}\`.`, 404);
        const path = validateSkillFileName(file);
        const row = db.prepare("SELECT content FROM skill_files WHERE skill_id = ? AND name = ?").get(skill!.id, path) as { content: string } | undefined;
        if (!row) invalid(`\`${skill!.name}\` has no file \`${path}\`. Available: ${skill!.files.map((f) => `\`${f.name}\``).join(", ") || "none"}.`, 404);
        const output = { name: skill!.name, file: path, content: row.content };
        const injection = scanForInjection(JSON.stringify(output));
        return { ...output, ...(injection.flagged ? { injection } : {}) };
      },
      toModelOutput: ({ output }) => ({
        type: "text",
        value: wrapUntrusted(JSON.stringify({ name: output.name, file: output.file, content: output.content }), { kind: "skill", name: `${output.name}/${output.file}` }).text,
      }),
    }),
  };

  const mutating: ToolSet = {
    search_skill_sources: tool({
      description: "List the skills installable from the user's linked skill sources (GitHub repos, SKILL.md or .zip URLs). Call this before install_skill; it returns each source's entries and their paths.",
      inputSchema: z.object({}),
      execute: async () => {
        canUse();
        const sources = listSources(userId);
        const listings = await Promise.allSettled(sources.map((source) => listSkillsInSource(userId, source)));
        const result = {
          sources: listings.map((entry, i) => {
            if (entry.status === "rejected") return { source: sources[i]!.name, sourceId: sources[i]!.id, error: String((entry.reason as Error).message) };
            return entry.value;
          }),
        };
        const injection = scanForInjection(JSON.stringify(result));
        return { ...result, ...(injection.flagged ? { injection } : {}) };
      },
      toModelOutput: ({ output }) => ({
        type: "text",
        value: wrapUntrusted(JSON.stringify(output.sources), { kind: "skill", name: "installable skill sources" }).text,
      }),
    }),
    install_skill: tool({
      description: "Install one skill from a linked skill source after search_skill_sources listed it. Copies that SKILL.md and its extra files from the source; replacing an installed skill of the same name.",
      inputSchema: z.object({
        source: z.string().min(1).max(80).describe("Source name or id, as search_skill_sources reported"),
        skill: z.string().min(1).max(120).describe("The entry `name` to install"),
      }),
      metadata: riskMetadata("persistent"),
      needsApproval: true,
      execute: async ({ source, skill }) => {
        canUse();
        const { skill: installed, skipped } = await installSkillFromSource(userId, source, skill, undefined, canUse);
        const output = { id: installed.id, name: installed.name, description: installed.description, files: installed.files.map((file) => file.name), skipped };
        const injection = scanForInjection(JSON.stringify(output));
        return { ...output, ...(injection.flagged ? { injection } : {}) };
      },
      toModelOutput: ({ output }) => {
        const { injection: _injection, ...installed } = output;
        return { type: "text", value: wrapUntrusted(JSON.stringify(installed), { kind: "skill", name: output.name }).text };
      },
    }),
    create_skill: tool({
      description: `Create or update one of the user's skills from content you write (for example when asked to save this chat as a skill). The \`description\` is the one sentence the skill index shows every future chat. ${MAX_NAME}-char kebab-case names, at most ${MAX_FILES} extra files.`,
      inputSchema: z.object({
        name: z.string().trim().min(1).max(MAX_NAME).describe("lowercase-kebab-case, e.g. release-notes-style"),
        description: z.string().trim().min(1).max(MAX_DESCRIPTION).describe('One sentence: what it does and when to use it, e.g. "Formats release notes in the user\'s house style. Use when writing changelogs."'),
        instructions: z.string().trim().min(1).max(MAX_BODY_CHARS).describe("Full instructions in Markdown — steps, conventions, context a future conversation needs. No YAML frontmatter; the fields above are it."),
        files: z.array(z.object({ name: z.string().min(1).max(160), content: z.string().min(1).max(MAX_FILE_CHARS) })).max(MAX_FILES).optional().describe("Optional reference files or templates the skill reuses"),
      }),
      metadata: riskMetadata("persistent"),
      needsApproval: true,
      execute: async (input) => {
        canUse();
        const { name, description, instructions, files } = input as { name: string; description: string; instructions: string; files?: Array<{ name: string; content: string }> };
        const skill = saveSkill(userId, parseSkillInput({ name, description, body: instructions, files }), "conversation");
        return { id: skill.id, name: skill.name, description: skill.description, files: skill.files.map((file) => file.name) };
      },
    }),
  };

  return {
    context: skillIndexSection(userId, indexRevision),
    tools: { ...readTools, ...mutating },
    subTools: readTools,
  };
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

export const skillRoutes = new Hono<AppEnv>()
  .use(bodyLimit({ maxSize: MAX_UPLOAD_BYTES * 2 }))
  .use(async (c, next) => { c.header("Cache-Control", "no-store"); await next(); })
  // Static paths first: Hono matches in registration order, and /:id would otherwise
  // swallow /prefs and /sources.
  .get("/prefs", (c) => c.json(skillPreferences(c.get("user").id)))
  .patch("/prefs", async (c) => {
    const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid skill preferences" }, 400);
    return c.json(setSkillPreferences(c.get("user").id, parsed.data));
  })
  .get("/sources", (c) => c.json(listSources(c.get("user").id)))
  .post("/sources", async (c) => c.json(saveSource(c.get("user").id, await c.req.json().catch(() => null))))
  .put("/sources/:id", async (c) => c.json(saveSource(c.get("user").id, await c.req.json().catch(() => null), c.req.param("id"))))
  .delete("/sources/:id", (c) => {
    deleteSource(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .get("/sources/:id/skills", async (c) => {
    const userId = c.get("user").id;
    const row = findSource(userId, c.req.param("id"));
    return c.json(await listSkillsInSource(userId, toSource(row), c.req.raw.signal));
  })
  .post("/sources/:id/install", async (c) => {
    const userId = c.get("user").id;
    const parsed = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Choose a skill to install." }, 400);
    const { skill, skipped } = await installSkillFromSource(userId, c.req.param("id"), parsed.data.name, c.req.raw.signal);
    return c.json({ ...skill, skipped });
  })
  .get("/", (c) => c.json(listSkills(c.get("user").id)))
  .post("/", async (c) => c.json(saveSkill(c.get("user").id, parseSkillInput(await c.req.json().catch(() => null)), "manual")))
  .post("/import", async (c) => {
    const userId = c.get("user").id;
    const file = (await c.req.formData()).get("file");
    if (!(file instanceof File)) return c.json({ error: "No file" }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: "File is larger than 10 MB" }, 413);
    const { drafts, skipped } = await draftsFromBytes(new Uint8Array(await file.arrayBuffer()), file.name);
    const seen = new Set<string>();
    const installed = tx(() => drafts
      .filter((draft) => { const key = draft.name.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; })
      .map((draft) => saveSkill(userId, draft, "manual")));
    return c.json({ installed, skipped });
  })
  .get("/:id", (c) => c.json(getSkill(c.get("user").id, c.req.param("id"))))
  .put("/:id", async (c) => {
    const userId = c.get("user").id;
    const existing = getSkill(userId, c.req.param("id"));
    const draft = parseSkillInput(await c.req.json().catch(() => null));
    if (draft.name !== existing.name && db.prepare("SELECT 1 FROM skills WHERE user_id = ? AND name = ?").get(userId, draft.name)) {
      invalid("A skill with that name exists.", 409);
    }
    saveSkill(userId, draft, existing.origin, existing.sourceId, existing.id);
    return c.json(getSkill(userId, existing.id));
  })
  .patch("/:id", async (c) => {
    const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid skill settings" }, 400);
    return c.json(setSkillEnabled(c.get("user").id, c.req.param("id"), parsed.data.enabled));
  })
  .delete("/:id", (c) => {
    deleteSkill(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  });
