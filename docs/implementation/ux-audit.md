# UX flow audit: fewer trips to Settings

An audit of the app's real interaction flows, the six improvements shipped in this pass, and what is
deliberately left alone. It is current operating guidance: when a flow below changes, update the row.

## How to read the counts

A **click** is one primary pointer press. A **state change** is a hover reveal, a route change, or a
silent preference change that the user did not ask for. Counts start from the stated start state and end
at the stated goal. Keyboard counts are shortcuts, not key presses used for typing. Mobile counts use
the settings index (an extra tap) where desktop's `/settings` opens General directly.

## Top ten friction points

| # | Friction | Evidence | Cost before this pass | Shipped? |
| --- | --- | --- | --- | --- |
| 1 | Retrying with another model has no direct per-answer action. The message menu’s model switch creates a separate chat. | `components/chat/branch.tsx` `BranchMenu` (`Switch model…`, `/threads/:id/branch`); `components/assistant-ui/elements/thread.aui.tsx` `AssistantActionBar` (`ActionBarPrimitive.Reload`); `components/chat/ModelPicker.tsx` | Start: assistant reply visible, action bar hidden. **Change then retry:** 3 clicks (model trigger, model, Retry), 1 hover, and the chat silently uses the new model for later turns. **Branch instead:** 3 clicks, 1 hover, 1 new chat/route. There is no path that changes the model for this answer only. | Yes (`RetryWithModel`) |
| 2 | The context ring shows numbers but not what the number means, and offers no direct path to the one setting that changes compaction. | `components/chat/ContextMeter.tsx` (ring, `summary`/`trim` buttons); `components/settings/GeneralSettings.tsx` (`autoCompactAt`, `trimBeforeCompact`) | Start: chat open. Open the popover: 1 click; it gives no explanation of what counts. To change auto-compaction: 1 click (desktop Settings gear) + a scan of the General page, or 2 taps on mobile (settings index, General). | Yes |
| 3 | Ctrl/⌘+K searches chats only. Running an app action by name needs a second, different palette (Ctrl/⌘+/). | `components/layout/ChatSearch.tsx`; `keyboard/KeyboardShortcuts.tsx` `CommandList`; `keyboard/commands.ts` | Start: chat, hands on keyboard. Open search: 1 shortcut. Compact now: 2 clicks (ring, Summarize) and 0 command entries. New chat: 1 click or 1 shortcut + typing in the other palette. Color scheme: 2 clicks (chat options, segment) or 1 shortcut + typing. | Yes |
| 4 | Projects and Scheduled have no one-click create from the sidebar, and their empty states are text only. | `components/layout/Sidebar.tsx` nav rows; `components/settings/ProjectSettings.tsx` `empty`; `components/settings/ScheduleSettings.tsx` `empty`; `components/layout/ProjectSwitcher.tsx` "Manage projects" | Start: any chat. Project form: 2 clicks (Projects, New project) + 1 route change. Schedule form: 2 clicks (Scheduled, New schedule) + 1 route change. From the project switcher's "Create a project": still 2 clicks. Empty state: 0 actions; the same 2 clicks to the header button. | Yes |
| 5 | Blocked or disabled features explain the fix in prose only, so the user leaves the flow and hunts in Settings. | `components/chat/ComposerControls.tsx` `ResearchToggle` (`researchNeedsWeb`, `researchNeedsSearches`), `MobileComposerMenu`; `components/chat/ChatPrivacyMenu.tsx` memory link (the good precedent) | Start: deep research was on, then web tools were switched off or the search limit was set to 0. The control shows a warning and 0 links. Fix: 1 click Settings + scroll (desktop) or 2 taps + scroll (mobile). Memory off has a link, but it is a hand-written `/settings/memory`. | Yes |
| 6 | First-run shortcuts are not taught in the product. | `thread.aui.tsx` `ThreadWelcome` (welcome line only); `KeyboardShortcuts.tsx` `CommandList` (a footer link); `components/settings/KeyboardSettings.tsx` | Start: empty chat, first minute. To learn Ctrl/⌘+K, Ctrl/⌘+/, or the model shortcut: 1 shortcut to the full command list, or 2 clicks to Settings → Keyboard. The empty state teaches 0. | Yes |
| 7 | Per-chat capabilities are scattered: search in the composer, research behind the phone plus menu, memory behind the header options, artifacts/UI/code only in account settings. There is no one place that shows what this chat can do and why something is unavailable. | `ComposerControls.tsx` (`SearchToggle`, `MobileComposerMenu`); `ChatPrivacyMenu.tsx`; `GeneralSettings.tsx` (`artifacts`, `generativeUI`, `codeExecution`) | Start: chat. Search: 1 click (desktop) / 2 (phone). Research: 1 / 2. Memory: 2 (options, switch) plus its account prerequisite. Artifacts, generative UI, code: 1 desktop click to Settings (General), or 2 mobile taps to Settings → General and three separate switches; no per-chat view. | No (deferred) |
| 8 | Settings links open the section at the top, not at the control that fixes the problem, and each link is hand-written, so destinations drift. | `ChatPrivacyMenu.tsx` `/settings/memory`; `ModelPicker.tsx`, `Onboarding.tsx`, `ImageServicesSettings.tsx`, `VoiceSettings.tsx` `/settings/providers`; `Sidebar.tsx` `/settings/account` | Start: a blocked or empty state. Follow its link or the Settings entry: 1–2 clicks to the section, then a scan of the page to find the switch; 0 links focus a specific row. | Yes (`lib/settings-link.ts`) |
| 9 | A reply's model, token count, cost, and duration are hover-only; at rest there is no sign which model answered, including after a model switch. | `ContextMeter.tsx` `MessageMeta` (`opacity-0`, `[[data-role=assistant]:hover_&]:opacity-100`) | Start: assistant reply visible, pointer away. Visible model/usage signals: 0. To check: 1 hover. Keyboard focus does not reveal it, because the footer's opacity responds to hover only. | No (kept by design; retry announces its model) |
| 10 | Compaction and trim are only reachable inside the context popover; neither is a command, so Ctrl/⌘+/ cannot run them and no shortcut can be assigned. | `ContextMeter.tsx` (Summarize/Trim buttons); `keyboard/commands.ts` (no compact/trim entries) | Start: chat. Compact: 2 clicks (ring, Summarize); 0 commands exist. Keyboard-only users must open the popover and tab to the button. | Yes |

