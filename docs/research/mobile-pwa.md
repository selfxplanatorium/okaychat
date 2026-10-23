# Mobile and installable app (PWA)

## Install

- `src/web/public/manifest.webmanifest`: standalone display, dark splash color, `any` and `maskable` icons, New chat and Settings shortcuts.
- Icons are rendered from `icon.webp` (256 px source). The maskable versions scale the artwork past the edge on an olive gradient, so the platform mask crops the artwork's own rounded corners. Regenerate them from a larger source if one becomes available.
- `src/web/public/sw.js` makes the app installable and keeps the shell available offline. It never handles `/api/*`. Pages are network-first with the cached `/` as the offline fallback, `/assets/*` (content-hashed) is cache-first, other public files are stale-while-revalidate. Bump `CACHE` only to force-drop old entries; deploys are picked up without it.
- The worker registers only in production builds (`main.tsx`). In dev it would cache Vite's unhashed modules.
- Browsers register service workers only on secure origins. Over the plain-HTTP tailnet URL the app is not installable. Use HTTPS (`tailscale serve`, a reverse proxy) or `localhost`.
- The server sends `Cache-Control: no-cache` for `sw.js` and the manifest.
- iOS: "Add to Home Screen" in Safari. The status bar is `black-translucent`, so the theme fills behind it and the shell pads with `safe-top`.

Verified with Chromium's `Page.getInstallabilityErrors` (none) and an offline reload that still renders the shell.

## Mobile conventions

- Safe areas: `safe-top`, `safe-x`, `safe-bottom` utilities in `index.css`. The shell root pads top and sides. Fixed overlays (drawer, artifact panel) pad themselves. The composer footer uses `max(1rem, env(safe-area-inset-bottom))`.
- The mobile scroll viewport fills the chat and uses a 5rem alpha gradient mask starting 1rem below the top, like the sidebar fade, with no header blur or opaque overlay. Initial content padding and the user-message anchor inset are both 6rem on mobile (desktop keeps 3em). The anchor uses matching negative margin and padding to preserve message spacing while stopping sent messages below the fade; content padding alone does not affect assistant-ui's turn anchoring.
- Touch sizing uses the `pointer-coarse:` variant, not breakpoints, so a touch laptop gets it and a narrow desktop window does not. Header buttons are 40 px, composer controls 36 px, list rows 44 px.
- Hover-revealed controls (model favorite star) stay visible at reduced opacity on touch. Sidebar rows have no hover button on touch; their menu opens with a long press.
- Inputs are at least 16 px on touch devices, or iOS zooms on focus. The rule is unlayered in `index.css` so it beats `text-sm`.
- The composer and model search do not autofocus on touch, so the keyboard does not cover the screen on every chat switch.
- Empty chat on phones: the welcome line centers in the free space and the composer sits at the bottom, in thumb reach.
- Drawer gestures (`components/layout/use-drawer-swipe.ts`): swipe in from the left 28 px to open, swipe the drawer or backdrop left to close. It follows the finger and settles by flick velocity or the halfway point.
- Tailwind `translate-*` sets the CSS `translate` property, not `transform`. Transitions must name `translate` or the movement jumps.
