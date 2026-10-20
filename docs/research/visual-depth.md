# Visual depth

The app follows the brand icon: surfaces lit from above, a one-pixel inner highlight on the top edge, a faint inner shade on the bottom edge, and soft shadows tinted by the theme. The approved mockup is the reference: floating frosted sidebar, accent glow in the canvas, a lifted composer with a focus halo, gradient accent controls, and spring presses.

## Where it lives

`src/web/theme/depth.css`, imported after `theme.css`. It adds tokens and Tailwind utilities only. No palette roles were added, so every built-in, custom, and imported theme gets depth from its existing `--primary`, `--background`, `--card`, `--sidebar`, and `--message-surface`.

| Token | Use |
| --- | --- |
| `--depth-highlight` | Top-edge inner highlight. 75% white in light mode, 6% in dark |
| `--depth-line` | Hairline outline drawn as a 0-spread shadow, so it does not change layout |
| `--depth-shadow-tint` | Shadow color. The foreground pulled toward the accent in light mode, black in dark |
| `--shadow-raised`, `--shadow-float` | Two elevations: resting on the canvas, floating over content |
| `--depth-glow`, `--depth-canvas-glow` | Focus halo and the radial accent glow in the canvas |
| `--depth-primary-top`, `--depth-primary-bottom`, `--depth-primary-shadow` | The accent control gradient and its tinted drop shadow |

| Utility | Applied to |
| --- | --- |
| `depth-canvas` | Shell root (`ChatShell.tsx`). The thread root is transparent so the glow shows through |
| `depth-primary` | `Button` default variant, checked `Switch` track, highlighted menu and select items, new-thread button, send/stop |
| `depth-float` | Menus, popovers, selects, the auth card |
| `depth-sidebar` | Desktop sidebar panel and settings nav (`md:` only; on the phone they keep the overlay and the top bar) |
| `depth-row-active` | Selected thread row and the sliding settings-nav pill: raised card plus an accent bar on the leading edge |
| `depth-field` | `Input`, `Textarea`: slightly sunken, accent halo on focus |
| `depth-composer` | Composer and edit composer shells |
| `depth-bubble` | User message bubble, the message surface tinted toward the accent |
| `depth-knob` | Switch thumb |
| `.depth-press` | `Button` transitions: colors fast, `scale` on `--ease-spring`, pressed to 0.95 |

Settings cards (`SettingsUI` sections, theme library cards, color scheme tiles) use `bg-card` with `shadow-[var(--depth-highlight),var(--shadow-raised)]` instead of a border. The selected color scheme tile adds the `--ring` outline and `--depth-glow` halo. Slider thumbs in `theme.css` are lit knobs matching `depth-knob`.

## Rules

- Derive every depth color from semantic tokens with `color-mix`. Never hardcode a hex in `depth.css`, or a theme switch will leave stale colors behind.
- `depth-primary` sets `box-shadow` directly, which replaces Tailwind's `ring-*` shadow. Its focus state uses an outline instead. Do the same in any new utility that owns `box-shadow`.
- `.depth-press` lives in `@layer components` so a `transition-*` utility passed by a caller still wins. Custom `@utility` blocks support variants (`md:depth-sidebar`, `data-active:depth-row-active`).
- The composer background is the card color at glass opacity + 30%, capped at 100%. The sidebar uses the sidebar color at glass opacity + 25%. Both still follow the Glass opacity setting.
- The light default accent (`#62691b`) is darker than the icon's lime because it must keep white text readable. The gradient brightens its top edge rather than changing the palette.
- Motion tokens stay in `src/web/motion/`. `chat-message-in` now adds a small scale and a 3 px blur to the rise.
