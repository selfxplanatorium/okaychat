# Bundled fonts

The settings picker offers a fixed set of fonts that ship with the app. Every device gets the same choices, and no request goes to Google.

| Family | Monospace | Source | License |
| --- | --- | --- | --- |
| Onest | no | `@fontsource-variable/onest`, default interface font (not in the picker list) | OFL 1.1 |
| Golos Text | no | `@fontsource-variable/golos-text`, optional interface font | OFL 1.1 |
| Liberation Sans, Serif, Mono | Mono only for Mono | `src/web/fonts/*.ttf`, `bundled.css` | OFL 1.1 (`src/web/fonts/LIBERATION-OFL.txt`) |
| DejaVu Sans, DejaVu Serif | no | `@fontsource/dejavu-*` (400 weight, latin subset) | Bitstream Vera / public domain changes |
| Ubuntu, Ubuntu Mono | Mono only for Ubuntu Mono | `@fontsource/ubuntu*` (400 weight) | Ubuntu Font Licence 1.0 |

Liberation is metric-compatible with Arial, Times New Roman, and Courier New, so layouts match the classic system faces.

## Where the list lives

- `src/web/theme/bundled-fonts.ts`: the picker list and the monospace flag.
- `src/web/fonts/bundled.css`: `@font-face` rules for Liberation. Vite emits the TTFs as hashed assets, loaded only when used. Every declaration uses `font-display: swap`, so a slow font file cannot hide text at startup.
- `src/web/main.tsx`: imports the Fontsource packages and the Liberation CSS.
- `src/web/theme/fonts.ts`: maps the picker labels Onest and Golos Text to Fontsource's actual CSS families (`Onest Variable` and `Golos Text Variable`). The default stack also lives in `theme.css`; keep both defaults aligned. An empty interface font preference uses Onest; explicit font choices stay unchanged.

## Liberation source

No npm package ships the TTFs as plain files. `@formepdf/fonts-standard@0.28.0` embeds the 12 Liberation TTFs as base64 in `dist/generated/font-data.js`. They were decoded from that file into `src/web/fonts/`. The version and the decode step are the only provenance, so keep both if the files are regenerated.

## Not included

DejaVu Sans Mono has no Fontsource package, so the mono list is Liberation Mono and Ubuntu Mono.
