# Vendored Glisse 0.5.0 (local adaptation)

This directory is a small, attributed source fork of Glisse 0.5.0, used instead
of the npm package. It is the pinned dependency for the glass material and the
two Glisse controls this app ships.

## Provenance

- Package: `glisse@0.5.0`, MIT, Copyright (c) 2026 Kelvin Zhang.
- Evidence: `npm pack glisse@0.5.0`; tarball SHA-1
  `a92902a481aea688c67f44b87f38e3fdfd43fe4a`. Eight files, 61.2 kB packed,
  242.3 kB unpacked; ESM 100.0 kB, CSS 26.9 kB (npm's uncompressed sizes).
- Readable authority: the published ESM build, which keeps `// src/...` section
  names. The tarball ships no source maps, so this file maps to those sections,
  never to invented original line numbers.
- Package source: <https://github.com/0kzh/glisse>. Upstream docs:
  <https://glisse.kelvinzhang.com>. `LICENSE` here is the package's MIT text.

## Why a fork instead of the npm import

The published entry point prepends its whole stylesheet to `<head>` on import
and contains Menu, TabBar, Input, SearchField and Slider as well. It also keeps
lens and rim maps in unbounded `Map`s, watches themes through `data-theme`, and
offers no way to attach, pause, detach or bound a lens for the app's lease
policy. This adaptation keeps the algorithms, the control markup and the
gesture/spring design, and changes scheduling, theme notification, cache bounds,
attachment ownership, semantics, RTL and geometry. No runtime npm dependency is
added, nothing is downloaded at build or install time, and the controls never
inject CSS.

## Module map

| Local file | Upstream sections | Notes |
| --- | --- | --- |
| `lens-math.ts` | `src/internal/lens.ts` (`distance`, `arc`, `slope`, `lensMap`, corner radius), `src/internal/refraction.ts` (`rimMap`) | Pure math, no DOM. The displacement and rim algorithms are unchanged. |
| `map-cache.ts` | none (upstream used module-level `Map`s in `lens.ts` and `refraction.ts`) | New bounded, reference-counted cache: 24 entries and 12 MiB, counting decoded pixels and data URL bytes. |
| `material-engine.ts` | `src/internal/svg.ts`, `src/internal/lens.ts` (`encode`, `graph`, `place`, `createLens`, `mask`), `src/internal/refraction.ts` (`paintRim`) | No React, no CSS injection, no document access at import. |
| `switch.tsx` | `src/switch.tsx`, `src/internal/spring.ts` | Visual tree, lift, drag and springs retained; semantic button rebuilt. |
| `switch-state.ts` | `src/switch.tsx` (thresholds, settle/commit), `src/internal/controllable.ts` | Pure control state for tests: no React, no DOM. |
| `segmented-control.tsx` | `src/segmented-control.tsx`, `src/internal/segments.tsx` (segmented mode), `src/internal/controllable.ts` | Radio group, not a tab bar; no lens. |
| `controls.css` | `dist/styles.css`: "Switch and slider thumbs", "Switch", "Tab bar", "Segmented control" | Scoped `oc-` classes only; the upstream root palette and media-query palette are dropped. |

Not copied: Button, Glass, Menu, TabBar, Input, SearchField, Slider, the
embedded CSS string (`src/internal/styles.ts`), the CommonJS build, demos and
the theme-detection heuristic.

## Local changes

### `lens-math.ts`

- Split from the bundled build into a pure module; types for shapes, lens
  options, maps and rects added.
- `mapSize`, `clamp`, `cornerRadius`, `intersect` and `placementKey` exported
  for the engine and tests.
- Density is an explicit argument everywhere instead of a module constant.
- Math itself (distance field, arc slope, dome falloff, splay, glow/rim) is
  unchanged.

### `map-cache.ts`

- Bounded LRU with reference counts: evicts unreferenced entries first and
  refuses a new map when every remaining entry is live.
- Accounts for both decoded pixels (`width * height * 4` per image) and encoded
  data URL bytes.

### `material-engine.ts`

- Attachment API is app-owned: `attachSurface(element, source, options)` and
  `enhanceSwitch(refs, options)`, each with idempotent `update`, `invalidate`,
  `setActive` and `destroy`. Inactive means maps and filters are gone, not a
  flag.
- Sources are explicit elements registered by the caller; upstream's
  `findBackdrop` overlap search and `data-glisse-backdrop` scanning are not
  used, so DOM order is never treated as paint order.
- One read phase then one write phase per frame; unchanged placement strings
  cost no SVG writes; the hidden SVG host is removed when the last lens goes.
- The graph drops upstream's ink and blur stages: the paint host owns frost
  through `backdrop-filter` exactly once, and the switch's own track supplies
  its frost through `--lg-thumb-frost`.
- Theme changes arrive through explicit `update`/`invalidate` calls from the
  app, not by observing `data-theme` or every inline style mutation.
- Switch lenses render synchronously in the spring frame and are counted so the
  SVG host outlives them.
- No React, no stylesheet injection, no import-time document access.

### `switch.tsx` / `switch-state.ts`

- One native `button`, `type=button`, `role=switch`, boolean `aria-checked`,
  built last by `switchAttributes` so a caller cannot override role, type,
  checked, busy or disabled. `id`, `aria-label`, `aria-describedby`, `name`
  attributes and `className` are forwarded.
- Controlled/uncontrolled resolution matches upstream, but a controlled switch
  never shows a value its parent refused: it emits once and stays on the prop.
- Pointer handling uses React handlers instead of upstream's native listeners,
  so a caller's `preventDefault` cancels the toggle and exactly one click path
  remains. Space/Enter still toggle once through the native button click.
- Geometry is measured from the rendered track and thumb, not from upstream's
  `TRAVEL = 21.7125` constant. The visible track is 48x24 CSS px inside a
  48x44 button; upstream's `::before` overhanging hit area is gone.
- RTL: the thumb rests at the logical start (`inset-inline-start`) and the drag
  fraction reverses `dx`, so checked still means the logical end.
- A mostly vertical press cancels without committing; pointer cancellation and
  lost capture settle back to the current value. Only a horizontal drag past
  halfway commits.
- Reduced motion or Appearance > Motion interface/transitions off disables the
  drag and the lift; click and keyboard still work. A live preference change
  cancels the gesture and restores the checked state.
- `loading` implies disabled, sets `aria-busy`, and never invents a checked
  value. `data-checked` / `data-disabled` stay present/absent for the app's
  existing selectors.
- The lens is imported lazily (shared promise) only when the effective tier is
  `high`/`balanced`, the controls family is on, and motion is allowed; a failed
  or slow import leaves the CSS switch working.
- Springs keep upstream's analytic motion and shared frame loop, but jump
  instead of animating when the document is hidden or motion is off.

### `segmented-control.tsx`

- Radio group semantics: `role=radiogroup`, `role=radio`, `aria-checked`,
  roving `tabIndex`, direction-aware Left/Right, Up/Down, Home/End, and a
  disabled group. Per-item `aria-disabled` (an addition, not upstream) keeps a
  locked choice focusable so a wrapper can explain why.
- Equal slots through CSS grid; the thumb moves with `inset-inline-start`, so
  RTL needs no mirrored geometry.
- Upstream's spring-driven lens lift is not shipped: the engine exposes a
  switch lens only, so the thumb slides on a CSS transition. Dragging still
  moves the thumb with the pointer, a mostly vertical drag gives the page its
  scroll, and releasing over a segment selects it.
- Tab-bar/navigation mode, icons and the duplicated lensed/tinted label copies
  are omitted. Labels ellipsize instead of overflowing.
- `renderItem` lets the app wrapper add a tooltip without the vendor holding
  user-facing text.

### `controls.css`

- Only `.oc-switch*`, `.oc-segmented*` and `.oc-thumb-face`, scoped with the
  `oc-` prefix. No `:root` palette, no theme media queries, no global element
  selectors.
- Upstream's `--lg-*` tokens are read with semantic fallbacks (`--input`,
  `--primary`, `--muted`, `--card`, `--ring`), so the controls render before
  `theme/glass.css` defines the bridge.
