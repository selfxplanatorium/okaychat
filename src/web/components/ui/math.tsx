import { memo, useEffect, useMemo, useState } from "react";
import type katexApi from "katex";
import { cn } from "@/lib/utils";

type Katex = typeof katexApi;

// KaTeX and its fonts load only when a message contains math.
let katexPromise: Promise<Katex> | undefined;
const loadKatex = () =>
  katexPromise ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([m]) => m.default);

function useKatex() {
  const [katex, setKatex] = useState<Katex | null>(null);
  useEffect(() => {
    let active = true;
    void loadKatex().then((loaded) => {
      if (active) setKatex(loaded);
    }).catch(() => { /* A failed chunk load leaves the TeX source readable. */ });
    return () => { active = false; };
  }, []);
  return katex;
}

function renderTex(katex: Katex | null, tex: string, displayMode: boolean) {
  if (!katex) return null;
  try {
    // trust stays off: \href, \includegraphics and friends render as errors, not links or requests.
    return katex.renderToString(tex, { displayMode, throwOnError: false, strict: "ignore", output: "htmlAndMathml" });
  } catch {
    return null;
  }
}

export const InlineMath = memo(function InlineMath({ tex, className }: { tex: string; className?: string }) {
  const katex = useKatex();
  const html = useMemo(() => renderTex(katex, tex, false), [katex, tex]);
  if (html === null) return <code className={cn("aui-md-inline-code bg-muted rounded-md px-1.5 py-0.5 font-mono text-[0.85em]", className)}>{tex}</code>;
  // renderToString escapes the TeX source; only KaTeX's generated markup is injected.
  return <span className={cn("aui-math-inline", className)} dangerouslySetInnerHTML={{ __html: html }} />;
});

export const MathBlock = memo(function MathBlock({ tex }: { tex: string }) {
  const katex = useKatex();
  const html = useMemo(() => renderTex(katex, tex, true), [katex, tex]);
  if (html === null) {
    return <pre className="aui-math-display text-muted-foreground my-3 overflow-x-auto font-mono text-[13px] whitespace-pre-wrap">{tex}</pre>;
  }
  return <div className="aui-math-display my-3 overflow-x-auto overflow-y-hidden py-1" dangerouslySetInnerHTML={{ __html: html }} />;
});
