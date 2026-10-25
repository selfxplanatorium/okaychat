# Markdown code blocks

Chat Markdown (`markdown-text.tsx`) and standalone Markdown (public shares,
artifact previews, and delegate reports) use `components/ui/code-block.tsx`.
The assistant-ui integration replaces `SyntaxHighlighter` and suppresses its
separate `CodeHeader`, so the toolbar and code have one containing block.

## Highlighting

We use [Highlight.js](https://highlightjs.org/) 11.12 and its common language
bundle, imported dynamically only when a labeled code block mounts. This adds
no dependencies of its own and keeps the grammar bundle (about 53 KB gzip) out
of the sign-in and initial chat load. Common languages and their registered
aliases, including JavaScript/JSX, TypeScript/TSX, Python, shell, JSON, SQL, HTML,
CSS, Go, and Rust, are covered. Unknown/unlabeled languages and blocks over
100,000 characters remain plain text; no auto-detection runs on streaming code.

The [highlight API](https://highlightjs.readthedocs.io/en/latest/api.html)
returns escaped HTML with token spans. Only that output goes through
`dangerouslySetInnerHTML`; the plain-text fallback uses React text children.
Token colors in `code-block.css` derive from semantic theme colors mixed toward
the foreground, supporting light, dark, and custom themes without a fixed
syntax palette. Copy always uses the original source, independent of markup
and visual wrapping.

The artifact panel's Code view reuses this through `useHighlightedCode()` and
the `aui-code-block` class, with its own wrap toggle in the panel header. Its
grammar comes from the artifact: `language` for code, TSX for React, Markdown,
JSON for XLSX sources, and XML for HTML, SVG, PDF, and DOCX sources.

## Wrapping and scrolling

`useAppearance().wordWrap` is already account-synced through `/api/appearance`,
defaults to true, and has a switch under Appearance → Typography → Word wrap.
Each block has a local nullable override. Untouched blocks follow changes to
the account default live; toggled blocks keep their choice until remounted.
A block's `data-wrap` rules override the global `html[data-word-wrap]` rules.
Long unbroken tokens wrap when enabled; disabling wrap scrolls only the pre.

The toolbar is `position: sticky; top: 0` inside the block, so it remains
accessible until the block's bottom passes. Do not add overflow clipping or a
scroll container to the outer block: it would trap the sticky toolbar. The
opaque muted background keeps scrolling code from showing through it. A 1 px
sentinel observed against the nearest scrollport squares the top corners while
pinned, preventing code from peeking through the rounded corners; rounding
returns at the original top.

The shared clipboard hook uses Clipboard API on secure origins and a temporary
textarea/`execCommand("copy")` fallback for self-hosted plain HTTP. The fallback
restores focus and selection without scrolling.

## Verification

When changing the renderer, check narrow and desktop layouts: token colors, source preservation,
unknown-language escaping, wrap overrides, contained horizontal overflow, sticky toolbars, and
full-source Copy on the plain-HTTP tailnet origin. Run `npm run typecheck`, `npm test`, and `npm run build`.

## Math and Mermaid

Both Markdown renderers (`markdown-text.tsx`, `simple-markdown.tsx`) use
`remark-math` without `rehype-katex`. remark-math then emits
`code.language-math.math-inline` and `pre > code.language-math.math-display`,
which our components route to `components/ui/math.tsx`. That keeps KaTeX
(about 79 KB gzip plus fonts) in its own chunk, loaded on the first equation.
KaTeX runs with `trust` off and `throwOnError: false`, so `\href` and similar
commands cannot create links and bad TeX renders as a red error, not a crash.

`lib/markdown-math.ts` preprocesses text before parsing: assistant-ui's
`normalizeMathDelimiters` (`\(...\)`, `\[...\]`), then a line that is only
`$$...$$` becomes a fenced display block (remark-math renders it inline
otherwise), then `escapeCurrencyDollars` so `$5 and $10` stays prose.

Fenced blocks tagged `mermaid` render through `components/ui/mermaid-diagram.tsx`.
Mermaid 12 (and d3/elk) is a lazy chunk. Renders are debounced 250 ms and
queued, because mermaid's config is global. `securityLevel: "strict"` is in
mermaid's default `secure` list, so `%%{init}%%` directives cannot loosen it.
Invalid or still-streaming source shows the normal code block; once a diagram
renders, later invalid edits keep the last good SVG. The theme uses mermaid's
`base` theme with our tokens resolved to sRGB hex through a canvas, because
mermaid's color parser rejects `oklch()` and `color-mix()`. A MutationObserver
on `<html>` re-renders on theme switches. `katex` is pinned to the 0.18 line
so it dedupes with mermaid's copy.

Server exports (`export.ts`) do not render math or diagrams yet.
