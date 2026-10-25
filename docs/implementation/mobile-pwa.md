# Mobile and installable app (PWA)

## Install

- `src/web/public/manifest.webmanifest`: standalone display, dark splash color, `any` and `maskable` icons, New chat and Settings shortcuts.
- Icons are rendered from the separate `icon.webp` (302 × 297 source): the lit green tile with overlapping white dialogue marks. The wordmark is never included in app icons. The maskable versions scale the tile to 110% on an opaque accent background, so the platform mask crops the artwork's own rounded corners while keeping the symbol inside the safe circle.
- The offline shell includes the separate `wordmark.svg` used by the shared brand component. `sw.js` uses cache `okaychat-shell-v2` and deletes obsolete shell caches on activation.
- `src/web/public/sw.js` makes the app installable and keeps the shell available offline. It never handles `/api/*`. Pages are network-first with the cached `/` as the offline fallback, `/assets/*` (content-hashed) is cache-first, other public files are stale-while-revalidate. Bump `CACHE` only to force-drop old entries; deploys are picked up without it.
- The worker registers only in production builds (`main.tsx`). In dev it would cache Vite's unhashed modules.
- Browsers register service workers only on secure origins. Over the plain-HTTP tailnet URL the app is not installable. Use HTTPS (`tailscale serve`, a reverse proxy) or `localhost`.
- The server sends `Cache-Control: no-cache` for `sw.js` and the manifest.
- iOS: "Add to Home Screen" in Safari. The status bar is `black-translucent`, so the theme fills behind it and the shell pads with `safe-top`.

Verified with Chromium's `Page.getInstallabilityErrors` (none) and an offline reload that still renders the shell.

## Mobile conventions

- Safe areas: `safe-top`, `safe-x`, `safe-bottom` utilities in `index.css`. The shell root pads top and sides. Fixed overlays (drawer, artifact panel) pad themselves. The composer footer uses `max(1rem, env(safe-area-inset-bottom))`.
- `#root` has `overflow: hidden`. Mobile Chrome otherwise promotes the full-screen chat scroller to act as the page ("implicit root scroller"), hides its URL bar on scroll, and resizes only that scroller, so the composer drifts off the bottom edge. A clipping ancestor blocks the promotion, so the URL bar stays. `100dvh` does not fix it: the root then overflows the screen while the bar shows.
- The mobile scroll viewport fills the chat and uses a 5rem alpha gradient mask starting 1rem below the top, like the sidebar fade, with no header blur or opaque overlay. Initial content padding and the user-message anchor inset are both 6rem on mobile (desktop keeps 3em). The anchor uses matching negative margin and padding to preserve message spacing while stopping sent messages below the fade; content padding alone does not affect assistant-ui's turn anchoring.
- Touch sizing uses the `pointer-coarse:` variant, not breakpoints, so a touch laptop gets it and a narrow desktop window does not. Header buttons are 40 px, composer controls 36 px, list rows 44 px.
- Hover-revealed controls (model favorite star) stay visible at reduced opacity on touch. Sidebar rows have no hover button on touch; their menu opens with a long press.
- Inputs are at least 16 px on touch devices, or iOS zooms on focus. The rule is unlayered in `index.css` so it beats `text-sm`.
- The composer and model search do not autofocus on touch, so the keyboard does not cover the screen on every chat switch.
- Empty chat on phones: the welcome line centers in the free space and the composer sits at the bottom, in thumb reach.
- Drawer gestures (`components/layout/use-drawer-swipe.ts`): swipe right anywhere to open, swipe the drawer or backdrop left to close. It follows the finger and settles by flick velocity or the halfway point. Touches on fields, open dialogs/menus/listboxes, sliders, the artifact panel, `[data-no-drawer-swipe]`, content that can still scroll left, or with a text selection are left alone. A touchmove that is no longer cancelable (the browser already scrolls) cancels the gesture. Listeners use the capture phase because Base UI's context-menu trigger on thread rows stops `touchstart` from bubbling.
- The artifact panel (full screen on phones) closes with a swipe right from a 20 px strip on its left edge, above the preview iframe, which would otherwise swallow the touch.
- Back closes overlays (`hooks/use-back-close.ts`): the phone drawer, the phone artifact panel, and every `Dialog` on touch devices. Each open overlay pushes a same-URL history entry with an `okaychatOverlay` id, so Android back, an installed PWA's back gesture, and a Tauri Android wrapper (back maps to webview history) close the top overlay instead of leaving the page. Closing from the UI pops the entry. An entry left behind when a drawer link pushes a route is skipped when back reaches it. Pushes wait for our own pending `history.back()`, or that traversal would undo them.
- Tailwind `translate-*` sets the CSS `translate` property, not `transform`. Transitions must name `translate` or the movement jumps.
