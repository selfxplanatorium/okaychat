# Granular permissions and layered prompts — admin workspace

Server semantics live in `src/server/permissions/` and `src/shared/permissions.ts`; the design is the
specification this worktree implements. This page documents the shipped admin/user surfaces and the
deliberate limits of the first pass.

`notes` and `calendar` are ordinary feature keys with default `true` and no dependencies. Their routes
and stores resolve the all-model account decision (`modelRef = null`); a model-specific grant never
unlocks either workspace, and the reminder ticker rechecks `calendar` at delivery time. Denial keeps
stored content and its quota charge so an administrator can re-enable the feature for cleanup.

## Routes

`permissionRoutes` is mounted at `/api` by `src/server/routes.ts`. Admin routes require a live admin role
and send `Cache-Control: no-store`; self routes require only a session.

| Surface | Path |
| --- | --- |
| Bootstrap, policies, preview, commit, effective, audit | `/api/admin/permissions/*` |
| Self permissions / per-model instructions | `/api/permissions`, `/api/instructions/models` |

## Settings UI

`/settings/admin` keeps account management. A `Permissions` card links to the workspace, which is query
driven and rendered by `AdminSettings` when `?view=` is one of `people`, `groups`, `models`, `features`,
`prompts`, `inspect`, or `audit`.

- `src/web/state/permissions.ts`: account-scoped zustand store. `begin()` resets on account change and
  aborts pending bootstrap/subject reads; every response is generation-guarded. Drafts are in memory only.
- `src/web/state/permissions-draft.ts`: pure draft normalization, changed-destination changes, prompt
  layer preview. Reset deletes a field instead of writing today's effective value.
- `src/web/state/permissions-impact.ts`: canonical preview paths → display descriptors.
- `src/web/state/permissions-query.ts`: URL parse/build, subject reconciliation, arrow-key helpers.
The feature keys include `channels` and `evaluations`. `channels` gates every ordinary room route,
event frame, and room AI dispatch; the separate `/api/admin/channels` moderation routes stay usable
without it so an admin can clean up a disabled account's rooms. Room access also needs live membership
and group eligibility, so the feature key alone never grants a room. `evaluations` works as follows:
when it is denied the `/evaluations` routes answer 403 and the
workspace shows a disabled state. Every evaluation case and judge call is an ordinary `llm.call`, so
model allowlists, `operationsPerMinute`, and `concurrentOperations` apply unchanged; a mid-run denial
stops further dispatch. Generation and judge dispatch each resolve the `evaluations` feature for
their own exact model, in addition to the account-level management guard.

n8n webhook turns also enforce `modelAllowed` for the canonical `n8n/<agent-id>` target before
constructing the stream and again immediately before POST, so hand-crafted requests and a
revocation during request preparation cannot bypass a target denial.

- `src/web/components/settings/permissions/`: workspace rail, subject/model detail with Access / Features /
  Limits / Prompts tabs, prompt editor, impact review, inspector, audit.
- `src/web/components/settings/SelfPermissions.tsx`: ordinary-user summary and personal per-model
  instructions in Account settings; it reads only the self endpoints.

Deep links use `settingsHref("permissions", query)` / `permissionsHref(query)` from
`src/web/lib/settings-link.ts`.

## Editing model

The editor fetches policies for `everyone`, the selected subject's groups, and the subject to reproduce
the server resolver for effective values and source labels. Only changed destinations are sent to
`POST /admin/permissions/preview`; `POST /admin/permissions/commit` sends the preview hash, catalog
fingerprint, reason, and the same changes. A 409 offers Reload (discard) or Rebase (refresh baselines,
keep draft text); field-level conflict choice is not implemented.

## Deliberate limits

- Shared credential audiences and per-target model grants remain in the existing admin provider rows;
  the Models view opens the account policy for an exact model instead of duplicating those editors.
- No bulk editing, `who-can-use` page, or thread picker in the inspector (there is no admin chat-listing
  endpoint).
- Prompt "preview" is computed from fetched layers plus the server inspection assembly; no test model call.
- Rebase is destination-level, not field-level.
