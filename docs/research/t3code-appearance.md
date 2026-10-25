# T3Code Appearance settings

Source: T3Code (MIT, Copyright (c) 2026 T3 Tools Inc.), read from `/tmp/research/t3code`:

- `apps/web/src/components/settings/SettingsPanels.tsx`: `AppearanceSettingsPanel` (line 1069), `TypographySection` (line 1701) and its font rows
- `apps/web/src/components/settings/ThemeSettings.tsx`: `ThemeLibrary`, `ThemeLibraryCard`, remove dialog
- `apps/web/src/components/settings/ThemeImportDialog.tsx`, `ThemeEditorPanel.tsx`, `ThemePreviewCircles.tsx`, `ThemeWireframe.tsx`, `PanelAnimationsPreview.tsx`
- Defaults and ranges: `packages/contracts/src/settings.ts`
- Preview render specs: `packages/shared/src/themePreview.ts` (inlined in `theme/ThemePreviewCircles.tsx`)

"Applies" means the setting makes sense in a chat app. Terminal, diff, branch strip, and environment settings do not apply.

## Section: Colors & themes

Heading `Color scheme`, then a `Themes` heading. Searchable titles are from `settingsSearch.ts`.

| Code | Control | Label / text | Options or range | Default | Applies |
| --- | --- | --- | --- | --- | --- |
| S1 | Segmented group of 3 tiles (`role="group"`, `aria-label="Appearance mode"`) | `System`, `Light`, `Dark`. Each tile shows a wireframe preview. Tile `aria-label`: "Follow the system appearance" or "Use {mode} mode". | system, light, dark | system | Yes |
| S2 | Theme card grid (`minmax(16rem, 1fr)` columns) | Cards: `T3 Code` (standard), `T3 Chat`, `Grove`, `Ocean`, `Ember`, `Iris` (built-ins), then environment themes (skip), then user themes and imported collections | One card per theme | `T3 Code` | Yes |
| S3 | Per-mode picks on each card (light/dark halves) | Each card shows a light and a dark preview. Clicking one assigns that theme to that mode only. Stored as halves. | light, dark | none | Yes |
| S4 | Buttons on the `Themes` row | `Create theme` (opens editor, outline, icon `PaintbrushIcon`), `Add theme` (opens import dialog, icon `PlusIcon`) | n/a | n/a | Yes |
| S5 | Card action icons (per card) | Duplicate (`CopyIcon`), Edit (`PenLineIcon`, user themes only), Download JSON (`UploadIcon`), Remove (`Trash2Icon`, user themes only) | n/a | n/a | Yes |

Card behavior:

- Click the card name or the card body to use the theme for the current appearance mode.
- A single-mode theme (only light or only dark) assigns to that mode's half.
- Active cards get `box-shadow: inset 0 0 0 1px var(--ring)` and `bg-accent/30`.
- Mode rings: each preview circle shows a `ring-2 ring-inset ring-ring` when that mode is active, plus a sun or moon badge (`size-4`, bottom-right).

## Section: Interface

| Code | Searchable title | Control | Range / options | Default | Description text | Applies |
| --- | --- | --- | --- | --- | --- | --- |
| S6 | Contrast | Range slider with output badge (`{value}%`) | 50 to 200, step 5 | 100 | "Adjust the contrast of colors and borders across the interface." | Yes |
| S7 | Glass opacity | Range slider with output badge (`{value}%`) | 40 to 100, step 5 | 80 | "Higher values make menus, dialogs, and the composer more solid." | Yes |
| S8 | Environment identification | Select: `artwork`, `pill`, `none` | 3 options | `artwork` | "Choose how Dev and Nightly environments are identified." Shown only in T3 environments | No |
| S9 | Diff colors | Select: `Red & green (default)`, `Blue & orange` | 2 options | red-green | "Choose colors for additions and deletions, including change counts." | No |
| S10 | Composer context | Switch | on or off | off | "Keep branch and worktree controls below the composer after a thread starts." | No |
| S11 | Chat width | Select | Comfortable (default, 46rem max), Wide (72rem), Full (100%) | comfortable | "Set how wide messages and the composer can grow on large screens." | Yes |

Notes on the `Contrast` and `Glass opacity` rows: each has a reset button that appears only when the value differs from the default.

Glass implementation notes:

