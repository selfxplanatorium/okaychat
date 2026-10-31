"use client";

import { ImageOffIcon, ImageIcon } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { safeHref } from "@/components/assistant-ui/utils/href";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { markdownImageSource, remoteImageHost } from "@/lib/markdown-image-policy";

/**
 * Markdown images from a model or external page. App-owned image routes load normally. Any remote URL
 * is shown as a placeholder until the reader chooses Load image, so an injected `![](https://…?data)`
 * cannot make the browser contact the attacker on its own. The choice is in-memory only: a reload asks
 * again.
 */
export function ProtectedMarkdownImage({ className, src: rawSrc, alt, onError, ...props }: ComponentProps<"img">) {
  const source = markdownImageSource(typeof rawSrc === "string" ? rawSrc : undefined);
  const [consented, setConsented] = useState(false);
  const [failed, setFailed] = useState(false);

  if ((source.kind === "remote" && !consented) || source.kind === "blocked") {
    const host = source.kind === "remote" ? remoteImageHost(source.url) : undefined;
    return (
      <span
        data-slot="markdown-image-consent"
        className="bg-muted/40 border-border text-muted-foreground my-1 inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border px-3 py-2 align-middle text-sm"
      >
        <ImageIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 basis-40">
          <span className="text-foreground block text-xs font-medium">
            {source.kind === "remote" ? t("thread.remoteImageTitle") : t("thread.remoteImageBlocked")}
          </span>
          <span className="block text-xs">
            {host ? t("thread.remoteImageBody", { host }) : alt?.trim() || t("thread.remoteImageUnavailable")}
          </span>
          {host && alt?.trim() ? <span className="block truncate text-xs">{alt}</span> : null}
        </span>
        {source.kind === "remote" ? (
          <>
            <button
              type="button"
              data-command="chat.loadImage"
              onClick={() => {
                setFailed(false);
                setConsented(true);
              }}
              className="border-border bg-background text-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-10 items-center rounded-md border px-3 text-xs font-medium transition-colors duration-(--motion-fast) ease-out-quart focus-visible:ring-2 focus-visible:outline-none"
            >
              {t("thread.loadImage")}
            </button>
            {safeHref(source.url) ? (
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-foreground inline-flex min-h-10 items-center underline-offset-4 hover:underline"
              >
                {t("thread.openLink")}
              </a>
            ) : null}
          </>
        ) : alt?.trim() ? (
          <span className="min-w-0 truncate text-xs">{alt}</span>
        ) : null}
      </span>
    );
  }

  if (failed) {
    const label = alt?.trim() || t("thread.imageUnavailable");
    const href = safeHref(source.url);
    return (
      <span
        data-slot="markdown-image-fallback"
        className="bg-muted/50 border-border text-muted-foreground inline-flex max-w-full items-center gap-2 rounded-lg border px-3 py-2 align-middle text-sm"
      >
        <ImageOffIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
        {href && /^https?:\/\//i.test(href) ? (
          <a href={href} target="_blank" rel="noreferrer noopener" className="text-foreground shrink-0 underline-offset-4 hover:underline">
            {t("thread.openLink")}
          </a>
        ) : null}
      </span>
    );
  }

  return (
    <img
      {...props}
      src={source.url}
      alt={alt}
      className={cn(className)}
      onError={(event) => {
        setFailed(true);
        onError?.(event);
      }}
    />
  );
}
