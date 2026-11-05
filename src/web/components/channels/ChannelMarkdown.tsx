import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Channel-safe Markdown. Images never render, including app-owned endpoints, data URLs, and blob URLs
 * produced by AI output. Links are limited to http, https, and mailto; every external link is inert to
 * the app's own assets and opens with noopener. Raw HTML was never enabled.
 */

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

function SafeLink(props: ComponentProps<"a">) {
  const { href, children, ...rest } = props;
  if (!href || !SAFE_LINK.test(href)) return <span className="text-muted-foreground">{children}</span>;
  const external = /^https?:/i.test(href);
  return (
    <a
      href={href}
      {...rest}
      {...(external ? { target: "_blank", rel: "noopener noreferrer", referrerPolicy: "no-referrer" as const } : {})}
    >
      {children}
    </a>
  );
}

const flat = "text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:rounded [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em] [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-semibold [&_hr]:my-3 [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_pre]:bg-muted/60 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-2 [&_table]:w-full [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5";

export function ChannelMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn(flat, className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: () => null,
          a: SafeLink,
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