- `surface-glass` reads `--glass-opacity` / `--glass-blur`; `glassOpacity = 100` also sets `--glass-blur: 0px`.
- okaychat deviation: the composer uses the card color at glass opacity + 30% and the desktop sidebar the sidebar color at glass opacity + 25% (`depth-sidebar`), both capped at 100%. They float on shadows, so the plain glass value read too thin. See `docs/research/visual-depth.md`.
- A `backdrop-filter` element cannot see through an ancestor stacking context that paints above the content. Keep `z-*` on the glass element itself (the floating chat header and chat actions do), not on a wrapper around it.
- Ancestor opacity animations must not retain their final value (`both` / `forwards`); a retained animation keeps the ancestor a backdrop root and disables the blur for descendants. Use `backwards` when the element needs to stay hidden during a delay.

## Section: Motion

| Code | Searchable title | Control | Range | Default | Description text | Applies |
| --- | --- | --- | --- | --- | --- | --- |
| S12 | Panel animations | Range slider with output (`{value} ms`) and a replay preview button (`Replay panel animation preview`) | 0 to 400 ms, step 25 | 0 (off) | "Set how fast panels open and close." | Yes |

okaychat additions (not in T3Code):

- `Square corners` (Interface section, `squareCorners`) sets `data-corners="square"` on `<html>`. `index.css` then forces `border-radius: 0` on every element, pseudo-element, and scrollbar thumb, so pills, avatars, and `rounded-full` go square too. Artifact frames are separate documents and keep their own styles.
- `Animations` plus four group switches (`motionOff`, groups in `MOTION_GROUPS`): interface (entrances, exits, smooth scrolling), transitions (hover, color, panels), icons (`motion/icons.ts` gestures), and loading (spin, pulse, shimmer, skeleton). The master switch turns all groups off or on. The groups go into `data-motion-off` as a space-separated list, matched with `~=` at the end of `motion/motion.css`. Durations collapse to 1 ms, like the OS reduced-motion rule, so code waiting for `animationend`/`transitionend` still runs. JS that animates checks `motionAllowed(group)` from `state/appearance.ts`, which also honors `prefers-reduced-motion`. A new loading animation class must be added to the loading exclusions there, or switching interface animations off freezes it.
- Both fields use `.default()` in the schema, so stored snapshots and caches written before them still parse.

The preview is a small sidebar/content mock. It animates width and border with `duration-(--preview-duration) ease-out`. It respects `prefers-reduced-motion`.

## Section: Typography

Heading `Typography`. Header switch labeled `Advanced` (aria "Show advanced typography settings"). Stored in `localStorage` under `t3code:typography-advanced`, default off.

- Simple mode shows: Interface font, Monospace font (code font), Word wrap.
- Advanced mode shows: Interface font, Prompt font, Code font, Terminal font, Font smoothing (macOS only), Word wrap.

Each font row has:

- Family control. A list picker: the default (Onest), then bundled fonts (including Golos Text), uploaded fonts (tagged "Uploaded"), and system fonts from `queryLocalFonts`. System fonts load when the list opens, which is the user gesture the browser needs. The code row lists monospace faces only. A stored family that is no longer installed still shows, so it stays visible.
- Size select, `{n} px`, integer steps.
- Reset button (shown when family or size differs from default). Reset restores family and size together.
- Monospace rows accept only fixed-width families (checked by advance widths of glyphs `i M W 0 @ # . space` in four style variants).

| Code | Searchable title | Row | Family default | Size control | Size range (px) | Size default (px) | Description text | Applies |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S13 | Interface font | Family + size | Onest (bundled), then the system UI stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`) | `""` (empty = default stack) | 12 to 20 | 16 | "Everything outside code blocks and the terminal." | Yes |
| S14 | Prompt font | Family + size (advanced only) | Follows the interface family | `""` | 12 to 20 | 14 | "Only the box you write prompts in. Mono works well here." | Yes |
| S15 | Code font | Family + size. Monospace only. Simple mode title: "Monospace font" | `"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace` | `""` | 10 to 18 | 13 | "Code blocks, diffs, and file previews." (simple mode adds "and the terminal") | Yes |
| S16 | Terminal font | Family + size (advanced only) | Follows code font | `""` | 8 to 20 | 12 | "Terminal output, independent from code blocks and diffs." | No |
| S17 | Font smoothing | Switch | on or off | on | "Use thinner grayscale text smoothing instead of the macOS default." Rendered on macOS only | Yes (macOS) |
| S18 | Word wrap | Switch | on or off | on | "Wrap long lines in code blocks by default. Use the wrap button on a block to override it." | Code blocks (local overrides described in `code-blocks.md`) |

Preview blocks: the prompt font preview, a code preview (diff sample), and a terminal preview sit below their rows. The chat app can use its own sample text.

## Theme library UX

### Layout

