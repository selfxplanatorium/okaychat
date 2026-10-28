# Keyboard navigation

Every feature can be used without a pointer. Three layers make that work:

1. Shortcuts for frequent actions, configurable per account.
2. The command list (`Ctrl/⌘+/`, or `?` outside text fields): every command by name, runnable with Enter.
3. Plain focus order for everything else: every control is a real button, link, or form field, and nothing appears only on hover.

## Code

| File | Role |
| --- | --- |
| `src/web/keyboard/keys.ts` | Combo strings: parse, normalize, match key events, display, `aria-keyshortcuts`, and the browser shortcut list |
| `src/web/keyboard/commands.ts` | The command catalogue with default combos, and `resolveBindings()` (account overrides over defaults) |
| `src/web/keyboard/registry.ts` | `useCommand()` handlers, the `[data-command]` click fallback, the dispatcher, the search/command dialog store |
| `src/web/keyboard/KeyboardShortcuts.tsx` | Shell-level handlers (navigation, chat, message focus) and the command list dialog. Mounted once in `ChatShell` |
| `src/web/components/settings/KeyboardSettings.tsx` | Settings → Keyboard: recorder, conflicts, send key, single-key switch |
| `src/web/keyboard/keys.test.ts` | Matching across layouts, browser conflicts, and a check that no default clashes |

## Combo format

`Mod+Shift+K`, `Alt+Shift+ArrowUp`, `?`, `F2`. Modifiers in the order `Mod`, `Ctrl`, `Alt`, `Shift`. `Mod` is ⌘ on Apple devices and Ctrl elsewhere; `Ctrl` is only the real Control key on a Mac. `Plus` stands for the + key.

Matching rules (`eventCombos`):

- A key press can match two combos: the produced character, and the physical key (`event.code`) while Ctrl/⌘/Alt is held. macOS Option changes the character (Option+N types `˜`) and non-Latin layouts type other letters, so the physical key keeps Alt+Shift+N working. Without a modifier the physical key never stands in, or typing Cyrillic would trigger shortcuts.
- Shift is not part of a symbol combo. `?` is Shift+/ in the US layout and Shift+ß in the German one, and both match `?`.
- AltGr (reported as Ctrl+Alt on Windows) types `@`, `€`, `{` on German keyboards, so it never counts as a modifier. Defaults avoid Ctrl+Alt for the same reason.
- On Windows/Linux the Windows key never forms a combo.

## Defaults

Ctrl/⌘+Shift+letter is almost entirely taken by Chrome and Firefox (developer tools, bookmarks, private windows, screenshots, Linux Unicode input). Plain Alt+letter opens browser menus on Windows/Linux. So:

- Actions that must work while typing use **Alt+Shift+letter** (`⌥⇧` on a Mac). Browsers leave these alone; Firefox uses Alt+Shift only for HTML `accesskey`, which the app does not set.
- Two established exceptions: `Ctrl/⌘+K` (search, overrides the browser's web search box, which stays on Ctrl+E/Alt+D) and `Ctrl/⌘+/` (commands).
- Message navigation uses single keys (J/K/arrows, C, E, R, B, M, Escape) that only fire while a message has focus.

`browserConflict()` lists browser shortcuts in two levels: `blocked` (Chrome/Firefox handle them before the page, such as Ctrl+T, Ctrl+W, Ctrl+1–9) and `taken` (reach the page, but people expect the browser's action). The recorder refuses blocked ones and asks before using taken ones. A test asserts that no default appears in either list or twice.

## Dispatch

One capture listener for chords (Ctrl/⌘/Alt) and one bubble listener for plain keys, both on `window`:

- Chords run before widgets, so they work inside menus and text fields.
- Plain keys run after widgets and skip events a widget already handled (`defaultPrevented`), focus inside text fields, and widgets that own plain keys (menus, listboxes, tabs, sliders, grids). Function keys also fire in text fields.
- While a modal dialog is open only `global` commands run (search and the command list, which replace each other instead of stacking).
- `message` commands run only while focus is inside a message (`[data-message-root]`) and take precedence over the same key elsewhere.
- The settings recorder sets `setRecording(true)`, so pressing a combo to record it does not also run it.

A command runs its newest `useCommand()` handler; a handler may return `false` to pass. Without a handler it clicks the last visible, enabled `[data-command="<id>"]` element, focusing it first so menus and popovers return focus to their trigger. Prefer a handler when the action lives in state (sidebar, search toggle, temporary chat) and `data-command` for buttons whose primitive owns the logic (assistant-ui action bars, Base UI triggers). `TooltipIconButton` takes `command`, which sets `data-command`, `aria-keyshortcuts`, and shows the combo in its tooltip.

## Messages

Message roots are `tabIndex=-1` focus stops with `data-message-root`. assistant-ui mounts an older message's action bar only on hover (`autohide="not-last"`, driven by `message.isHovering`), so `useMessageFocus()` sets `isHovering` on focus and holds it while focus stays inside, also when the pointer leaves. Action buttons carry `message.copy`, `message.edit`, `message.retry`, `message.branch`, `message.readAloud` (when read aloud is on), `message.more`. `chat.readLast` (Alt+Shift+V) reads the last answer aloud or stops it. "Jump to the last message" (`Alt+Shift+J`) enters the list, Escape returns to the message box.

Chat-level actions on the last message (retry, edit, copy, copy code) click those same buttons inside the last message of that role. Copy and retry click without moving focus, so the message box keeps the cursor.

## Chat commands

Rename, pin, archive, delete, and the chat menu are registered by the current chat's sidebar row (`ThreadListItemMenu`, when `threads.mainThreadId` is its id), so they work from anywhere and are unavailable in temporary chats, which have no row. The chat menu opens by dispatching `contextmenu` on the row, the same event Shift+F10 sends; after a keyboard close, focus returns to the row.

After `threads.switchToNewThread()` away from a stored chat, `aui.threadListItem.getState()` still returns the previous chat for one render. Read the new id from `aui.threads.getState().mainThreadId`.

## Settings

Stored in `user_settings.keyboard` (`KeyboardSettings` in `shared/types.ts`), validated by `settingsPatch` in `routes.ts`:

- `bindings`: command id → combos. A present key replaces that command's defaults, an empty list unbinds it. Saving the default list removes the key, so later default changes reach the account.
- `sendWith`: `enter` (default) or `modEnter`, passed to assistant-ui's `submitMode` on both composers.
- `singleKeys`: `false` turns off every plain-key shortcut except function keys.

## Adding a command

1. Add a `CommandDef` to `COMMANDS` (id, label, group, default combos, scope). Run the tests: a default that clashes fails.
2. Either `useCommand(id, handler)` in the component that owns the state, or `data-command={id}` (or `command={id}` on `TooltipIconButton`) on the control.
3. Nothing else: the command list, settings page, and tooltips read the catalogue.