- Geometry comes from `--oc-switch-track-w/-h`, `--oc-switch-rest` and
  `--oc-switch-grow`; travel is a `calc()` of those for the no-enhancement
  fallback and is measured in JS once the springs run.
- Reduced motion, reduced transparency, missing `backdrop-filter`, forced
  colors, the solid tier and a switched-off controls family all resolve to a
  readable, opaque control.

## Integration

- `components/ui/switch.tsx` re-exports the adapted switch as `Switch` and
  keeps Base UI's implementation as `FormSwitch` for form participation
  (`name`/`value`/`required`), Field validity, `render` and `inputRef`.
- `components/ui/segmented-control.tsx` adds typed labels and the disabled
  reason tooltip.
- `src/web/index.css` imports `vendor/glisse/controls.css` after `depth.css`
  and before `theme/glass.css`, as the appearance spec requires. The wrappers
  do not import the stylesheet, so it is emitted once.
- `material-engine.ts` is reached only through a dynamic `import()` from the
  switch and from `components/glass`; never re-export it from a static barrel.

## Known limitations

- The first press can happen before the engine chunk has resolved; that press
  uses the CSS material and has no lens. Hover and focus preload it, so this is
  normally only the first interaction of a session.
- The segmented control has no refraction lift (see above); its thumb uses a
  CSS transition, not a spring.
- `Switch` is not a form control: it renders no hidden input, so it does not
  participate in form submission or `required` validation. Use `FormSwitch`.
- Switch drag is pointer-only; keyboard interaction is a plain toggle.
- The switch's lens needs `--lg-glass-bend`/`--lg-glass-dispersion` from
  `theme/glass.css`; without the bridge it falls back to the `--oc-glass-*`
  values and then to the Standard preset's defaults.
