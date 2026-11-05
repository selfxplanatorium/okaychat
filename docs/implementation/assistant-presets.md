# Named assistant presets

Reusable assistants store a model choice, instructions, sampling/output settings, and a restrictive tool
and knowledge policy. Selecting one copies a snapshot into the chat; the library row is never read again
by that chat. Editing or deleting the source therefore cannot change an existing conversation.

## Data model

- `assistant_presets` (`src/server/db.ts` trailing migration): owner, name/description/icon, `config_json`,
  private/published visibility, and a monotonic `revision`.
- `threads.assistant_json` stores the validated copied configuration plus `{sourceId, sourceRevision, name,
  icon, origin}`. `origin` is `published` for a body another account published, and it never becomes trusted
  input. `threads.assistant_revision` is the compare-and-set revision for model/knowledge changes.
- A receipt's `config_json` (`generation_runs`) is the immutable run configuration: effective instructions,
  sampling, tool policy, and knowledge ids. It is private and quota-accounted.

## Validation

`src/shared/assistant-presets.ts` is the only validator. It bounds names, descriptions, instructions
(code points and UTF-8 bytes), config bytes, selectors, and sampling. Sampling is checked against the live
catalog and effective reasoning effort in `samplingCapabilities`/`validateSampling`:

- temperature/top P only when the model exposes temperature and reasoning is explicitly off (`none`, or the
  model has no reasoning), never on the plan-login provider;
- temperature max 1 for Anthropic, 2 otherwise; top P > 0 and ≤ 1;
- max output only when the catalog has a positive maximum, 1..min(catalog max, 131072);
- at most one of temperature and top P; no numeric strings, NaN, or Infinity.

An unsupported stored field fails the turn with an actionable message before any provider request. A
published item may not carry private knowledge ids or MCP selectors; the server rejects it instead of
stripping them. The editor's "Create publishable copy" action makes that choice explicit.

## Selection and snapshots

`src/server/assistant-presets.ts` owns the CRUD routes and selection:

- `GET /api/assistant-presets?scope=mine|published` (opaque cursor, published pages of 50).
- `POST`, `PUT /:id` (expected revision), `DELETE /:id` (expected revision).
- `GET /api/assistant-presets/options?threadId=` is registered before `/:id`. It reads only cached MCP
  descriptors and never connects or runs a tool.
- `GET/PUT /api/threads/:id/assistant` reads and replaces the snapshot. Selecting rechecks source
  visibility and the account's model entitlement. `null` clears the snapshot but keeps current choices.

`PATCH /api/threads/:id` requires `assistantRevision` when the chat has a snapshot and the patch changes
`modelRef` or `knowledgeIds`, and bumps the revision on success. Thread detail carries the snapshot label
and revision; sidebar rows do not.

## Execution

`turnStream()` (`src/server/chat.ts`) resolves the snapshot before building prompts or tools. Model order is
the explicit chat model, the snapshot model, the project default, the account default, then the first
entitled model. Applying a preset with a model sets the chat model; a preset without one keeps it.

- Instructions go into system message 2 through the `assistantInstructions` prompt, wrapped as untrusted
  data. They never replace the base, safety, admin, group, or account instructions. Their presence taints
  the turn for the approval gate.
- `src/server/assistant-policy.ts` intersects the exact builtin families from `FAMILY_TOOLS`; an unknown
  tool key is denied. Research requires both `research` and `web`; delegation requires `delegate`. MCP
  selectors are applied while assembling `toolsForUser()`, so only selected servers connect and only
  selected tool definitions exist. Resource helpers are omitted entirely under a selected policy. The same
  filtered set is used for sub-agents and research.
- Knowledge ids are the chat's attached collections intersected with a selected policy. Retrieval,
  execution-time rechecks, and replayed turn-context blocks all use that intersection.

The tool list is deterministic but preset-dependent, so applying an assistant can re-prime the tool and
system-2 prefix. The account-level system message and cache affinity are unchanged. See
`prompt-caching.md`.

## Web

`state/assistant-presets.ts` is account-scoped and never persisted. `AssistantPicker.tsx` and
`AssistantPresetEditor.tsx` provide the composer entry, search, private/published lists, the builder, apply
review, and conflict handling. A new chat's choice is applied in `RuntimeProvider.initialize()` through the
same server API. A temporary chat holds the validated snapshot in memory and sends it as
`config.temporaryAssistant`; the server treats those instructions as untrusted and never writes a receipt.

## Deliberate limits

- An imported archive's assistant is inactive review data in `threads.imported_assistant_json`; it is not
  activated automatically and has no dedicated review screen yet.
- There is no preset version history, marketplace, group audience, uploaded icon, or schedule picker.
