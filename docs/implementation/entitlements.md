# Model entitlements

Shared provider connections can now give each audience only some of the provider's models. The existing
visibility audience (`groups.ts`) still decides *who sees* a server key; the model policy decides *which
models* those people can use. Sharing a key with everyone, a group, or a single user is unchanged.

## Policy model

A shared provider connection has one policy per **audience target**:

| Target | When it exists |
| --- | --- |
| `everyone` (`target_id = ''`) | The connection has no `share_audiences` row (shared with everyone) |
| `user` (`target_id = users.id`) | The connection is restricted and lists that user |
| `group` (`target_id = user_groups.id`) | The connection is restricted and lists that group |

Each target is independently **all models** or an explicit allowlist of catalog ids. A target with no stored
policy row means all models, which is also the default for every connection and audience that predates this
feature. An explicit allowlist with no ids grants nothing.

A user's effective access is the **union** of every matching target: the `everyone` target, a direct user
target, and every group they belong to. If any matching target is all models, the user gets all models. The
admin is not exempt; an admin outside the audience or with a restricted policy sees what the policy grants.

A user's **own** connection for the same provider always wins: `readConnections()` merges shared connections
under the user's own rows, and list models then skips the shared policy. Own keys are never limited.

## Storage

Migration in `src/server/db.ts` (append-only):

```sql
provider_model_policies(provider_id, target_kind, target_id, mode)   -- mode 'all' | 'selected'
provider_model_grants(provider_id, target_kind, target_id, model_id) -- one row per allowed id
```

`provider_model_policies.provider_id` references `shared_connections` with `ON DELETE CASCADE`, and the
grants cascade from the policy. Deleting a shared connection therefore removes its policies even if a future
caller forgets `clearAudience()`. `clearAudience("provider", id)` also clears them explicitly; re-adding the
provider starts unrestricted.

`setAudience()` deletes and rewrites the audience rows but **prunes** policies instead of clearing them:
targets the connection still shares with keep their policy, removed users/groups lose theirs, and switching
to everyone removes user/group policies (and vice versa). An audience edit never changes what a retained
group or user may use. Deleting a group removes its group policies; deleting a user removes their user
policies.

## Enforcement

All access checks are server-side.

| Point | Behaviour |
| --- | --- |
| `catalog/providers.ts` `listModels()` | Filters a shared connection's models to the union of its matching policies. The same list feeds the composer, settings default/utility model pickers, sub-agents, schedules, and compaction/title fallbacks. |
| `catalog/providers.ts` `listProviders()` | A restricted shared connection whose effective selection has no *current* chat model is not listed at all, exactly like one outside the audience. `modelCount` shows the entitled count. Empty grants and allowlists made only of stale ids both disappear. |
| `catalog/providers.ts` `resolveModel()` | Rejects an unentitled model with a 403 naming the administrator before any upstream request. This is what a saved chat hits on its next turn after a revoke; the history itself is untouched. |
| `catalog/ollama-routes.ts` user inventory | Filters a shared daemon's inventory and its counts to the viewer's granted ids; admin management and own connections retain the full inventory. |
| `llm.ts` `createModel()` | Rechecks synchronously before building any provider: the model and connection must have the same provider, and a `shared` connection needs a visible policy that allows the id. A stale model/connection pair, a fabricated shared connection, or a schedule/title/compaction call cannot bypass listing. |

Deliberate limits:

- Policies cover **chat** models, the same set the model picker, sub-agents, and schedules use. Image and
  speech services that reuse a chat provider key keep their existing own/service-level behaviour.
- `listModelsForConnection()` and `listSharedModels()` read only the shared row (never the admin's own key)
  and are used by the admin dialog to show the catalog for validation.
- Stored ids that models.dev, the live OpenCode Go list, a custom endpoint, or an Ollama daemon no longer
  reports are ignored at runtime (they match no listed model) but stay in storage. The admin dialog labels
  them **Missing from the catalog** and lets an admin keep or remove them. A new id that is not currently in
  the catalog cannot be added through the API.
- Access is checked per request, so a policy change applies to the next turn without restarting anything.
- Model ids for native Ollama are its tag names; them, and custom provider ids, are validated against the
  connection's live list when the dialog is saved.

## Admin API

`GET /api/admin/providers/:id/entitlements` (admin only) returns:

```json
{ "providerId": "...", "audience": { ... }, "policies": [ ... ], "models": [ ModelInfo, ... ] }
```

`policies` has one entry per current audience target, in audience order; a target with no stored row appears
as `{ "mode": "all", "modelIds": [] }`. `models` is the shared connection's current chat catalog.

`PUT /api/admin/providers/:id/entitlements` accepts `{ "policies": [{ "target": { "kind": "user", "id": "..." }, "mode": "selected", "modelIds": ["..."] }] }`.
Only the supplied targets are updated, so one request cannot widen another audience. Validation:

- the provider must be a current shared connection (admin scope, so the admin need not be in its audience);
- every target must still be a current audience target of that connection, with `everyone` using an empty id
  and user/group ids non-empty; duplicate targets are rejected, never merged;
- when `mode` is `selected`, ids must be in the current catalog or already stored for that same target;
  otherwise the whole request fails (`400`). Mode `all` clears the allowlist.

Both routes sit behind `requireAdmin`. The dialog in `ModelEntitlements.tsx` sends only changed audiences'
drafts, so saving one audience cannot overwrite an untouched audience from an older dialog snapshot.
Switching audiences never copies a selection, and a failed save leaves the drafts untouched.

## UI

Admin → Server-wide providers → a connected key's **Models…** button opens the dialog. It has a per-audience
selector when the key has several audiences, an all/selected switch, a searchable multi-select with the same
capability icons, context size, and price as the chat model picker, All / None / selected-count controls, and
a clearly labelled missing-id section. It is keyboard reachable through `Models…` and the
`settings.providerModels` command (Alt+Shift+K by default; opens the expanded key or the first connected one).
The dialog follows the shared dialog, select, scroll-area, and touch conventions and uses semantic tokens in
light and dark themes.

## Tests

`src/server/entitlements.test.ts` covers the union across two groups and a direct user, a single group's
restriction, an all target, a target without a policy defaulting to all, membership changes, own-key
precedence, empty and stale-only grants being invisible, list filtering and provider hiding, the admin having
no bypass, audience pruning, group deletion, connection delete/re-add, factory rejection of revoked and
fabricated shared connections, and the admin routes (401/403, 404, audience and catalog validation, stale
retention, duplicate targets, mode all).
