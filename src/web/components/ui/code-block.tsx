import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { WrapTextIcon } from "lucide-react";
import type { HLJSApi } from "highlight.js";
import { CopyFeedbackIcon } from "@/components/assistant-ui/elements/surfaces";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useAppearance } from "@/state/appearance";
import "./code-block.css";

// Load grammars only when a code block needs them, outside the sign-in bundle.
let highlighterPromise: Promise<HLJSApi> | undefined;
const loadHighlighter = () => highlighterPromise ??= import("highlight.js/lib/common").then((m) => m.default);

export const CodeBlock = memo(function CodeBlock({ code, language = "", actions }: { code: string; language?: string; actions?: ReactNode }) {
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const [stuck, setStuck] = useState(false);
  const defaultWrap = useAppearance((s) => s.wordWrap);
  const [wrapOverride, setWrapOverride] = useState<boolean | null>(null);
  const wrap = wrapOverride ?? defaultWrap;
  const [highlighter, setHighlighter] = useState<HLJSApi | null>(null);
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const grammar = language.toLowerCase();

  useEffect(() => {
    if (!grammar) return;
    let active = true;
    void loadHighlighter().then((loaded) => {
      if (active) setHighlighter(loaded);
    }).catch(() => { /* A failed chunk load leaves readable plain text. */ });
    return () => { active = false; };
  }, [grammar]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    // Observe against the actual scrollport (chat, preview panel, or the page).
    let root = sentinel.parentElement?.parentElement ?? null;
    while (root && !/(auto|scroll|overlay)/.test(getComputedStyle(root).overflowY)) {
      root = root.parentElement;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setStuck(!entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0));
    }, { root, threshold: [0, 1] });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const html = useMemo(() => {
    // Bound work during streaming; unknown languages and very large blocks stay readable.
    if (!highlighter?.getLanguage(grammar) || code.length > 100_000) return null;
    try {
      return highlighter.highlight(code, { language: grammar, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [code, grammar, highlighter]);

  return (
    <div className="aui-code-block relative my-3 min-w-0" data-wrap={wrap} data-stuck={stuck}>
      <span ref={sentinelRef} aria-hidden className="pointer-events-none absolute top-0 left-0 size-px" />
      <div className="aui-code-header-root border-border/50 bg-muted sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-xl border px-3.5 py-1.5 text-xs">
        <span className="aui-code-header-language text-muted-foreground truncate font-medium lowercase">{language || "text"}</span>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          <TooltipIconButton
            tooltip={wrap ? "Disable line wrapping" : "Enable line wrapping"}
            aria-label="Wrap code"
            aria-pressed={wrap}
            className="aria-pressed:bg-accent aria-pressed:text-accent-foreground"
            onClick={() => setWrapOverride(!wrap)}
          >
            <WrapTextIcon aria-hidden />
          </TooltipIconButton>
          <TooltipIconButton tooltip="Copy code" data-command="code.copy" onClick={() => { if (code && !isCopied) void copyToClipboard(code); }}>
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