## The six shipped improvements and why

1. **Retry with another model, in place** (row 1). It combines model selection and retry without a forced
   branch: `startRun({ parentId: assistant.parentId })` in the current chat after `selectModel`. Reuses
   the existing `ModelList` (favorites, search, F), `useThreadSync` barrier, and `BranchMenu`'s
   interaction-lock pattern. The new answer reports its model through the existing footer metadata, the
   composer label updates, and a live region announces the choice.
2. **Context popover completion** (rows 2 and 10). The existing popover gains one sentence about what is
   counted (the last reply's final step: input + output), a direct link to the auto-compaction row, and
   `chat.openContext`, `chat.compactNow`, and `chat.trimContext` commands. Commands are registered only
   while they can work (saved thread, not temporary, not running, not showing cached history), so the
   palette never offers a dead action.
3. **Shared settings links** (rows 5 and 8). `lib/settings-link.ts` names the destination and, where the target is a row, its anchor;
   `SettingsLayout` focuses `setting-<anchor>` after the lazy section mounts. Used by the context
   popover, the model picker's zero-model state, the memory link, the research blocked state, and the
   shortcut hints' customize link. No new settings pages, no user-configurable URLs.
4. **Commands in the Ctrl/⌘+K palette** (row 3). The existing search dialog gains a Commands group built
   only from `keyboard/commands.ts`, with the availability snapshot taken before the modal mounts. It
   combines both kinds of rows in one listbox and one arrow-key order, closes before running a command,
   and suppresses focus return so the command's destination keeps focus. Chat search stays independent
   of the project filter and keeps its debounce, abort, loading, and error states.
5. **One-click create for Projects and Scheduled** (row 4). Sidebar rows get an adjacent `+` (a sibling
   button, never inside the link) that opens `/projects?new=1` or `/scheduled?new=1`. Both pages read
   that query, open the existing form immediately, clear the query on cancel/save, and keep the existing
   `?thread=` scheduling flow.
6. **First-run shortcut hints** (row 6). A quiet row under the empty-chat welcome teaches three live
   bindings (search, model, commands) from the account's resolved bindings, links to the Keyboard
   settings, and is dismissed per account through the existing settings PATCH. A failed save keeps the
   row and explains the failure; there is no localStorage-only dismissal and no new settings page.

## Deliberately left alone

- **Per-chat tools sheet (row 7).** It needs a new consolidated state surface and per-chat overrides for
  account-level switches; changing those tool configurations is broader than this pass.
- **Hover-only message metadata (row 9).** The footer is intentionally quiet; the retry flow announces
  its model and the composer shows the active one, so the metadata design stays.
- **Favorites as a new feature.** Favorites already exist in `ModelList`; this pass reuses them in the
  retry picker instead of claiming a new feature.
- Navigation, route structure, theme engine, artifacts, and chat feature work owned by other branches.

## Verification boundary

The lead reviewed the full diff and connected runtime/model-context, popup, settings, and navigation code,
then ran both TypeScript configurations and the full Node suite. Settings focus has a DOM-boundary test.
No dev/build server or container suite was started under the shared-worktree protocol; actual 360px,
dark/light, screen-reader announcements, and popup focus transitions still need the orchestrator’s browser pass.
