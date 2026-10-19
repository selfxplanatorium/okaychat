# Theme and appearance

Framework-free theme logic and CSS, ported from T3Code (MIT, Copyright (c) 2026 T3 Tools Inc.). No React here. The UI is built on top of these modules later.

Source files are listed in each module header. The T3Code clone used for the port is at `/tmp/research/t3code`. Its UI reference is in `docs/research/t3code-appearance.md`.

## Files

| File | Purpose | Ported from |
| --- | --- | --- |
| `palettes.ts` | Built-in themes (`t3-chat`, `grove`, `ocean`, `ember`, `iris`), T3 Code default light and dark colors, `THEME_COLOR_ROLES`, and types. Values are verbatim. | `packages/shared/src/themePalettes.ts` |
| `palette.ts` | Theme lookup, custom theme storage (install, update, remove, list, subscribe), theme file parse and serialize, color validation and canonical OKLCH form, mode and half resolution, DOM application (`applyThemePalette`, `applyThemeColorPreview`), `--app-theme-*` variable map. | `apps/web/src/themePalette.ts` |
| `settings.ts` | Ranges and defaults for glass opacity, contrast, panel animation, chat width, and font sizes. Clamp helpers. DOM writers for glass and chat width. | `packages/contracts/src/settings.ts`, `apps/web/src/routes/__root.tsx` |
| `contrast.ts` | Writes `--appearance-contrast-*` variables from the contrast setting. | `apps/web/src/appearanceContrast.ts` |
| `fonts.ts` | Font stacks, font family list parsing, font variable writes, size clamps, monospace detection, installed font discovery. | `apps/web/src/appearanceFonts.ts` |
| `vscode-import.ts` | VS Code theme JSON to `ThemeDefinition`. Pairs light and dark files. Resolves label collisions. | `apps/web/src/vscodeThemeImport.ts` |
| `theme.css` | Tailwind v4 layer. Maps `--app-theme-*` to semantic tokens, exposes them as `@theme inline` colors, defines glass, contrast, chat width, font variables, and `.settings-slider`. | `apps/web/src/index.css` (extracted blocks) |

`palette.ts` depends on `culori` (already in `package.json`).

## Wiring

Stylesheet (`src/web/index.css`):

```css
@import "tailwindcss";
@import "./theme/theme.css";
```

`theme.css` defines `@custom-variant dark (&:is(.dark, .dark *))`. The `dark` class on `<html>` drives `dark:` utilities, replacing Tailwind's default `prefers-color-scheme` variant.

DOM contract:

- `<html class="dark">` in dark mode.
- `<html data-theme-id="...">` when a theme is applied. Its absence means the `:root` light defaults.
- `--app-theme-*` inline on `<html>` (written by `applyThemePalette`).
- `--appearance-contrast-*`, `--glass-opacity`, `--glass-blur`, `--font-sans`, `--font-mono`, `--font-composer`, `--font-size-prompt`, `--font-size-code`, `--diffs-font-size` inline on `<html>` (written by the apply functions).
- `data-chat-width` on `<html>`.
- `data-theme-ready` on `<html>` once the runtime has applied the theme. The boot `<style>` in `index.html` only paints `body` before it, so later theme changes are not overridden by load-time splash colors.

Call order at mount, after the boot script (see below):

```ts
import { applyThemePalette } from "@/theme/palette";
import { applyAppearanceContrast } from "@/theme/contrast";
import { applyAppearanceFontVariables } from "@/theme/fonts";
import { applyGlassOpacity, applyChatWidth } from "@/theme/settings";
```

Re-run each apply function when its setting changes.

## Settings keys and defaults

Appearance settings. Keep the T3Code names. The UI syncs them per user through `/api/appearance` and keeps a local cache for first paint and unsaved edits. See `src/web/state/appearance-sync.ts`.

