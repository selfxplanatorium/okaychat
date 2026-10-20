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

Checked both narrow (390 px) and desktop browser layouts: highlighted token
colors, source text preservation, unknown-language HTML escaping, wrap on/off,
local override versus changed default, horizontal overflow contained to pre,
sticky header mid-block and constrained at the bottom, and full-source Copy
on the plain-HTTP tailnet origin. `npm run typecheck`, `npm test` (78 tests), and
`npm run build` pass.
