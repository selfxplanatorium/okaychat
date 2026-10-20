# Skills

Researched and built 2026-10-20. Skills follow the Anthropic Agent Skills format: a folder whose
`SKILL.md` starts with a YAML frontmatter block containing `name` and `description`, followed by the
Markdown instructions the model reads when it loads the skill. Optional extra files (references,
templates, scripts) sit next to it. Reference: https://agentskills.io / Anthropic docs on agent skills.

## Format we store

```markdown
---
name: python-upgrade
description: Runs the team's Python dependency upgrade checklist. Use when upgrading packages.
---
# Upgrade checklist
1. Pin the versions.
```

- `name`: lowercase kebab-case, `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 64 chars. Validation is strict —
  `Bad` is rejected, not lowercased (a silent rename would surprise the user and mix names).
- `description`: ≤ 1024 chars, third person, says what the skill does and when to use it. This is
  the sentence every future chat sees in the skill index.
- Body: the instructions (≤ 64,000 chars). Extra files: ≤ 24 files, ≤ 100k chars each, ≤ 300k chars
  per skill, ≤ 2,000,000 chars per account, ≤ 200 skills per account. File paths are relative
  (`references/api.md`); backslashes are normalized to `/`; traversal, absolute paths, and NUL bytes are rejected (or, for
  downloaded files, skipped as "binary or too large").

Frontmatter parsing supports `key: value` scalar lines and indented folded/literal block scalars
without adding a YAML dependency. Double-quoted scalars decode JSON escapes and single-quoted
scalars decode doubled quotes. Optional nested metadata is ignored.

## Storage

SQLite, appended migration in `db.ts`:

| Table | Purpose |
| --- | --- |
| `skill_preferences` | Account opt-in (`enabled`) + `revision` counter for tool revocation |
| `skills` | One row per skill: name (unique per user), description, body, enabled, `origin` (`manual` / `conversation` / `source`), `source_id` |
| `skill_files` | Extra files, `(skill_id, name)` → content (text) |
| `skill_sources` | Linked sources: kind (`github` / `raw`), url, branch, subpath, `token_enc` (AES-256-GCM with `OKAYCHAT_SECRET`) |

`saveSkill` upserts by `(user_id, name)`; edits by id preserve that id across renames. Updates keep
the original `origin`/`source_id`, and paths are normalized before storage. Replacing a skill releases
its old body, metadata and references before charging its replacement against the account quota.
All skill creation/edit/import/source-install paths enforce the shared quota; imports are atomic
across all skills. Names, descriptions, bodies and reference names/contents count UTF-8 bytes.
Deleting a skill cascades its references and releases quota. Deleting a source unlinks its installed
skills while leaving those instructions editable and loadable. See `storage-quota.md`.

Skills also appear in the Library as packages with an instructions preview and a ZIP download
containing SKILL.md and all stored references; Library deletion removes the same skill, not a copy.

## Sources

A user links sources in the Skills page (or the model lists them with `search_skill_sources`):

- **GitHub repo**: `https://github.com/owner/repo[/tree/branch[/subpath]]`. Listing uses the REST
  API (`/git/trees/<branch>?recursive=1`, `Accept: application/vnd.github+json`), manifest contents
  come from `raw.githubusercontent.com`. Missing branch → repo's `default_branch`. Branch names
  with slashes must be typed in the branch field (URL paths are ambiguous). Optional read-only
  personal access token, stored encrypted, sent as `Authorization: Bearer` to both hosts.