| Key | Range | Default | Notes |
| --- | --- | --- | --- |
| `glassOpacity` | 40 to 100, integer, step 5 | 80 | % of background for `surface-glass`, `dialog-glass`, `dropdown-glass`. 100 also removes blur. |
| `appearanceContrast` | 50 to 200, integer, step 5 | 100 | Base up to 100%, boost above 100%. |
| `panelAnimationDurationMs` | 0 to 400, step 25 | 240 | 0 disables animation. Set `--panel-animation-duration` on the layout element. Respect `prefers-reduced-motion`. |
| `chatWidth` | `comfortable`, `wide`, `full` | `comfortable` | `46rem`, `72rem`, `100%` of `--chat-content-max-width`. |
| `fontSizeInterface` | 12 to 20 px | 16 | Sets `<html>` font size. |
| `fontSizePrompt` | 12 to 20 px | 14 | |
| `fontSizeCode` | 10 to 18 px | 13 | Also `--diffs-font-size` if you add diff views. |
| `fontSizeTerminal` | 8 to 20 px | 12 | Not used. No terminal. |
| `fontFamilySans` | string, max 200 | `""` | Empty = `DEFAULT_SANS_FONT_STACK`. |
| `fontFamilyComposer` | string, max 200 | `""` | Empty = inherits `--font-sans`. |
| `fontFamilyCode` | string, max 200 | `""` | Empty = `DEFAULT_CODE_FONT_STACK`. |
| `fontFamilyTerminal` | string, max 200 | `""` | Not used. |
| `fontSmoothing` | boolean | `true` | Sets `-webkit-font-smoothing: antialiased`. Only meaningful on macOS. |
| `wordWrap` | boolean | `true` | Code blocks and tables. Not stored by this module. |
| `typographyAdvanced` (localStorage `okaychat:typography-advanced`) | boolean | `false` | Shows prompt and terminal font rows. |

Theme selection (localStorage):

| Key | Value |
| --- | --- |
| `okaychat:theme` | Theme id, `light`, `dark`, `system`, or empty for T3 Code default |
| `okaychat:theme-appearance-mode` | `system`, `light`, `dark` (default `system`) |
| `okaychat:theme-halves:v1` | `{"light": "<id>", "dark": "<id>"}` |
| `okaychat:themes:v1` | JSON array of custom themes (`version` 1 theme files stored by id) |
| `okaychat:theme-follow-system` | Legacy fallback only |

Keys are constants in `palette.ts` (`CUSTOM_THEMES_STORAGE_KEY`, etc.). The boot script must use the same names.

## Applying a theme at boot (no flash)

React mounts after first paint, so the theme must be applied before that, from an inline script in `index.html` `<head>`, placed before the module script.

Use T3Code's script: `apps/web/index.html`, the first `<script>` block (an IIFE, about 400 lines, no imports). It reads the storage keys above, resolves the mode and halves, sets `.dark`, `data-theme-id`, `data-theme-selected`, `--boot-*` splash colors, and `<html>` background, and updates `meta[name="theme-color"]`. Its `<style>` block gives `html`, `body`, and `#root` the splash background so the first paint is not white in dark mode.

Two sync points:

1. The script copies `BUILT_IN_THEME_PALETTES` (background, foreground, accent, chrome per built-in and mode) and `DEFAULT_THEME_PALETTES`. If `palettes.ts` changes, update these copies.
2. The storage key constants. Keep them identical to `palette.ts`.

After React mounts, call `applyThemePalette(theme, appearance)` with the resolved values. This writes the full `--app-theme-*` set and replaces the boot-time splash values.

## Intentionally dropped

- Effect Schema (`ThemePreference`, `ThemeLibraryStorageError` as a tagged error). Replaced with plain types and checks. The error is now a plain `Error` subclass with the same fields.
- Desktop theme sync (`resolveDesktopTheme`, `syncDesktopTheme`).
- Environment themes (`getEnvironmentThemes`, `setEnvironmentThemes`). Server-published palettes do not exist here.
- Theme collections publishing and replacement (`replaceCustomThemeCollection`, `getStoredCustomThemeCollection`). Collection data still parses and round-trips, so imported collections keep their grouping.
- Preview sidebar artwork (`themeAllowsSidebarArtwork`, `getThemePreviewSidebarArtwork`, `subscribeToThemePreview`). Sidebar artwork is a T3 feature.
- Mobile theme ids (`MOBILE_DEFAULT_THEME_ID`, `MOBILE_THEME_IDS`) and publish guard sets (`UNPUBLISHABLE_THEME_IDS`) in `palettes.ts`. Kept in the file because values must stay identical, but unused.
- Diff color tokens (`--diff-*`) and the diff color scheme setting.
- Terminal font and terminal palette roles stay in `palettes.ts` and `palette.ts`. CSS for the terminal is not ported. Add it if the app gets a terminal.
- Environment identification and composer context settings.
- T3 chat header rules (`[data-chat-header]`), `[data-app-sidebar]` overrides, and the `t3-chat` light-mode code chip overrides. Port these when the matching UI exists.
- Theme inspector overlay CSS (`#theme-inspector-*`). Rebuild it with the theme editor.
- Stage artwork variables (`--stage-*`) and the T3 composer seam shadows.
