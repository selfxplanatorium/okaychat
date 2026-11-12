# Appearance and branding

The appearance engine is ported from T3Code (MIT, Copyright (c) 2026 T3 Tools Inc.). Module origins, defaults, and DOM contracts are documented in `src/web/theme/README.md`.

## Implementation

The brand icon lives in `src/web/public/icon.webp` (302 × 297, lossless WebP, about 56 KB): the approved rounded, lit green tile containing two overlapping white dialogue marks with downward tails. It is separate from `wordmark.svg` (964 × 234 viewBox), which holds the approved rounded serif lettering as vector paths, without a font dependency. Both were extracted from the approved logo mockup; design explorations, prompts, and working files are not kept in the repository. The 64 px favicon, 180 px Apple touch icon, and 192/512 px PWA PNGs are rendered from the icon alone, preserving its aspect ratio.

`src/web/theme/brand.ts` decodes the icon once and shifts its HSL hue and saturation from the default dark accent (`#b5c062`) to the palette's `accent` (`--app-theme-accent`, not the subtle `--accent` surface or the separate action color used by solid controls). Lightness, white dialogue marks, and alpha are preserved. This avoids CSS `hue-rotate` changing perceived saturation or clipping channels. Palette application and live editor previews both refresh the shared `--brand-icon` image and browser icon links; theme halves, OS mode changes, and account appearance restores use the same path. `Brand.tsx` renders the separate wordmark as a CSS mask filled with that same `--app-theme-accent` (falling back to `--primary` before palette application), so its flat color follows the accent exactly and immediately. Its screen-reader text keeps the brand name accessible. This component is shared by the sidebar, sign-in, onboarding, and public shares. No image processing dependency is needed at runtime.

`src/web/components/settings/AppearanceSettings.tsx` renders the settings panel. The theme library and editor live in `src/web/components/settings/theme/`: preview circles, library cards (including collection cards with radial variants), the floating draggable and resizable editor panel (guided two-color mode, advanced grouped roles, merge by name), the HSV color picker, and the inspector. `ThemeEditorHost` is mounted by `ChatShell`, so the panel stays open across routes and the inspector works on the chat. Differences from the upstream port:

- Environment themes are left out (okaychat has none).
- The editor's appearance toggle is a plain segmented button pair (no `ToggleGroup` component here).
- Font smoothing appears only in Advanced mode on macOS, as in T3Code.
- okaychat replaces the T3Code text input with a list picker, so typed names are gone. Browsers without the Local Font Access API show only the default and uploaded fonts.
- Default interface font is Onest, bundled with `@fontsource-variable/onest` (self-hosted, no Google request). Stored `""` means Onest. The picker keeps Golos Text alongside bundled Liberation, DejaVu, and Ubuntu faces, see `bundled-fonts.md`.
- Uploaded fonts ("Installed fonts" row) are stored in SQLite (`user_fonts`), checked by file signature (WOFF, WOFF2, TTF, OTF; 15 MB), and served at `/api/fonts/:id/file`. The family name is the file name. `state/fonts.ts` registers each one with `FontFace` when the shell loads, so it syncs with the account. Removing a font resets any setting that still uses it.
- No toasts. Errors are shown inline.
- Appearance preferences and custom themes now sync per account through `/api/appearance`, stored inside `user_settings.json`. `src/shared/appearance.ts` defines the validated wire format. The interface font size is the exception: it scales the whole UI, so it stays in the device's local store (`okaychat:appearance`). The schema omits it, the client snapshot and restore skip it, and the server drops it from older stored snapshots.
- `useSyncAppearance` migrates the first device's local preferences once, then merges only changed fields. Separate account caches (`okaychat:appearance:<userId>`) retain unsaved edits, and `focus` / `online` retry them and fetch remote changes. Concurrent changes to the same field use the last server write; unrelated fields are preserved. Patches go through `parseAppearancePatch()`, never `appearanceSchema.partial()`: Zod 4 fills `.default()` fields under `.partial()`, so every edit would reset unsent fields such as `sidebarStyle`.
- The existing plain localStorage boot keys and `okaychat:appearance` remain as the last-used visual cache, so first paint still uses the theme before React. Login restores the current account before mounting the chat; an account without saved preferences starts from defaults if the cache belongs to someone else.
- Theme library changes use the existing parser and notification mechanism (`replaceCustomThemes`). UI changes remain immediate, saves debounce 400 ms, and page unload attempts a keepalive write. Failures leave the outbox cached and show an inline sync status in Appearance settings. This is refresh-on-focus sync, not a live subscription between devices.

## Message layout

`user_settings.appearance.messageLayout` is `timeline` (default) or `bubbles`. It is an account
preference, validated by `appearanceSchema` and synced through the appearance endpoint. The runtime
writes `data-message-layout` on `<html>`; every rule in `theme/messages.css` that changes presentation
is scoped to `[data-message-layout="bubbles"]`, so timeline is the stylesheet default and a reload with
bubbles never paints a timeline frame (an inline boot script reads the persisted store before the first
paint).

Bubbles keep the user message right-aligned on an accent surface and give the assistant reply a
left-aligned reading surface capped at 40rem (34rem for the user), with wider cards, media and failures
spanning the lane. The per-message flags (`data-message-run`, `data-bubble-wide`, `data-bubble-empty`,
`data-bubble-waiting`) are rendered in both layouts, so switching is one style recalculation with no
remount and no history reload. Menus, action bars and popovers stay portaled: the stylesheet forbids
overflow, transforms, filters, paint containment and backdrop filters on these elements so they never
become a clipping block.

`test/browser/bubble-layout.mjs` is the live acceptance (not part of `npm test`): it builds a fixture
chat, checks both layouts at 1440, 720, 390, dark and reduced-motion, switches live from a second tab,
reloads and checks the first frame, opens the action menu, and fails on any console error, failed API
request or horizontal overflow.
