"use client";

import "@assistant-ui/react-markdown/styles/dot.css";

import {
  MarkdownTextPrimitive,
  type MarkdownTextPrimitiveProps,
  memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  type ComponentProps,
  type FC,
  memo,
  useMemo,
  useRef,
  useState,
} from "react";
import { ImageOffIcon } from "lucide-react";
import type { TextMessagePartProps } from "@assistant-ui/react";

import { CodeBlock } from "@/components/ui/code-block";
import { InlineMath, MathBlock } from "@/components/ui/math";
import { MermaidDiagram } from "@/components/ui/mermaid-diagram";
import { keepLineBreaks, preprocessMarkdown } from "@/lib/markdown-math";
import { cn } from "@/lib/utils";
import { safeHref } from "../utils/href";
import { MarkdownTable } from "./markdown-table";

type MarkdownTextProps = Partial<TextMessagePartProps> & {
  components?: Parameters<typeof memoizeMarkdownComponents>[0];
  componentsByLanguage?: MarkdownTextPrimitiveProps["componentsByLanguage"];
  /** Render single newlines as line breaks, as typed text expects. */
  lineBreaks?: boolean;
};

const useShallowStable = <T extends Record<string, unknown> | undefined>(
  value: T,
): T => {
  const ref = useRef(value);
  if (value !== ref.current) {
    const prev = ref.current;
    const stable =
      value !== undefined &&
      prev !== undefined &&
      Object.keys(prev).length === Object.keys(value).length &&
      Object.keys(value).every((key) => prev[key] === value[key]);
    if (!stable) ref.current = value;
  }
  return ref.current;
};

const remarkPlugins = [remarkGfm, remarkMath];

const preprocessTyped = (text: string) => keepLineBreaks(preprocessMarkdown(text));

const defaultComponentsByLanguage: NonNullable<
  MarkdownTextPrimitiveProps["componentsByLanguage"]
> = {
  math: { SyntaxHighlighter: ({ code }) => <MathBlock tex={code.trim()} /> },
  mermaid: { SyntaxHighlighter: ({ code }) => <MermaidDiagram code={code} /> },
};

const MarkdownTextImpl: FC<MarkdownTextProps> = ({
  components,
  componentsByLanguage,
  lineBreaks,
}) => {
  const stableComponents = useShallowStable(components);
  const stableComponentsByLanguage = useShallowStable(componentsByLanguage);
  const markdownComponents = useMemo(() => {
    if (!stableComponents) return defaultComponents;
    return {
      ...defaultComponents,
      ...memoizeMarkdownComponents(stableComponents),
    };
  }, [stableComponents]);
  const markdownComponentsByLanguage = useMemo(
    () => ({ ...defaultComponentsByLanguage, ...stableComponentsByLanguage }),
    [stableComponentsByLanguage],
  );

  return (
    <MarkdownTextPrimitive
      remarkPlugins={remarkPlugins}
      preprocess={lineBreaks ? preprocessTyped : preprocessMarkdown}
      className="aui-md"
      components={markdownComponents}
      componentsByLanguage={markdownComponentsByLanguage}
      defer
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

// A model-written image URL often 404s or is blocked. The browser's broken
// icon and wrapped alt text read as a layout bug, so a failed load becomes a
// compact chip. The error is keyed to its src so a new URL retries the image.
const MarkdownImage: FC<ComponentProps<"img">> = ({
  className,
  src,
  alt,
  onError,
  ...props
}) => {
  const [errorSrc, setErrorSrc] = useState<string | null>(null);
  const failed = errorSrc !== null && errorSrc === (src ?? "");

  if (!failed) {
    return (
      <img
        src={src}
        alt={alt}
        className={className}
        onError={(e) => {
          setErrorSrc(src ?? "");
          onError?.(e);
        }}
        {...props}
      />
    );
  }

  const label = alt?.trim() || "Image unavailable";
  const href = safeHref(src);
  const isWebUrl = href !== undefined && /^https?:\/\//i.test(href);

  return (
    <span
      data-slot="markdown-image-fallback"
      className="bg-muted/50 border-border text-muted-foreground inline-flex max-w-full items-center gap-2 rounded-lg border px-3 py-2 align-middle text-sm"
    >
      <ImageOffIcon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      {isWebUrl && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-foreground shrink-0 underline-offset-4 hover:underline"
        >
          Open link
        </a>
      )}
    </span>
  );
};

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => (
    <h1
      className={cn(
        "aui-md-h1 mt-5 mb-2 scroll-m-20 text-xl font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn(
        "aui-md-h2 mt-5 mb-2 scroll-m-20 text-lg font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn(
        "aui-md-h3 mt-4 mb-1.5 scroll-m-20 text-base font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4
      className={cn(
        "aui-md-h4 mt-3.5 mb-1 scroll-m-20 text-base font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }) => (
    <h5
      className={cn(
        "aui-md-h5 mt-3 mb-1 text-sm font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h6: ({ className, ...props }) => (
    <h6
      className={cn(
        "aui-md-h6 mt-3 mb-1 text-sm font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  p: ({ className, ...props }) => (
    <p
      className={cn(
        "aui-md-p my-3 leading-relaxed first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn(
        "aui-md-a text-primary hover:text-primary/80 underline underline-offset-2",
        className,
      )}
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "aui-md-blockquote border-muted-foreground/30 text-muted-foreground my-3 border-s-2 ps-4",
        className,
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn(
        "aui-md-ul marker:text-muted-foreground my-3 ms-5 list-disc [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn(
        "aui-md-ol marker:text-muted-foreground my-3 ms-5 list-decimal [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr
      className={cn("aui-md-hr border-muted-foreground/20 my-3", className)}
      {...props}
    />
  ),
  table: MarkdownTable,
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "aui-md-th bg-muted text-muted-foreground border-border/60 border-b px-3 py-2 text-start font-medium whitespace-nowrap [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "aui-md-td border-border/60 border-b px-3 py-2 text-start [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr
      className={cn("aui-md-tr [&:last-child>td]:border-b-0", className)}
      {...props}
    />
  ),
  li: ({ className, ...props }) => (
    <li className={cn("aui-md-li leading-relaxed", className)} {...props} />
  ),
  strong: ({ className, ...props }) => (
    <strong
      className={cn("aui-md-strong font-semibold", className)}
      {...props}
    />
  ),
  sup: ({ className, ...props }) => (
    <sup
      className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)}
      {...props}
    />
  ),
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "aui-md-pre border-border/50 bg-muted/30 overflow-x-auto rounded-t-none rounded-b-xl border border-t-0 p-3.5 text-[13px] leading-relaxed",
        className,
      )}
      {...props}
    />
  ),
  img: MarkdownImage,
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    if (
      !isCodeBlock &&
      className?.includes("math-inline") &&
      typeof props.children === "string"
    ) {
      return <InlineMath tex={props.children} />;
    }
    return (
      <code
        className={cn(
          !isCodeBlock &&
            "aui-md-inline-code bg-muted rounded-md px-1.5 py-0.5 font-mono text-[0.85em]",
          className,
        )}
        {...props}
      />
    );
  },
  CodeHeader: () => null,
  SyntaxHighlighter: CodeBlock,
});
