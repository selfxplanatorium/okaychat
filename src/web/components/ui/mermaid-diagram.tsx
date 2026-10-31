import { memo, useEffect, useState } from "react";
import { CodeIcon, NetworkIcon } from "lucide-react";
import type { Mermaid } from "mermaid";
import { CopyFeedbackIcon } from "@/components/assistant-ui/elements/surfaces";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { t } from "@/i18n";
import { CodeBlock } from "./code-block";

// Mermaid and its renderers (d3, dagre, ...) load only when a diagram mounts.
let mermaidPromise: Promise<Mermaid> | undefined;
const loadMermaid = () => mermaidPromise ??= import("mermaid").then((m) => m.default);

// Mermaid's config is global and concurrent renders share its temporary DOM, so renders run one at a time.
let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;

// Mermaid parses colors itself and rejects oklch/color-mix, so tokens are resolved to sRGB through a canvas.
function themeVariables() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.append(probe);
  const resolve = (token: string) => {
    probe.style.color = `var(${token})`;
    const color = getComputedStyle(probe).color;
    if (!ctx) return color;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  };
  const vars = {
    darkMode: document.documentElement.classList.contains("dark"),
    background: resolve("--background"),
    primaryColor: resolve("--muted"),
    primaryTextColor: resolve("--foreground"),
    primaryBorderColor: resolve("--border"),
    secondaryColor: resolve("--accent"),
    tertiaryColor: resolve("--background"),
    lineColor: resolve("--muted-foreground"),
    textColor: resolve("--foreground"),
    fontFamily: getComputedStyle(document.body).fontFamily,
  };
  probe.remove();
  return vars;
}

// Theme switches rewrite the class and inline tokens on <html>; diagrams re-render when the colors change.
function useThemeKey() {
  const read = () => `${document.documentElement.className}|${document.documentElement.getAttribute("style") ?? ""}`;
  const [key, setKey] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setKey(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme-id"] });
    return () => observer.disconnect();
  }, []);
  return key;
}

/**
 * Markup that makes mermaid load something while it renders: HTML label images, image shapes, and CSS
 * URLs. Strict mode still allows label images, and the request starts inside mermaid.render, so such a
 * diagram is shown as code instead; remote images need the explicit Load action (prompt-injection.md).
 */
const NETWORK_MARKUP = /<\s*(img|image|video|audio|source|iframe|object|embed|link)\b|\b(src|srcset|href|xlink:href)\s*=|url\s*\(|@import|\bimg\s*:/i;

async function renderDiagram(source: string): Promise<string | null> {
  if (NETWORK_MARKUP.test(source)) return null;
  const mermaid = await loadMermaid();
  const run = queue.then(async () => {
    // securityLevel is in mermaid's default `secure` list, so %%{init}%% directives cannot loosen it.
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "base", themeVariables: themeVariables() });
    if (!(await mermaid.parse(source, { suppressErrors: true }))) return null;
    const { svg } = await mermaid.render(`okaychat-mermaid-${nextId++}`, source);
    return svg;
  });
  queue = run.catch(() => undefined);
  return run;
}

export const MermaidDiagram = memo(function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const themeKey = useThemeKey();

  useEffect(() => {
    let active = true;
    // Debounced so a streaming block renders once it pauses, not on every token.
    const timer = setTimeout(() => {
      renderDiagram(code).then((next) => {
        // Keep the last good diagram while a streaming edit is temporarily invalid.
        if (active && next !== null) setSvg(next);
      }).catch(() => { /* Invalid or unrenderable diagrams fall back to the source. */ });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [code, themeKey]);

  const toggle = svg !== null && (
    <TooltipIconButton
      tooltip={showCode ? t("ui.showDiagram") : t("ui.showCode")}
      aria-label={showCode ? t("ui.showDiagram") : t("ui.showCode")}
      onClick={() => setShowCode(!showCode)}
    >
      {showCode ? <NetworkIcon aria-hidden /> : <CodeIcon aria-hidden />}
    </TooltipIconButton>
  );

  if (svg === null || showCode) return <CodeBlock code={code} language="mermaid" actions={toggle} />;

  return (
    <div className="aui-mermaid my-3 min-w-0">
      <div className="aui-code-header-root border-border/50 bg-muted flex items-center justify-between gap-3 rounded-t-xl border px-3.5 py-1.5 text-xs">
        <span className="text-muted-foreground truncate font-medium lowercase">mermaid</span>
        <div className="flex shrink-0 items-center gap-1">
          {toggle}
          <TooltipIconButton tooltip={t("ui.copyCode")} onClick={() => { if (!isCopied) void copyToClipboard(code); }}>
            <CopyFeedbackIcon copied={isCopied} />
          </TooltipIconButton>
        </div>
      </div>
      <div
        className="border-border/50 bg-background flex justify-center overflow-x-auto rounded-b-xl border border-t-0 p-4 [&_svg]:h-auto [&_svg]:max-w-full"
        // Mermaid's strict mode sanitizes labels with DOMPurify and drops scripts and click handlers.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
});
