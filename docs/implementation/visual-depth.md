# Visual depth

The app follows the brand icon: surfaces lit from above, a one-pixel inner highlight on the top edge, a faint inner shade on the bottom edge, and soft shadows tinted by the theme. The approved mockup is the reference: floating frosted sidebar, a lifted composer with a focus halo, gradient accent controls, and spring presses. The main canvas uses a solid theme background to avoid gradient banding on displays.

## Where it lives

`src/web/theme/depth.css`, imported after `theme.css`. It adds tokens and Tailwind utilities only. No palette roles were added, so every built-in, custom, and imported theme gets depth from its existing `--primary`, `--background`, `--card`, `--sidebar`, and `--message-surface`.

| Token | Use |
| --- | --- |
| `--depth-highlight` | Top-edge inner highlight. 75% white in light mode, 6% in dark |
| `--depth-line` | Hairline outline drawn as a 0-spread shadow, so it does not change layout |
| `--depth-shadow-tint` | Shadow color. The foreground pulled toward the accent in light mode, black in dark |
| `--shadow-raised`, `--shadow-float` | Two elevations: resting on the canvas, floating over content |
| `--depth-glow` | Focus halo |
| `--depth-primary-top`, `--depth-primary-bottom`, `--depth-primary-shadow` | The accent control gradient and its tinted drop shadow |

| Utility | Applied to |
| --- | --- |
| `depth-primary` | `Button` default variant, checked `Switch` track, highlighted menu and select items, send/stop |
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

- Text selection in `index.css` uses the theme's accent and paired foreground, falling back to the default primary pair.
- Derive every depth color from semantic tokens with `color-mix`. Never hardcode a hex in `depth.css`, or a theme switch will leave stale colors behind.
- `depth-primary` sets `box-shadow` directly, which replaces Tailwind's `ring-*` shadow. Its focus state uses an outline instead. Do the same in any new utility that owns `box-shadow`.
- `.depth-press` lives in `@layer components` so a `transition-*` utility passed by a caller still wins. Custom `@utility` blocks support variants (`md:depth-sidebar`, `data-active:depth-row-active`).
- The composer background is the card color at glass opacity + 30%, capped at 100%. The sidebar uses the sidebar color at glass opacity + 25%. Both still follow the Glass opacity setting.
- The light default accent (`#62691b`) is darker than the icon's lime because it must keep white text readable. The gradient brightens its top edge rather than changing the palette.
- Motion tokens stay in `src/web/motion/`. `chat-message-in` now adds a small scale and a 3 px blur to the rise.

## Disabled controls

Base UI switches expose `data-disabled` on the root rather than a native `disabled` attribute. The shared switch dims and desaturates that state. Select triggers support both native `disabled` (including disabled fieldsets) and `data-disabled`; pass `disabled` to the shared `Select` to disable its root and popup interactions together. Prerequisite-dependent settings also mute their labels and explain the prerequisite in text associated with the control. Native artifact-card buttons dim while unavailable.

Highlighted select items use `text-primary-foreground` for both the main label and nested muted text, such as a model provider. Muted text must not keep the normal surface color over the accent gradient.

Sidebar navigation shortcuts, including New chat, use the same quiet hover/selected row surface (`bg-sidebar-row-hover`), without accent elevation. Accent controls remain reserved for actions within the page.

The chat list uses an alpha gradient mask at its top edge beneath the project switcher. Scrolling increases the fade from 0 to 24 px, revealing the actual sidebar surface in every theme and glass setting; returning to the top removes it. The scroll handler updates a CSS variable directly to avoid React renders while scrolling.

Glass material is owned by `theme/glass.css`, using semantic palette tokens and
family opacity minimums. Depth utilities continue to own shadows and geometry;
do not layer independent upstream shadows or raw backdrop blur on these hosts.
`data-glass-surface` identifies sidebar/composer/overlay/card/toolbar/control
material, while `data-glass-renderer` describes leased refraction versus fallback.
Opaque reading content and state-color alpha fills are intentionally separate.
