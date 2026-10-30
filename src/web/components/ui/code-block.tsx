import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { WrapTextIcon } from "lucide-react";
import type { HLJSApi } from "highlight.js";
import { CopyFeedbackIcon } from "@/components/assistant-ui/elements/surfaces";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { t } from "@/i18n";
import { useAppearance } from "@/state/appearance";
import "./code-block.css";

// Load grammars only when a code block needs them, outside the sign-in bundle.
let highlighterPromise: Promise<HLJSApi> | undefined;
const loadHighlighter = () => highlighterPromise ??= import("highlight.js/lib/common").then((m) => m.default);

/** Highlighted HTML for `code`, or null while loading and for unknown languages or very large input. */
export function useHighlightedCode(code: string, language: string): string | null {
  const [highlighter, setHighlighter] = useState<HLJSApi | null>(null);
  const grammar = language.toLowerCase();

  useEffect(() => {
    if (!grammar) return;
    let active = true;
    void loadHighlighter().then((loaded) => {
      if (active) setHighlighter(loaded);
    }).catch(() => { /* A failed chunk load leaves readable plain text. */ });
    return () => { active = false; };
  }, [grammar]);

  return useMemo(() => {
    // Bound work during streaming; unknown languages and very large blocks stay readable.
    if (!highlighter?.getLanguage(grammar) || code.length > 100_000) return null;
    try {
      return highlighter.highlight(code, { language: grammar, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [code, grammar, highlighter]);
}

// The toolbar squares its corners while stuck, which needs each block's sentinel observed against the nearest
// scrollport (chat, preview panel, or the page). Finding it reads computed styles up the tree; done per block
// inside React's effects, other effects' DOM writes in between made each read restyle the whole page. Blocks
// register here instead, one frame resolves them together, and each scrollport gets one shared observer.
const stuckListeners = new WeakMap<Element, (stuck: boolean) => void>();
const sentinelRoots = new Map<Element, Element | null>();
const rootObservers = new Map<Element | null, { observer: IntersectionObserver; count: number }>();
const pendingSentinels = new Set<Element>();
let resolveFrame = 0;

function scrollportOf(sentinel: Element, cache: Map<Element, Element | null>): Element | null {
  const path: Element[] = [];
  let node = sentinel.parentElement?.parentElement ?? null;
  let root: Element | null = null;
  while (node) {
    const known = cache.get(node);
    if (known !== undefined) {
      root = known;
      break;
    }
    path.push(node);
    if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) {
      root = node;
      break;
    }
    node = node.parentElement;
  }
  for (const visited of path) cache.set(visited, root);
  return root;
}

function resolvePending() {
  resolveFrame = 0;
  const cache = new Map<Element, Element | null>();
  for (const sentinel of pendingSentinels) {
    const root = scrollportOf(sentinel, cache);
    let entry = rootObservers.get(root);
    if (!entry) {
      const observer = new IntersectionObserver((entries) => {
        for (const e of entries) stuckListeners.get(e.target)?.(!e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0));
      }, { root, threshold: [0, 1] });
      rootObservers.set(root, (entry = { observer, count: 0 }));
    }
    entry.count += 1;
    entry.observer.observe(sentinel);
    sentinelRoots.set(sentinel, root);
  }
  pendingSentinels.clear();
}

function watchStuck(sentinel: Element, listener: (stuck: boolean) => void): () => void {
  stuckListeners.set(sentinel, listener);
  pendingSentinels.add(sentinel);
  resolveFrame ||= requestAnimationFrame(resolvePending);
  return () => {
    stuckListeners.delete(sentinel);
    if (pendingSentinels.delete(sentinel)) return;
    if (!sentinelRoots.has(sentinel)) return;
    const root = sentinelRoots.get(sentinel)!;
    sentinelRoots.delete(sentinel);
    const entry = rootObservers.get(root);
    if (!entry) return;
    entry.observer.unobserve(sentinel);
    entry.count -= 1;
    if (entry.count === 0) {
      entry.observer.disconnect();
      rootObservers.delete(root);
    }
  };
}

export const CodeBlock = memo(function CodeBlock({ code, language = "", actions }: { code: string; language?: string; actions?: ReactNode }) {
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const [stuck, setStuck] = useState(false);
  const defaultWrap = useAppearance((s) => s.wordWrap);
  const [wrapOverride, setWrapOverride] = useState<boolean | null>(null);
  const wrap = wrapOverride ?? defaultWrap;
  const html = useHighlightedCode(code, language);
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  useEffect(() => {
    const sentinel = sentinelRef.current;
    return sentinel ? watchStuck(sentinel, setStuck) : undefined;
  }, []);

  return (
    <div className="aui-code-block relative my-3 min-w-0" data-wrap={wrap} data-stuck={stuck}>
      <span ref={sentinelRef} aria-hidden className="pointer-events-none absolute top-0 left-0 size-px" />
      <div className="aui-code-header-root border-border/50 bg-muted sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-xl border px-3.5 py-1.5 text-xs">
        <span className="aui-code-header-language text-muted-foreground truncate font-medium lowercase">{language || "text"}</span>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          <TooltipIconButton
            tooltip={wrap ? t("ui.disableWrap") : t("ui.enableWrap")}
            aria-label={t("ui.wrapCode")}
            aria-pressed={wrap}
            className="aria-pressed:bg-accent aria-pressed:text-accent-foreground"
            onClick={() => setWrapOverride(!wrap)}
          >
            <WrapTextIcon aria-hidden />
          </TooltipIconButton>
          <TooltipIconButton tooltip={t("ui.copyCode")} data-command="code.copy" onClick={() => { if (code && !isCopied) void copyToClipboard(code); }}>
            <CopyFeedbackIcon copied={isCopied} />
          </TooltipIconButton>
        </div>
      </div>
      <pre className="aui-md-pre border-border/50 bg-muted/30 m-0 overflow-x-auto rounded-b-xl border border-t-0 p-3.5 text-[13px] leading-relaxed">
        {html === null ? <code>{code}</code> : (
          // highlight() escapes source text; only its generated token spans become markup.
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </pre>
    </div>
  );
});
