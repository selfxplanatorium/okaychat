import { tool, type ToolSet } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import type { ArtifactKind, ArtifactToolResult, ArtifactVersion } from "../shared/types.js";
import type { AppEnv } from "./auth.js";
import { db } from "./db.js";
import { getThread } from "./threads.js";

// Artifacts are versioned per thread. The model addresses them by a short id it picks, so it can edit
// them in later turns without the content being repeated in the conversation.

const KINDS = ["html", "react", "svg", "markdown", "code"] as const satisfies readonly ArtifactKind[];

export const ARTIFACT_INSTRUCTIONS = `# Artifacts
Use create_artifact for substantial, self-contained content the user will view, reuse, or iterate on: web pages, apps, components, diagrams, documents, reports, scripts over ~20 lines. Do not use it for short answers, explanations, or small snippets.
- Kinds: html (complete page, inline CSS/JS, CDN scripts allowed), react (one file, default-export a component; import from npm packages by name, Tailwind classes work), svg, markdown, code (set language).
- To change an artifact, call update_artifact with its id. Prefer small exact edits; send full content only for rewrites.
- The artifact shows in a side panel. Do not repeat its content in your reply. Summarize what you made or changed.`;

interface Row {
  id: string;
  version: number;
  title: string;
  kind: ArtifactKind;
  language: string | null;
  content: string;
  created_at: number;
}

const toVersion = (r: Row): ArtifactVersion => ({
  id: r.id,
  version: r.version,
  title: r.title,
  kind: r.kind,
  language: r.language,
  content: r.content,
  createdAt: r.created_at,
});

export function latestArtifact(threadId: string, id: string): ArtifactVersion | null {
  const row = db.prepare("SELECT * FROM artifacts WHERE thread_id = ? AND id = ? ORDER BY version DESC LIMIT 1").get(threadId, id) as Row | undefined;
  return row ? toVersion(row) : null;
}

export function artifactVersions(threadId: string, id: string): ArtifactVersion[] {
  const rows = db.prepare("SELECT * FROM artifacts WHERE thread_id = ? AND id = ? ORDER BY version").all(threadId, id) as unknown as Row[];
  return rows.map(toVersion);
}

function saveVersion(threadId: string, a: Omit<ArtifactVersion, "version" | "createdAt">): ArtifactToolResult {
  const prev = latestArtifact(threadId, a.id);
  const version = (prev?.version ?? 0) + 1;
  db.prepare("INSERT INTO artifacts (thread_id, id, version, title, kind, language, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    threadId,
    a.id,
    version,
    a.title,
    a.kind,
    a.language,
    a.content,
    Date.now(),
  );
  return { id: a.id, version, title: a.title, kind: a.kind };
}

/** Applies exact find/replace edits. Each `old` must match once, so an edit never lands in the wrong place. */
export function applyEdits(content: string, edits: Array<{ old: string; new: string }>): string {
  let out = content;
  for (const [i, edit] of edits.entries()) {
    const first = out.indexOf(edit.old);
    if (!edit.old || first === -1) throw new Error(`Edit ${i + 1}: \`old\` text not found. Call read_artifact to get the current content.`);
    if (out.indexOf(edit.old, first + 1) !== -1) throw new Error(`Edit ${i + 1}: \`old\` text matches more than once. Include more surrounding text.`);
    out = out.slice(0, first) + edit.new + out.slice(first + edit.old.length);
  }
  return out;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "artifact";

export function artifactTools(threadId: string): ToolSet {
  return {
    create_artifact: tool({
      description: "Create an artifact shown in a side panel. See the Artifacts section of the system prompt for when to use it.",
      inputSchema: z.object({
        id: z.string().describe("Short kebab-case id, unique in this chat, e.g. `budget-dashboard`"),
        title: z.string().describe("Human-readable title"),
        kind: z.enum(KINDS),
        language: z.string().optional().describe("Language for kind `code`, e.g. `python`"),
        content: z.string().describe("Full content"),
      }),
      execute: async ({ id, title, kind, language, content }) => {
        let key = slug(id);
        // Creating an id that exists would silently overwrite it, so give the new artifact its own id.
        for (let n = 2; latestArtifact(threadId, key); n++) key = `${slug(id)}-${n}`;
        return saveVersion(threadId, { id: key, title, kind, language: language ?? null, content });
      },
    }),
    update_artifact: tool({
      description: "Change an existing artifact. Pass `edits` (exact find/replace pairs) for targeted changes, or `content` to replace it whole.",
      inputSchema: z.object({
        id: z.string(),
        title: z.string().optional(),
        edits: z
          .array(z.object({ old: z.string().describe("Exact text to find, matching once"), new: z.string() }))
          .optional(),
        content: z.string().optional().describe("Full new content. Use instead of edits for rewrites"),
      }),
      execute: async ({ id, title, edits, content }) => {
        const prev = latestArtifact(threadId, id);
        if (!prev) throw new Error(`No artifact with id \`${id}\` in this chat.`);
        if (content === undefined && !edits?.length && !title) throw new Error("Pass `edits` or `content`.");
        const next = content ?? (edits?.length ? applyEdits(prev.content, edits) : prev.content);
        return saveVersion(threadId, { ...prev, title: title ?? prev.title, content: next });
      },
    }),
    read_artifact: tool({
      description: "Read the current content of an artifact. Use when you no longer have it in context, or an edit failed.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const a = latestArtifact(threadId, id);
        if (!a) throw new Error(`No artifact with id \`${id}\` in this chat.`);
        return { id: a.id, version: a.version, title: a.title, kind: a.kind, language: a.language, content: a.content };
      },
    }),
  };
}

export const artifactRoutes = new Hono<AppEnv>().get("/threads/:id/artifacts/:artifactId", (c) => {
  const thread = getThread(c.get("user").id, c.req.param("id"));
  if (!thread) return c.json({ error: "Not found" }, 404);
  const versions = artifactVersions(thread.id, c.req.param("artifactId"));
  return versions.length ? c.json(versions) : c.json({ error: "Not found" }, 404);
});