1. Heading `Color scheme`.
2. Three-tile mode group (S1). Each tile is a full-width button with a wireframe thumbnail on top and label below (`text-xs font-medium`). Active tile text is `text-foreground`, others `text-muted-foreground`.
3. Row with `Themes` heading on the left and two outline buttons on the right: `Create theme`, `Add theme`.
4. Card grid. Order: standard `T3 Code` card, the five built-in maintainer themes, then user-installed themes. Collections (multi-variant imports) render as one card with variant bubbles.
5. Import dialog, remove dialog, and the theme editor panel are overlays opened from the grid or buttons.

### Card anatomy

- Outer: `rounded-xl border border-border/70 bg-card/60 overflow-hidden`, hover `bg-accent/10`, active `bg-accent/30`.
- Preview area (top): two circles, one per mode that the theme defines, showing:
  - Base: `color-mix(in oklab, canvas 80%, base)` where base is `#ffffff` in light and `#09090b` in dark.
  - Accent radial gradient: light center `72% 22%`, dark center `28% 78%`.
  - Action radial gradient: light center `18% 82%`, dark center `82% 18%`.
  - Circle edge: inset 1px line plus a soft drop shadow.
  - Light and dark circles sit side by side. Clicking a circle selects that mode.
- Footer: name button (`text-sm font-medium`, truncated), then icon buttons (Duplicate, Edit, Download, Remove).

### Collection (multi-variant) cards

- The preview is a radial group. The root bubble for light sits at `-52px` from center, dark at `+52px`.
- Each mode shows its selected variant (`Light: {label}` tooltip). If more variants exist, a `+{n}` pill appears.
- Hovering or focusing a mode opens the other variants in an arc (68px spread, `35ms` stagger, each variant bubble scaled to `scale-[0.43]`). Each variant has `aria-label` "Use {label} for {mode} mode".
- The active variant gets a `ring-2 ring-inset ring-ring` and a sun or moon badge.

### Wireframe thumbnails (ThemeWireframe)

A miniature app: a sidebar strip (22% width), a user message bubble, two assistant bars, a composer bar at the bottom with a send dot, and a floating card at top right with three colored rows. System mode renders two panes: left light, right dark, split at 50%.

### Import dialog (`Add a theme`)

- File zone (dashed border; drop highlight `border-ring bg-accent/20`): title "Theme file", subtitle "Drop T3 Code or VS Code .json files" (or the file name after reading), button `Choose files` (multiple files allowed). While reading, the button text is "Reading…".
- Theme JSON textarea (`aria-label="Theme JSON"`, label "Theme JSON"). Paste works.
- Footer: `Cancel` (ghost) and `Add theme` (plus icon, disabled when empty).
- Errors (`Alert variant="error"`, `aria-live="polite"`): "That theme file is invalid.", "Could not read that file. Paste the JSON below instead."
- Conflicts: if a theme id already exists, the dialog shows "Already installed" with the names, and buttons `Update existing`, `Keep both`, `Back`, `Cancel`.
- Success toasts: "{label} added" with "It's now your {mode} theme." (single-mode theme assigned to a half) or "It's now active.". Bulk: "{n} themes added" or "updated".
- VS Code theme files are converted on import. Light and dark files with the same base name are paired into one theme with variants.

### Remove dialog

- Single theme: title `Remove “{label}”?`, body "You can bring it back anytime by importing its JSON file." Buttons: Cancel and a destructive confirm action.
- Collection: title `Remove themes from “{collection}”?`, body "Select the variants you want to remove. You can restore them by importing the extension again." Grid of variant checkboxes (cards with previews).
- Failure toast: "Couldn't remove theme".

### Theme editor (`Create theme` / `Edit theme`)

Opens as a resizable, draggable side panel. Close button `Close the theme editor`.

- Header: title `Create theme` or `Edit theme`. Buttons: `Inspect` (toggles "Pick a color from the app", which spotlights a DOM element and maps it to a color role), and close.
- Name field: placeholder/label `Theme name`, max 48 characters.
- Appearance tabs: `Light`, `Dark` (`aria-label="Theme appearance"`). Locked tabs show a reason ("“{label}” has no {mode} palette. Create a theme with the same name to add one.").
- Mode toggle: `Use advanced theme colors` (switch).
  - Simple (default): two color inputs, `Background` and `Accent`. Subtitle "Two colors, rest derived". All other roles are generated from those two.
  - Advanced: all color roles, grouped:
    - Foundation: Background, Surface, Raised surface, Overlay, Text, Muted text, Border, Input.
    - Brand & content: Subtle surface, Highlight surface, Accent, Action, Message surface, Code surface.
    - Status: see `ThemeEditorPanel.tsx` (Error, Warning).
    - Context: Sidebar background, Sidebar controls, Sidebar selection, Terminal background.
    - Search: Search matches, Current match.
  - Color filter field, placeholder `Filter colors`, shows `No matches.` when empty.
