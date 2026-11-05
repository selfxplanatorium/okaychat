import Markdown from "react-markdown";
import { isValidElement } from "react";
import { CodeBlock } from "./code-block";
import { ProtectedMarkdownImage } from "./protected-markdown-image";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { preprocessMarkdown } from "@/lib/markdown-math";
import { InlineMath, MathBlock } from "./math";
import { MermaidDiagram } from "./mermaid-diagram";
import { cn } from "@/lib/utils";
import { isKnowledgeHref } from "@/lib/knowledge-citation";
import { markdownImageSource } from "@/lib/markdown-image-policy";

// Markdown outside a message part (artifact previews, sub-agent reports). Message text uses MarkdownText,
// which needs the assistant-ui part context.
const MARKDOWN_CLASSES =
  "text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:rounded [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em] [&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:font-semibold [&_hr]:my-4 [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_pre:not(.aui-md-pre)]:bg-muted/60 [&_pre:not(.aui-md-pre)]:my-3 [&_pre:not(.aui-md-pre)]:overflow-x-auto [&_pre:not(.aui-md-pre)]:rounded-lg [&_pre:not(.aui-md-pre)]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-3 [&_table]:w-full [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6";

const components = {
  pre: ({ children }: { children?: React.ReactNode }) => {
    if (!isValidElement<{ className?: string; children?: unknown }>(children) || typeof children.props.children !== "string") {
      return <pre>{children}</pre>;
    }
    const language = /language-([^\s]+)/.exec(children.props.className ?? "")?.[1] ?? "";
    if (language === "math") return <MathBlock tex={children.props.children.trim()} />;
    if (language === "mermaid") return <MermaidDiagram code={children.props.children} />;
    return <CodeBlock code={children.props.children} language={language} />;
  },
  code: ({ className, children, ...props }: React.ComponentProps<"code">) => {
    if (className?.includes("math-inline") && typeof children === "string") return <InlineMath tex={children} />;
    return <code className={className} {...props}>{children}</code>;
  },
  // Public shares, artifact previews, and memory imports use the same remote-image consent policy.
  img: ProtectedMarkdownImage,
  // Knowledge citations need the chat's private passage panel. Anywhere else (including a public share)
  // they stay inert text, and a malformed `oknowledge:` value never becomes a real link.
  a: ({ href, children, ...props }: React.ComponentProps<"a">) =>
    isKnowledgeHref(href) ? <span className="text-muted-foreground">{children}</span> : <a href={href} {...props}>{children}</a>,
};

const remarkPlugins = [remarkGfm, remarkMath];

/** Standalone notes deny app-owned image routes: a copied note never gains a new media grant. */
function InertAppImage({ src, alt }: React.ComponentProps<"img">) {
  const source = markdownImageSource(typeof src === "string" ? src : undefined);
  if (source.kind === "app") return <span className="text-muted-foreground">{alt?.trim() || "image"}</span>;
  return <ProtectedMarkdownImage src={src} alt={alt} />;
}

const noteComponents = { ...components, img: InertAppImage };

export function SimpleMarkdown({ children, className, imagePolicy = "all" }: { children: string; className?: string; imagePolicy?: "all" | "remote" }) {
  return (
    <div className={cn(MARKDOWN_CLASSES, className)}>
      <Markdown remarkPlugins={remarkPlugins} components={imagePolicy === "remote" ? noteComponents : components}>
        {preprocessMarkdown(children)}
      </Markdown>
    </div>
  );
}