- **Raw URL**: a `SKILL.md` (one skill) or `.zip` (any number of skills; manifest paths end in
  `SKILL.md`, extra files come from the manifest's folder). Non-github hosts only; github.com URLs
  must use their raw.githubusercontent.com or other direct-download URL.

Fetching rules (`skill-fetch.ts` / `readBounded`): 30 s timeout per request (combined with the request
signal), 20 MB per download (checked against `content-length` and while streaming), ≤ 40 manifests
per source, 5 concurrent manifest fetches, per-entry parse errors surface in `errors` instead of
failing the whole listing. HTTP/HTTPS sources use ports 80/443, forbid URL credentials, and require
public IP addresses. DNS is validated and pinned in the socket lookup (including mixed DNS answers),
so redirects and DNS rebinding cannot reach loopback, private, link-local, tailnet or reserved ranges.
Redirects are limited to five, revalidated, cannot downgrade HTTPS, and strip tokens on origin
changes. Tokens are only sent over HTTPS; editing a source to a different origin clears a retained
token. Downloads and response bodies share the timeout.

ZIPs are bounded before decompression by a 20 MiB aggregate expanded-size cap and 2,000-entry cap,
plus per-file limits. A bounded node:zlib decoder checks actual inflated output as well, so forged
ZIP size headers cannot bypass the caps. Traversal paths are skipped before inflation, binary/oversized references are
skipped, nested skills stay separate, and stored references are relative to their own skill folder.

**Nothing fetched is ever executed on the app server** — skills are text;
if a skill has scripts, the model may copy them into the `run_code` sandbox itself (see
`code-sandbox.md` for the sandbox's isolation). A folder containing its own `SKILL.md` is another
skill; `folderPaths` excludes the whole subtree when collecting a skill's files.

## Model use (progressive disclosure)

`turnSkills(userId, { temporary, canCallTools })` in `skills.ts` builds three things per turn:

1. `context` — the index section inserted **beside the current user message**: `# Skills`, a one-line usage
   policy, and `- \`name\`: description` for every enabled skill. Bodies are never in the prefix.
2. `tools` — the full set, only in the main turn.
3. `subTools` — read-only `load_skill` + `read_skill_file`, given to delegates via `readOnlyTools`.

| Tool | Reads/Writes | Approval | Notes |
| --- | --- | --- | --- |
| `load_skill` | enabled skill by name → body + file list | no | 404 when not enabled/installed |
| `read_skill_file` | one extra file | no | validates the path like stored files |
| `search_skill_sources` | lists installable skills of every linked source | no | per-source errors inline |
| `install_skill` | copies one skill from a source | **yes** | replaces an installed skill of the same name |
| `create_skill` | upserts a skill the model drafts | **yes** | `instructions` maps to the body; no frontmatter |

Gating: skills exist only when the account preference is on, the chat is not anonymous (`tmp_`
threads), and the model can call tools. Mutators are additionally absent from delegate tool sets
(they also require approval, and nobody is there to approve). The "Create skill from this chat"
menu item is shown only when the preference is on and the chat is not anonymous.

### Caching

The index is dynamic current-turn context, inserted before the latest user message alongside retrieved
memories. It never enters `systemPrompt()` and never rewrites earlier messages. Adding, editing or
loading a skill leaves the system prefix byte-identical, including when an approval continuation
creates a skill. Bodies arrive only as tool results. Tool schema order stays deterministic.
See `prompt-caching.md`.

### Revocation

Like memory: the captured `revision` is checked on every tool execution, so turning the preference
off (and back on) rejects tools a running model still holds ("Skills were disabled. Continue
without them until the next reply."). Unlike memory, normal skill CRUD does **not** bump the
revision — tools read the live tables, so load/install results reflect the current state, and a
skill added mid-turn is simply not in the model's stale index copy (it can still be loaded).
Source installs re-check revocation after asynchronous fetching, immediately before storing content.

## API

`/api/skills` (mounted in `routes.ts`; static paths registered before `/:id` because Hono matches in
registration order):

```
GET/PATCH /skills/prefs                     — { enabled }
GET/POST  /skills                           — list (summaries) / create
GET/PUT/PATCH/DELETE /skills/:id            — detail (with body + fileContents) / update / {enabled} / delete
POST      /skills/import                    — multipart .md or .zip → { installed, skipped }
GET/POST  /skills/sources                   — list / add (branch/subpath/token optional; masked token kept)
PUT/DELETE /skills/sources/:id              — update / delete
GET       /skills/sources/:id/skills        — listing without installing
POST      /skills/sources/:id/install       — { name } → skill (+ skipped notes)
```

Skill edits from the UI send the whole record; an update without `files` clears the files
(a plain body edit is a deliberate full replace).

## Tests

`src/server/skills.test.ts` (parsing, validation, isolation, gating, revocation, import, source
records) and `src/server/chat-skills.test.ts` (mock-provider turnStream integration: index
injection, stable system prefixes, tool gating, approval flow, anonymous exclusion). Tests also cover
quota accounting/reclamation, atomic imports, renames, nested/reference paths, ZIP expansion limits,
mocked remote installs and revocation during download. `skill-fetch.test.ts` exercises private-address
rejection, DNS pinning, redirect validation, and cross-origin token stripping without live network access.