- Color picker popover, titled `Choose a color`. Each color input opens it. Read `ThemeColorPicker.tsx` for the exact controls.
- Footer: `Cancel`, then `Create theme` (new) or `Save changes` (edit).
- Save errors: toast "Could not save your theme".

Saving a single-appearance theme writes `colors`. A dual-appearance theme writes `colors` for the base mode and `variants` for the other.

## Persistence keys (T3Code)

| Key | Purpose |
| --- | --- |
| `t3code:theme` | Selected theme id, or `light`, `dark`, `system`, empty = T3 Code |
| `t3code:theme-appearance-mode` | `system`, `light`, or `dark` |
| `t3code:theme-follow-system` | Legacy boolean. Fallback only |
| `t3code:theme-halves:v1` | JSON `{ light?: id, dark?: id }` |
| `t3code:themes:v1` | JSON array of user themes |
| `t3code:typography-advanced` | Advanced typography switch |

Settings values (S6, S7, S11, S12, S13 to S18) live in T3Code's server or client settings store. This port does not include that store. The defaults are listed in `src/web/theme/README.md`.

## okaychat implementation notes

The brand artwork lives in `src/web/public/icon.webp` (256 × 250, lossless WebP, about 50 KB). It is tightly cropped from the supplied 1304 × 1206 PNG at `(138, 103, 1029, 1005)`; alpha below 10/255 is discarded to remove stray border specks. The supplied asset is already transparent. The 64 px favicon and 180 px Apple touch icon are square PNG fallbacks with the original aspect ratio preserved.

`src/web/theme/brand.ts` decodes the artwork once and shifts its HSL hue and saturation to the palette's `accent` (`--app-theme-accent`, not the subtle `--accent` surface or the separate action color used by solid controls). Lightness, white quotation marks, and alpha are preserved. This avoids CSS `hue-rotate` changing perceived saturation or clipping channels. Palette application and live editor previews both refresh the shared `--brand-icon` image and browser icon links; theme halves, OS mode changes, and account appearance restores use the same path. `Brand.tsx` is shared by the sidebar, sign-in, onboarding, and public shares. No image processing dependency is needed at runtime.

`src/web/components/settings/AppearanceSettings.tsx` rebuilds the panel. The theme library and editor are close ports in `src/web/components/settings/theme/`: preview circles, library cards (including collection cards with radial variants), the floating draggable and resizable editor panel (guided two-color mode, advanced grouped roles, merge by name), the HSV color picker, and the inspector. `ThemeEditorHost` is mounted by `ChatShell`, so the panel stays open across routes and the inspector works on the chat. Deliberate differences:

- Environment themes are left out (okaychat has none).
- The editor's appearance toggle is a plain segmented button pair (no `ToggleGroup` component here).
- Font smoothing appears only in Advanced mode on macOS, as in T3Code.
- okaychat replaces the T3Code text input with a list picker, so typed names are gone. Browsers without the Local Font Access API show only the default and uploaded fonts.
- Default interface font is Onest, bundled with `@fontsource-variable/onest` (self-hosted, no Google request). Stored `""` means Onest. The picker keeps Golos Text alongside bundled Liberation, DejaVu, and Ubuntu faces, see `bundled-fonts.md`.
- Uploaded fonts ("Installed fonts" row) are stored in SQLite (`user_fonts`), checked by file signature (WOFF, WOFF2, TTF, OTF; 15 MB), and served at `/api/fonts/:id/file`. The family name is the file name. `state/fonts.ts` registers each one with `FontFace` when the shell loads, so it syncs with the account. Removing a font resets any setting that still uses it.
- No toasts. Errors are shown inline.
- Appearance preferences and custom themes now sync per account through `/api/appearance`, stored inside `user_settings.json`. `src/shared/appearance.ts` defines the validated wire format.
- `useSyncAppearance` migrates the first device's local preferences once, then merges only changed fields. Separate account caches (`okaychat:appearance:<userId>`) retain unsaved edits, and `focus` / `online` retry them and fetch remote changes. Concurrent changes to the same field use the last server write; unrelated fields are preserved.
- The existing plain localStorage boot keys and `okaychat:appearance` remain as the last-used visual cache, so first paint still uses the theme before React. Login restores the current account before mounting the chat; an account without saved preferences starts from defaults if the cache belongs to someone else.
- Theme library changes use the existing parser and notification mechanism (`replaceCustomThemes`). UI changes remain immediate, saves debounce 400 ms, and page unload attempts a keepalive write. Failures leave the outbox cached and show an inline sync status in Appearance settings. This is refresh-on-focus sync, not a live subscription between devices.
